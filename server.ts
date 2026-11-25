import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import type {
  AnalysisConfig,
  ClipRecord,
  ExportJob,
  ExportOptions,
  HookCandidate,
  ProjectRecord,
  SystemCapabilities,
} from './shared/types.ts';
import { store, MUSIC_DIR, PROJECTS_DIR } from './server/store.ts';
import { logBackendError, sanitizeErrorMessage } from './server/logger.ts';
import { ensureMusicFileByName, getMusicTracks } from './server/music.ts';
import { isGeminiConfigured } from './server/gemini.ts';
import {
  analyzeClipAudioAndGenerateCaptions,
  buildClipFromHookCandidate,
  buildFullVideoCaptionClip,
  createInitialPipelineStages,
  createRealSampleVideoProject,
  extractThumbnail,
  isPipelineRunning,
  probeVideoFile,
  refreshHookCandidateTranscriptFields,
  regenerateSingleClip,
  resyncProjectCaptionsWithAudio,
  runAnalysisPipeline,
} from './server/pipeline.ts';
import {
  buildClipDownloadFilename,
  generateAssSubtitles,
  generateSrtSubtitles,
  generateVttSubtitles,
  getClipSegments,
  renderChromaCaptionsMp4,
  renderClipWithFFmpeg,
  renderSoftSubtitledMp4,
  resolveClipMp4Path,
  streamProjectClipsZip,
} from './server/renderer.ts';

const execFileAsync = promisify(execFile);

const DOWNLOAD_SIGNING_SECRET =
  process.env.DOWNLOAD_SIGNING_SECRET || crypto.createHash('sha256').update(process.cwd() + ':clipgenius-mp4-sign').digest('hex');

function signDownloadToken(projectId: string, clipId: string, filename: string, expUnixSec: number): string {
  return crypto
    .createHmac('sha256', DOWNLOAD_SIGNING_SECRET)
    .update(`${projectId}:${clipId}:${filename}:${expUnixSec}`)
    .digest('hex');
}

function verifyDownloadToken(
  projectId: string,
  clipId: string,
  filename: string,
  token: string,
  expUnixSec: number
): boolean {
  if (!Number.isFinite(expUnixSec) || expUnixSec < Math.floor(Date.now() / 1000)) {
    return false;
  }
  const expected = signDownloadToken(projectId, clipId, filename, expUnixSec);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

const ALLOWED_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.mkv',
  '.webm',
  '.m4v',
  '.avi',
  '.flv',
  '.ts',
  '.3gp',
  '.wmv',
  '.mpeg',
  '.mpg',
  '.mts',
  '.m2ts',
  '.ogv',
  '.vob',
]);
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB proxy-safe chunks (supports unlimited file sizes & durations)

let cachedCaps: Omit<SystemCapabilities, 'geminiConfigured'> | null = null;

async function detectCapabilities(): Promise<SystemCapabilities> {
  if (!cachedCaps) {
    let ffmpegAvailable = false;
    let ffprobeAvailable = false;
    let h265Supported = false;
    try {
      const { stdout } = await execFileAsync('ffmpeg', ['-encoders']);
      ffmpegAvailable = true;
      h265Supported = stdout.includes('libx265');
    } catch {
      ffmpegAvailable = false;
    }
    try {
      await execFileAsync('ffprobe', ['-version']);
      ffprobeAvailable = true;
    } catch {
      ffprobeAvailable = false;
    }
    cachedCaps = {
      ffmpegAvailable,
      ffprobeAvailable,
      h265Supported,
      maxUploadDurationHours: 5,
    };
  }
  return {
    ...cachedCaps,
    geminiConfigured: isGeminiConfigured(),
  };
}

// Sequential export worker queue so FFmpeg doesn't thrash CPU during batch renders
const renderQueue: Array<{ projectId: string; clipId: string; jobId: string; options: ExportOptions }> = [];
let renderWorkerActive = false;

async function processRenderQueue(): Promise<void> {
  if (renderWorkerActive) return;
  renderWorkerActive = true;
  while (renderQueue.length > 0) {
    const item = renderQueue.shift()!;
    const project = store.getProject(item.projectId);
    const clip = project?.clips.find((c) => c.id === item.clipId);
    const job = store.getExportJob(item.jobId);
    if (!project || !clip || !job) continue;

    try {
      await renderClipWithFFmpeg({
        project,
        clip,
        options: item.options,
        existingJob: job,
      });
    } catch (err) {
      const safeErr = logBackendError({
        projectId: item.projectId,
        jobId: item.jobId,
        stage: 'ffmpeg_render',
        httpStatus: 500,
        route: 'worker:processRenderQueue',
        error: err,
      });
      job.status = 'failed';
      job.error = safeErr;
      store.upsertExportJob(job);
    }
  }
  renderWorkerActive = false;
}

async function createServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Prevent stale cached API payloads on browser reloads and polling
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // Serve project videos, thumbnails, renders, and on-demand synthesized royalty-free music
  app.use('/media/projects', express.static(PROJECTS_DIR));
  app.get('/media/music/:filename', async (req, res, next) => {
    const filePath = await ensureMusicFileByName(req.params.filename);
    if (!filePath) return next();
    res.sendFile(filePath);
  });
  app.use('/media/music', express.static(MUSIC_DIR));

  // Lightweight JSON health endpoint used by uploader to confirm server readiness
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // System capabilities & storage info
  app.get('/api/system/capabilities', async (_req, res) => {
    try {
      const capabilities = await detectCapabilities();
      const storage = store.getStorageUsageBytes();
      res.json({ capabilities, storage });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to inspect system capabilities' });
    }
  });

  // Settings
  app.get('/api/settings', (_req, res) => {
    res.json(store.getSettings());
  });

  app.patch('/api/settings', (req, res) => {
    const updated = store.updateSettings(req.body ?? {});
    res.json(updated);
  });

  // Royalty-free music library (instant metadata response; audio files synthesize lazily on play/render)
  app.get('/api/music', (_req, res) => {
    res.json(getMusicTracks());
  });

  // Projects list & detail
  app.get('/api/projects', (_req, res) => {
    res.json(store.getProjects());
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ ...project, isRunning: isPipelineRunning(project.id) });
  });

  // Real-time Server-Sent Events stream for project processing & export status
  app.get('/api/projects/:id/events', (req, res) => {
    const projectId = req.params.id;
    const initial = store.getProject(projectId);
    if (!initial) return res.status(404).json({ error: 'Project not found' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let lastPayload = '';
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      clearInterval(heartbeat);
    };

    const safeWrite = (chunk: string) => {
      if (closed || res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      try {
        res.write(chunk);
      } catch {
        cleanup();
      }
    };

    const sendSnapshot = () => {
      if (closed || res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      const current = store.getProject(projectId);
      if (!current) {
        safeWrite(`event: deleted\ndata: ${JSON.stringify({ projectId })}\n\n`);
        cleanup();
        try {
          if (!res.writableEnded) res.end();
        } catch {
          // ignore close errors
        }
        return;
      }
      const snapshot = JSON.stringify({
        project: { ...current, isRunning: isPipelineRunning(projectId) },
        exports: store.getExportJobs(projectId),
      });
      if (snapshot !== lastPayload) {
        lastPayload = snapshot;
        safeWrite(`event: update\ndata: ${snapshot}\n\n`);
      }
    };

    const interval = setInterval(sendSnapshot, 1200);
    const heartbeat = setInterval(() => {
      safeWrite(': heartbeat\n\n');
    }, 15000);

    sendSnapshot();

    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  app.delete('/api/projects/:id', (req, res) => {
    const ok = store.deleteProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Project not found' });
    res.json({ deleted: true });
  });

  // Resumable Upload — Step 1: Initialize
  app.post('/api/uploads/init', (req, res) => {
    const { filename, fileSize, mimeType, totalChunks, analysisConfig } = req.body as {
      filename?: string;
      fileSize?: number;
      mimeType?: string;
      totalChunks?: number;
      analysisConfig?: Partial<AnalysisConfig>;
    };

    if (!filename || typeof fileSize !== 'number' || fileSize <= 0) {
      return res.status(400).json({ error: 'Invalid upload metadata: filename and positive fileSize are required.' });
    }

    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return res.status(400).json({
        error: `Unsupported video format "${ext || 'unknown'}". Supported formats: MP4, MOV, MKV, WebM, M4V, AVI, 3GP, WMV, MPEG.`,
      });
    }

    const settings = store.getSettings();
    const projectId = uuidv4();
    const uploadId = uuidv4();
    const projectDir = store.getProjectDir(projectId);
    fs.mkdirSync(path.join(projectDir, 'chunks'), { recursive: true });

    const computedChunks = totalChunks && totalChunks > 0 ? totalChunks : Math.ceil(fileSize / CHUNK_SIZE_BYTES);
    const now = new Date().toISOString();

    const project: ProjectRecord = {
      id: projectId,
      uploadId,
      name: path.basename(filename, ext),
      originalFilename: filename,
      mimeType: mimeType || 'video/mp4',
      status: 'uploading',
      uploadProgress: 0,
      uploadedChunks: [],
      totalChunks: computedChunks,
      fileSize,
      analysisConfig: {
        mode: analysisConfig?.mode === 'captions_only' ? 'captions_only' : 'auto_clips',
        targetClipDuration: analysisConfig?.targetClipDuration ?? settings.defaultClipDuration,
        clipCount: analysisConfig?.clipCount ?? settings.defaultClipCount,
        language: analysisConfig?.language ?? settings.defaultLanguage,
        aspectRatio:
          analysisConfig?.mode === 'captions_only'
            ? 'original'
            : (analysisConfig?.aspectRatio ?? settings.defaultAspectRatio),
        framingMode: analysisConfig?.framingMode ?? settings.defaultFramingMode,
        captionPresetId: analysisConfig?.captionPresetId ?? settings.defaultCaptionPresetId,
        stylePresetId: analysisConfig?.stylePresetId ?? settings.defaultStylePresetId,
        motionIntensity: analysisConfig?.motionIntensity ?? settings.defaultMotionIntensity,
      },
      pipelineStages: createInitialPipelineStages(),
      completedAudioChunks: 0,
      totalAudioChunks: 0,
      completedTranscriptChunks: 0,
      transcript: [],
      silences: [],
      scenes: [],
      clips: [],
      createdAt: now,
      updatedAt: now,
    };

    store.upsertProject(project);
    res.json({ uploadId, projectId, chunkSize: CHUNK_SIZE_BYTES, project });
  });

  // Resumable Upload — Status & Disk Chunk Verification (enables exact resumption after interruption)
  app.get('/api/uploads/:projectId/status', (req, res) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Upload session not found.' });

    const chunkDir = path.join(store.getProjectDir(project.id), 'chunks');
    const verifiedOnDisk: number[] = [];
    const missingChunks: number[] = [];

    if (project.status === 'uploaded' || project.status === 'analyzing' || project.status === 'ready') {
      for (let i = 0; i < project.totalChunks; i++) verifiedOnDisk.push(i);
    } else {
      for (let i = 0; i < project.totalChunks; i++) {
        const partPath = path.join(chunkDir, `part_${String(i).padStart(6, '0')}`);
        try {
          if (fs.existsSync(partPath) && fs.statSync(partPath).size > 0) {
            verifiedOnDisk.push(i);
          } else {
            missingChunks.push(i);
          }
        } catch {
          missingChunks.push(i);
        }
      }
      project.uploadedChunks = verifiedOnDisk;
      project.uploadProgress = Math.min(
        99,
        Math.round((verifiedOnDisk.length / Math.max(1, project.totalChunks)) * 100)
      );
      store.upsertProject(project);
    }

    res.json({
      uploadId: project.uploadId ?? project.id,
      projectId: project.id,
      status: project.status,
      fileSize: project.fileSize,
      totalChunks: project.totalChunks,
      uploadedChunks: verifiedOnDisk,
      missingChunks,
      uploadProgress: project.uploadProgress,
    });
  });

  // Resumable Upload — Step 2: Receive binary chunk (supports both POST and PUT for universal proxy compatibility)
  const rawChunkParser = express.raw({ type: '*/*', limit: '20mb' });
  const handleUploadChunk: express.RequestHandler = async (req, res) => {
    const projectId = req.params.projectId;
    let uploadId: string | undefined;
    try {
      const project = store.getProject(projectId);
      if (!project) return res.status(404).json({ error: 'Upload session not found.' });
      uploadId = project.uploadId;

      const chunkIndex = Number(req.params.index);
      if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= project.totalChunks) {
        return res.status(400).json({ error: 'Invalid chunk index.' });
      }

      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return res.status(400).json({ error: 'Empty chunk payload received.' });
      }

      const chunkDir = path.join(store.getProjectDir(project.id), 'chunks');
      await fs.promises.mkdir(chunkDir, { recursive: true });
      const chunkPath = path.join(chunkDir, `part_${String(chunkIndex).padStart(6, '0')}`);
      const tempChunkPath = `${chunkPath}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tempChunkPath, body);
      await fs.promises.rename(tempChunkPath, chunkPath);

      if (!project.uploadedChunks.includes(chunkIndex)) {
        project.uploadedChunks.push(chunkIndex);
        project.uploadedChunks.sort((a, b) => a - b);
      }
      project.uploadProgress = Math.min(
        99,
        Math.round((project.uploadedChunks.length / project.totalChunks) * 100)
      );
      // Persist DB checkpoint on first chunk, every 8 chunks, and last chunk to avoid disk thrashing
      if (
        chunkIndex === 0 ||
        project.uploadedChunks.length % 8 === 0 ||
        project.uploadedChunks.length === project.totalChunks
      ) {
        store.upsertProject(project);
      }

      res.json({
        uploadId: project.uploadId ?? project.id,
        received: chunkIndex,
        bytesReceived: body.length,
        uploadedCount: project.uploadedChunks.length,
        totalChunks: project.totalChunks,
        uploadProgress: project.uploadProgress,
      });
    } catch (err) {
      const safeErr = logBackendError({
        projectId,
        uploadId,
        stage: `upload_chunk_${req.params.index}`,
        httpStatus: 500,
        route: `${req.method} /api/uploads/:projectId/chunk/:index`,
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  };
  app.post('/api/uploads/:projectId/chunk/:index', rawChunkParser, handleUploadChunk);
  app.put('/api/uploads/:projectId/chunk/:index', rawChunkParser, handleUploadChunk);

  // Resumable Upload — Step 3: Verify all chunks, stream-assemble, validate byte size & FFprobe, optional auto-analyze handoff
  app.post('/api/uploads/:projectId/complete', async (req, res) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Upload session not found.' });
    const autoAnalyze = Boolean((req.body as { autoAnalyze?: boolean } | undefined)?.autoAnalyze);

    // Idempotency guard: if a previous /complete succeeded and client retried after a network blip, return cleanly
    if (
      (project.status === 'uploaded' || project.status === 'analyzing' || project.status === 'ready') &&
      project.sourcePath &&
      fs.existsSync(project.sourcePath)
    ) {
      if (autoAnalyze && project.status === 'uploaded' && isGeminiConfigured() && !isPipelineRunning(project.id)) {
        void runAnalysisPipeline(project.id);
      }
      return res.json(store.getProject(project.id) ?? project);
    }

    try {
      const projectDir = store.getProjectDir(project.id);
      const chunkDir = path.join(projectDir, 'chunks');
      const ext = path.extname(project.originalFilename).toLowerCase() || '.mp4';
      const targetFilename = `source${ext}`;
      const targetPath = path.join(projectDir, targetFilename);

      const alreadyAssembled = fs.existsSync(targetPath) && fs.statSync(targetPath).size === project.fileSize;

      if (!alreadyAssembled) {
        // Verify ALL chunks exist and are non-empty on persistent disk before assembling
        const missingChunks: number[] = [];
        for (let i = 0; i < project.totalChunks; i++) {
          const partPath = path.join(chunkDir, `part_${String(i).padStart(6, '0')}`);
          if (!fs.existsSync(partPath) || fs.statSync(partPath).size === 0) {
            missingChunks.push(i);
          }
        }
        if (missingChunks.length > 0) {
          return res.status(400).json({
            error: `Missing ${missingChunks.length} upload chunk${missingChunks.length === 1 ? '' : 's'} (first missing: chunk ${missingChunks[0] + 1} of ${project.totalChunks}). Please resume upload.`,
            missingChunk: missingChunks[0],
            missingChunks,
          });
        }

        // Stream-concatenate sequentially with explicit backpressure (zero multi-GB memory buffering)
        const writeStream = fs.createWriteStream(targetPath);
        const streamErr = new Promise<never>((_resolve, reject) => {
          writeStream.once('error', reject);
        });

        try {
          for (let i = 0; i < project.totalChunks; i++) {
            const partPath = path.join(chunkDir, `part_${String(i).padStart(6, '0')}`);
            const rs = fs.createReadStream(partPath);
            for await (const buf of rs) {
              if (!writeStream.write(buf)) {
                await Promise.race([
                  new Promise<void>((resolve) => writeStream.once('drain', resolve)),
                  streamErr,
                ]);
              }
            }
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              writeStream.end(() => resolve());
            }),
            streamErr,
          ]);
        } catch (assembleErr) {
          writeStream.destroy();
          fs.rmSync(targetPath, { force: true });
          throw assembleErr;
        }
      }

      // Verify assembled file size matches expected upload size before media probing
      const assembledSize = fs.statSync(targetPath).size;
      if (project.fileSize > 0 && assembledSize !== project.fileSize) {
        fs.rmSync(targetPath, { force: true });
        logBackendError({
          projectId: project.id,
          uploadId: project.uploadId,
          stage: 'upload_assembly_verify',
          httpStatus: 400,
          route: 'POST /api/uploads/:projectId/complete',
          error: new Error(`Assembled size mismatch: expected ${project.fileSize} bytes, got ${assembledSize} bytes`),
        });
        return res.status(400).json({
          error: 'Assembled video file size did not match the uploaded file. Please resume or retry the upload.',
        });
      }

      // Probe with FFprobe (handles MP4, MKV, MOV, WebM, HEVC, VFR, and missing header duration)
      const meta = await probeVideoFile(targetPath);
      if (!Number.isFinite(meta.duration) || meta.duration <= 0) {
        fs.rmSync(targetPath, { force: true });
        return res.status(400).json({
          error: 'Uploaded file could not be decoded as a valid video. Please verify the file is not corrupted.',
        });
      }

      // Remove temporary chunk files only after assembly, size check & FFprobe succeed
      if (fs.existsSync(chunkDir)) {
        fs.rmSync(chunkDir, { recursive: true, force: true });
      }

      // Extract thumbnail (non-fatal if a weird video stream fails thumbnail seek)
      const thumbPath = path.join(projectDir, 'thumb.jpg');
      let hasThumbnail = false;
      try {
        await extractThumbnail(targetPath, thumbPath, Math.min(2, meta.duration * 0.15));
        hasThumbnail = fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0;
      } catch (thumbErr) {
        console.warn('Thumbnail extraction skipped:', thumbErr);
      }

      // Ensure MKV, MOV, AVI, or non-H.264 (e.g. HEVC/H.265) uploads get a browser-playable MP4 preview
      // WITHOUT ever blocking /complete past HTTP proxy timeouts or serving unplayable HEVC to <video>.
      let browserPreviewUrl: string | undefined = `/media/projects/${project.id}/${targetFilename}`;
      let browserProxyStatus: 'ready' | 'transcoding' | 'failed' = 'ready';
      const isH264 = meta.codec === 'h264' || meta.codec === 'avc1';
      const isWebmNative = ext === '.webm' && (meta.codec === 'vp8' || meta.codec === 'vp9' || meta.codec === 'av1');
      const isDirectlyBrowserPlayable =
        ((ext === '.mp4' && isH264) || isWebmNative) &&
        (meta.audioCodec === 'aac' || meta.audioCodec === 'mp3' || meta.audioCodec === 'opus' || meta.audioCodec === 'none');
      const needsBrowserProxy = !isDirectlyBrowserPlayable;

      if (needsBrowserProxy) {
        const previewPath = path.join(projectDir, 'preview_browser.mp4');
        const previewTmpPath = path.join(projectDir, 'preview_browser.tmp.mp4');
        if (isH264 && meta.fileSize <= 500 * 1024 * 1024) {
          // Ultra-fast container remux (typically 1-3s)
          try {
            await execFileAsync(
              'ffmpeg',
              [
                '-loglevel',
                'error',
                '-y',
                '-i',
                targetPath,
                '-c:v',
                'copy',
                ...(meta.audioCodec !== 'none' ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : ['-an']),
                '-f',
                'mp4',
                '-movflags',
                '+faststart',
                previewTmpPath,
              ],
              { maxBuffer: 16 * 1024 * 1024, timeout: 25000 }
            );
            if (fs.existsSync(previewTmpPath) && fs.statSync(previewTmpPath).size > 0) {
              fs.renameSync(previewTmpPath, previewPath);
              browserPreviewUrl = `/media/projects/${project.id}/preview_browser.mp4`;
              browserProxyStatus = 'ready';
            }
          } catch (proxyErr) {
            try {
              if (fs.existsSync(previewTmpPath)) fs.unlinkSync(previewTmpPath);
            } catch {
              // ignore cleanup error
            }
            console.warn('Fast preview remux skipped:', proxyErr);
          }
        } else {
          // Background H.264 proxy transcode for large MKV/MOV/HEVC/ProRes files so upload completes immediately.
          // Defer browser <video src> until atomic H.264 proxy finishes to prevent "The element has no supported sources."
          browserPreviewUrl = undefined;
          browserProxyStatus = 'transcoding';
          const proxyArgs = isH264
            ? [
                '-loglevel',
                'error',
                '-y',
                '-i',
                targetPath,
                '-c:v',
                'copy',
                ...(meta.audioCodec !== 'none' ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : ['-an']),
                '-f',
                'mp4',
                '-movflags',
                '+faststart',
                previewTmpPath,
              ]
            : [
                '-loglevel',
                'error',
                '-y',
                '-i',
                targetPath,
                '-vf',
                'scale=min(1280\\,iw):-2',
                '-c:v',
                'libx264',
                '-preset',
                'veryfast',
                '-crf',
                '24',
                '-pix_fmt',
                'yuv420p',
                ...(meta.audioCodec !== 'none' ? ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'] : ['-an']),
                '-f',
                'mp4',
                '-movflags',
                '+faststart',
                previewTmpPath,
              ];
          const bgProc = spawn('ffmpeg', proxyArgs, { stdio: 'ignore' });
          bgProc.on('close', (code) => {
            const latest = store.getProject(project.id);
            if (code === 0 && fs.existsSync(previewTmpPath) && fs.statSync(previewTmpPath).size > 0) {
              try {
                fs.renameSync(previewTmpPath, previewPath);
                if (latest) {
                  latest.sourceUrl = `/media/projects/${project.id}/preview_browser.mp4`;
                  latest.browserProxyStatus = 'ready';
                  store.upsertProject(latest);
                }
                return;
              } catch {
                // fall through to failure state
              }
            }
            try {
              if (fs.existsSync(previewTmpPath)) fs.unlinkSync(previewTmpPath);
            } catch {
              // ignore cleanup
            }
            if (latest && !latest.sourceUrl) {
              latest.browserProxyStatus = 'failed';
              store.upsertProject(latest);
            }
          });
          bgProc.on('error', () => {
            const latest = store.getProject(project.id);
            if (latest && !latest.sourceUrl) {
              latest.browserProxyStatus = 'failed';
              store.upsertProject(latest);
            }
          });
        }
      }

      project.sourcePath = targetPath;
      project.storageRef = `local://projects/${project.id}/${targetFilename}`;
      project.sourceUrl = browserPreviewUrl;
      project.browserProxyStatus = browserProxyStatus;
      project.originalContainer = ext.replace('.', '').toUpperCase();
      project.thumbnailUrl = hasThumbnail ? `/media/projects/${project.id}/thumb.jpg` : undefined;
      project.fileSize = meta.fileSize;
      project.metadata = meta;
      project.uploadProgress = 100;
      project.status = 'uploaded';
      project.errorMessage = undefined;
      project.failedStage = undefined;
      store.upsertProject(project);

      // Seamless Upload-to-Processing Handoff when autoAnalyze is enabled
      if (autoAnalyze && isGeminiConfigured() && !isPipelineRunning(project.id)) {
        void runAnalysisPipeline(project.id);
      }

      res.json(store.getProject(project.id) ?? project);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: project.id,
        uploadId: project.uploadId,
        stage: 'upload_complete',
        httpStatus: 500,
        route: 'POST /api/uploads/:projectId/complete',
        error: err,
      });
      project.status = 'failed';
      project.failedStage = 'upload_complete';
      project.errorMessage = safeErr;
      store.upsertProject(project);
      res.status(500).json({ error: safeErr });
    }
  });

  // Cancel in-progress upload
  app.delete('/api/uploads/:projectId/cancel', (req, res) => {
    store.deleteProject(req.params.projectId);
    res.json({ cancelled: true });
  });

  // Create real spoken sample video (Gemini TTS + FFmpeg) for immediate testing
  app.post('/api/projects/sample', async (req, res) => {
    const projectId = uuidv4();
    let createdStub = false;
    try {
      if (!isGeminiConfigured()) {
        return res.status(400).json({
          error: 'GEMINI_API_KEY is not configured. Configure it in Settings > Secrets first.',
        });
      }
      const settings = store.getSettings();
      const bodyConfig = (req.body?.analysisConfig ?? {}) as Partial<AnalysisConfig>;
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: projectId,
        uploadId: uuidv4(),
        name: 'Creator Craft Podcast — Ep 42 (Spoken Test)',
        originalFilename: 'creator_craft_ep42.mp4',
        mimeType: 'video/mp4',
        status: 'uploading',
        uploadProgress: 50,
        uploadedChunks: [0],
        totalChunks: 1,
        fileSize: 0,
        analysisConfig: {
          mode: bodyConfig.mode === 'captions_only' ? 'captions_only' : 'auto_clips',
          targetClipDuration: bodyConfig.targetClipDuration ?? 18,
          clipCount: bodyConfig.clipCount ?? 3,
          language: bodyConfig.language ?? 'en',
          aspectRatio:
            bodyConfig.mode === 'captions_only'
              ? 'original'
              : (bodyConfig.aspectRatio ?? settings.defaultAspectRatio),
          framingMode: bodyConfig.framingMode ?? settings.defaultFramingMode,
          captionPresetId: bodyConfig.captionPresetId ?? settings.defaultCaptionPresetId,
          stylePresetId: bodyConfig.stylePresetId ?? settings.defaultStylePresetId,
          motionIntensity: bodyConfig.motionIntensity ?? settings.defaultMotionIntensity,
        },
        pipelineStages: createInitialPipelineStages(),
        completedAudioChunks: 0,
        totalAudioChunks: 0,
        completedTranscriptChunks: 0,
        transcript: [],
        silences: [],
        scenes: [],
        clips: [],
        createdAt: now,
        updatedAt: now,
      };
      store.upsertProject(project);
      createdStub = true;
      const completed = await createRealSampleVideoProject(project);
      res.json(completed);
    } catch (err) {
      if (createdStub) {
        store.deleteProject(projectId);
      }
      const safeErr = logBackendError({
        projectId,
        stage: 'sample_generation',
        httpStatus: 500,
        route: 'POST /api/projects/sample',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Start or Resume AI Video Intelligence Pipeline
  app.post('/api/projects/:id/analyze', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
      return res.status(400).json({ error: 'Source video is not available on disk.' });
    }
    if (!isGeminiConfigured()) {
      return res.status(400).json({
        error: 'GEMINI_API_KEY is not configured. Please configure your API key in Settings > Secrets.',
      });
    }

    const body = req.body as { analysisConfig?: Partial<AnalysisConfig>; restartHighlightsOnly?: boolean };
    if (body?.analysisConfig) {
      project.analysisConfig = { ...project.analysisConfig, ...body.analysisConfig };
    }
    if (body?.restartHighlightsOnly) {
      const resetKeys = new Set([
        'hook_discovery',
        'hook_scoring',
        'hook_verification',
        'clip_generation',
        'clip_rendering',
        'highlight_selection',
        'clip_thumbnails',
      ]);
      for (const s of project.pipelineStages) {
        if (resetKeys.has(s.key)) {
          s.status = 'pending';
          s.progress = 0;
        }
      }
      project.hookCandidates = [];
      project.hookSelectionNote = undefined;
    }
    store.upsertProject(project);

    if (!isPipelineRunning(project.id)) {
      void runAnalysisPipeline(project.id);
    }
    res.json({ started: true, project: store.getProject(project.id) });
  });

  // Hook Intelligence — Approve, Reject, or Edit Start/End Timestamps of a Hook Candidate
  app.patch('/api/projects/:id/hooks/:candidateId', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    const list = project.hookCandidates ?? [];
    const idx = list.findIndex((c) => c.id === req.params.candidateId);
    if (idx < 0) return res.status(404).json({ error: 'Hook candidate not found.' });

    const existing = list[idx];
    const patch = (req.body ?? {}) as Partial<HookCandidate>;
    const maxDur = project.metadata?.duration ?? 99999;

    const nextStart =
      typeof patch.startTime === 'number' && Number.isFinite(patch.startTime)
        ? Math.max(0, Math.min(maxDur - 1.5, patch.startTime))
        : existing.startTime;
    const nextEnd =
      typeof patch.endTime === 'number' && Number.isFinite(patch.endTime)
        ? Math.max(nextStart + 1.5, Math.min(maxDur, patch.endTime))
        : existing.endTime;

    const merged: HookCandidate = {
      ...existing,
      title: typeof patch.title === 'string' && patch.title.trim() ? patch.title.trim() : existing.title,
      status: patch.status ?? existing.status,
      startTime: nextStart,
      endTime: nextEnd,
    };

    const refreshed = refreshHookCandidateTranscriptFields(project, merged);
    list[idx] = refreshed;
    project.hookCandidates = list;
    store.upsertProject(project);

    res.json({ candidate: refreshed, project });
  });

  // Hook Intelligence — Generate a Real Clip & Render Verified MP4 from a Hook Candidate
  app.post('/api/projects/:id/hooks/:candidateId/generate-clip', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project || !project.sourcePath || !fs.existsSync(project.sourcePath)) {
      return res.status(404).json({ error: 'Project or source video not found.' });
    }
    const list = project.hookCandidates ?? [];
    const idx = list.findIndex((c) => c.id === req.params.candidateId);
    if (idx < 0) return res.status(404).json({ error: 'Hook candidate not found.' });

    try {
      const candidate = refreshHookCandidateTranscriptFields(project, list[idx]);
      const existingClipIdx = candidate.clipId
        ? project.clips.findIndex((c) => c.id === candidate.clipId)
        : -1;

      const clip = buildClipFromHookCandidate(
        project,
        candidate,
        existingClipIdx >= 0 ? project.clips[existingClipIdx].id : undefined
      );
      clip.renderStatus = 'queued';
      clip.renderStageDetail = 'Queued for FFmpeg MP4 render...';

      const thumbPath = path.join(store.getProjectDir(project.id), 'clips', clip.id, 'thumb.jpg');
      try {
        await extractThumbnail(project.sourcePath, thumbPath, clip.startTime + Math.min(2, clip.duration * 0.25));
        clip.thumbnailUrl = `/media/projects/${project.id}/clips/${clip.id}/thumb.jpg?t=${Date.now()}`;
      } catch {
        if (project.thumbnailUrl) clip.thumbnailUrl = project.thumbnailUrl;
      }

      if (existingClipIdx >= 0) {
        project.clips[existingClipIdx] = clip;
      } else {
        project.clips.unshift(clip);
      }

      candidate.clipId = clip.id;
      candidate.status = 'generated';
      list[idx] = candidate;
      project.hookCandidates = list;
      store.upsertProject(project);

      const settings = store.getSettings();
      const options: ExportOptions = {
        resolution: settings.defaultExportResolution === '4k' ? '1080p' : settings.defaultExportResolution,
        codec: 'h264',
        fps: settings.defaultExportFps || 30,
        quality: 'excellent',
        embedCaptions: true,
        includeMusic: true,
      };
      const exportJob: ExportJob = {
        id: uuidv4(),
        projectId: project.id,
        clipId: clip.id,
        clipTitle: clip.title,
        status: 'queued',
        stage: 'queued',
        stageDetail: 'Queued for MP4 rendering & FFprobe validation...',
        progress: 0,
        options,
        createdAt: new Date().toISOString(),
      };
      store.upsertExportJob(exportJob);
      renderQueue.push({ projectId: project.id, clipId: clip.id, jobId: exportJob.id, options });
      void processRenderQueue();

      res.json({ clip, candidate, exportJob, project: store.getProject(project.id) ?? project });
    } catch (err) {
      const safeErr = logBackendError({
        projectId: project.id,
        stage: 'hook_generate_clip',
        httpStatus: 500,
        route: 'POST /api/projects/:id/hooks/:candidateId/generate-clip',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Update a single clip (trim, title, captions, style, motion, framing, audio, overlays)
  app.patch('/api/projects/:id/clips/:clipId', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    const idx = project.clips.findIndex((c) => c.id === req.params.clipId);
    if (idx < 0) return res.status(404).json({ error: 'Clip not found.' });

    const existing = project.clips[idx];
    const patch = req.body as Partial<ClipRecord>;

    const nextStart =
      typeof patch.startTime === 'number'
        ? Math.max(0, Math.min((project.metadata?.duration ?? 99999) - 2, patch.startTime))
        : existing.startTime;
    const nextEnd =
      typeof patch.endTime === 'number'
        ? Math.max(nextStart + 2, Math.min(project.metadata?.duration ?? 99999, patch.endTime))
        : existing.endTime;

    const updated: ClipRecord = {
      ...existing,
      ...patch,
      id: existing.id,
      projectId: existing.projectId,
      startTime: Number(nextStart.toFixed(2)),
      endTime: Number(nextEnd.toFixed(2)),
      duration: Number((nextEnd - nextStart).toFixed(2)),
      editingStatus: 'edited',
      updatedAt: new Date().toISOString(),
    };

    // Refresh thumbnail if trim start shifted significantly
    if (Math.abs(updated.startTime - existing.startTime) > 1.5 && project.sourcePath) {
      try {
        const thumbPath = path.join(store.getProjectDir(project.id), 'clips', updated.id, 'thumb.jpg');
        await extractThumbnail(project.sourcePath, thumbPath, updated.startTime + Math.min(1.5, updated.duration * 0.2));
        updated.thumbnailUrl = `/media/projects/${project.id}/clips/${updated.id}/thumb.jpg?t=${Date.now()}`;
      } catch {
        // non-fatal
      }
    }

    project.clips[idx] = updated;
    store.upsertProject(project);
    res.json(updated);
  });

  // Apply caption style to all clips in project
  app.post('/api/projects/:id/clips/:clipId/apply-captions-all', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    const sourceClip = project.clips.find((c) => c.id === req.params.clipId);
    if (!sourceClip) return res.status(404).json({ error: 'Clip not found.' });

    const styleToApply = req.body?.captionStyle ?? sourceClip.captionStyle;
    const now = new Date().toISOString();
    project.clips = project.clips.map((c) => ({
      ...c,
      captionStyle: { ...styleToApply },
      editingStatus: 'edited',
      updatedAt: now,
    }));
    store.upsertProject(project);
    res.json({ updatedCount: project.clips.length, project });
  });

  // Apply visual grading & motion graphics to all clips in project
  app.post('/api/projects/:id/clips/:clipId/apply-style-all', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    const sourceClip = project.clips.find((c) => c.id === req.params.clipId);
    if (!sourceClip) return res.status(404).json({ error: 'Clip not found.' });

    const grading = req.body?.colorGrading ?? sourceClip.colorGrading;
    const motion = req.body?.motionGraphics ?? sourceClip.motionGraphics;
    const framing = req.body?.framing;
    const now = new Date().toISOString();

    project.clips = project.clips.map((c) => ({
      ...c,
      colorGrading: { ...grading },
      motionGraphics: {
        ...motion,
        hookTitleText: c.motionGraphics.hookTitleText,
        speakerLabel: c.motionGraphics.speakerLabel,
        emphasizedKeywords: c.motionGraphics.emphasizedKeywords,
      },
      framing: framing
        ? { ...c.framing, aspectRatio: framing.aspectRatio, mode: framing.mode }
        : c.framing,
      editingStatus: 'edited',
      updatedAt: now,
    }));
    store.upsertProject(project);
    res.json({ updatedCount: project.clips.length, project });
  });

  // Regenerate a single clip with Gemini
  app.post('/api/projects/:id/clips/:clipId/regenerate', async (req, res) => {
    try {
      const { targetDuration, focusPrompt } = (req.body ?? {}) as {
        targetDuration?: number;
        focusPrompt?: string;
      };
      const updated = await regenerateSingleClip({
        projectId: req.params.id,
        clipId: req.params.clipId,
        targetDuration,
        focusPrompt,
      });
      res.json(updated);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: req.params.id,
        stage: 'clip_regenerate',
        httpStatus: 500,
        route: 'POST /api/projects/:id/clips/:clipId/regenerate',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Delete a single clip
  app.delete('/api/projects/:id/clips/:clipId', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    project.clips = project.clips.filter((c) => c.id !== req.params.clipId);
    store.upsertProject(project);
    const clipDir = path.join(store.getProjectDir(project.id), 'clips', req.params.clipId);
    if (fs.existsSync(clipDir)) {
      fs.rmSync(clipDir, { recursive: true, force: true });
    }
    res.json({ deleted: true });
  });

  // Create or activate a Full-Original-Video Captions-Only track on any uploaded project (zero video changes)
  app.post('/api/projects/:id/captions-full-video', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });
    if (!project.sourcePath || !fs.existsSync(project.sourcePath)) {
      return res.status(400).json({ error: 'Source video file is not available on disk.' });
    }

    const body = (req.body ?? {}) as {
      captionPresetId?: string;
      autoRender?: boolean;
      language?: string;
    };

    const chosenPresetId =
      typeof body.captionPresetId === 'string' && body.captionPresetId.trim()
        ? body.captionPresetId.trim()
        : project.analysisConfig.captionPresetId || 'loki-emerald-gold';

    if (typeof body.language === 'string' && body.language.trim()) {
      project.analysisConfig.language = body.language.trim();
    }
    project.analysisConfig.captionPresetId = chosenPresetId;

    // If the project has not been transcribed yet, kick off the fast Captions-Only pipeline
    if (project.transcript.length === 0 && project.metadata?.audioCodec !== 'none') {
      if (!isGeminiConfigured()) {
        return res.status(400).json({
          error: 'GEMINI_API_KEY is not configured. Configure it in Settings > Secrets to transcribe speech.',
        });
      }
      project.analysisConfig.mode = 'captions_only';
      project.analysisConfig.aspectRatio = 'original';
      store.upsertProject(project);
      if (!isPipelineRunning(project.id)) {
        void runAnalysisPipeline(project.id);
      }
      return res.json({
        startedPipeline: true,
        project: store.getProject(project.id) ?? project,
      });
    }

    // Transcript already exists — create or update the Full-Original-Video caption track immediately
    const existing = project.clips.find((c) => c.isFullVideoCaption);
    const fullClip = buildFullVideoCaptionClip(project, chosenPresetId, existing?.id);
    if (existing) {
      fullClip.captionStyle = existing.captionStyle;
      fullClip.customSegments = existing.customSegments;
      fullClip.renderStatus = existing.renderStatus;
      fullClip.renderedVideoUrl = existing.renderedVideoUrl;
      fullClip.storageObjectPath = existing.storageObjectPath;
      fullClip.mp4Filename = existing.mp4Filename;
      fullClip.renderedFileSize = existing.renderedFileSize;
      fullClip.renderedDuration = existing.renderedDuration;
      fullClip.renderedResolution = existing.renderedResolution;
      fullClip.renderedAt = existing.renderedAt;
      project.clips = project.clips.map((c) => (c.id === existing.id ? fullClip : c));
    } else {
      project.clips.unshift(fullClip);
    }
    store.upsertProject(project);

    let exportJob: ExportJob | undefined;
    if (body.autoRender) {
      const options: ExportOptions = {
        resolution: 'original',
        codec: 'h264',
        fps: 'original',
        quality: 'master',
        embedCaptions: true,
        includeMusic: false,
      };
      exportJob = {
        id: uuidv4(),
        projectId: project.id,
        clipId: fullClip.id,
        clipTitle: fullClip.title,
        status: 'queued',
        stage: 'queued',
        stageDetail: 'Queued for original-quality captioned MP4 render...',
        progress: 0,
        options,
        createdAt: new Date().toISOString(),
      };
      fullClip.renderStatus = 'queued';
      fullClip.renderStageDetail = 'Queued for original-quality captioned MP4 render...';
      fullClip.renderError = undefined;
      store.upsertProject(project);
      store.upsertExportJob(exportJob);
      renderQueue.push({ projectId: project.id, clipId: fullClip.id, jobId: exportJob.id, options });
      void processRenderQueue();
    }

    res.json({
      startedPipeline: false,
      clip: fullClip,
      exportJob,
      project: store.getProject(project.id) ?? project,
    });
  });

  // Acoustic Voiceover-to-Caption Re-Sync endpoint (snaps segment & word timestamps to exact speech waveform onsets)
  app.post('/api/projects/:id/resync-audio', async (req, res) => {
    try {
      const clipId = typeof req.body?.clipId === 'string' ? req.body.clipId : undefined;
      const result = await resyncProjectCaptionsWithAudio(req.params.id, clipId);
      res.json(result);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: req.params.id,
        stage: 'caption_audio_resync',
        httpStatus: 500,
        route: 'POST /api/projects/:id/resync-audio',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // High-End Clip Audio Analysis & Dedicated Caption Generation for a specific clip or full video
  app.post('/api/projects/:id/clips/:clipId/analyze-audio-captions', async (req, res) => {
    try {
      const language = typeof req.body?.language === 'string' ? req.body.language : undefined;
      const result = await analyzeClipAudioAndGenerateCaptions(
        req.params.id,
        req.params.clipId,
        { language }
      );
      res.json(result);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: req.params.id,
        stage: 'clip_audio_caption_analysis',
        httpStatus: 500,
        route: 'POST /api/projects/:id/clips/:clipId/analyze-audio-captions',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Download Animated Captions-Only Chroma Green Screen MP4 (for Premiere Pro, CapCut, After Effects, DaVinci Resolve, Filmora)
  app.get('/api/projects/:id/clips/:clipId/download-chroma-captions', async (req, res) => {
    let project = store.getProject(req.params.id);
    let clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) return res.status(404).json({ error: 'Clip not found.' });

    try {
      // Auto-analyze clip audio & generate voiceover-synced captions if no caption segments exist yet
      if (getClipSegments(project, clip).length === 0 && project.sourcePath && fs.existsSync(project.sourcePath)) {
        try {
          const analyzed = await analyzeClipAudioAndGenerateCaptions(project.id, clip.id);
          project = analyzed.project;
          clip = analyzed.clip;
        } catch (autoErr) {
          console.warn('[ChromaCaptions] Auto audio analysis fallback warning:', autoErr);
        }
      }

      const rawColor = typeof req.query.color === 'string' ? req.query.color : '#00FF00';
      const includeAudio = req.query.includeAudio !== 'false';
      const rawRes = typeof req.query.resolution === 'string' ? req.query.resolution : undefined;
      const resolution =
        rawRes === '720p' || rawRes === '1080p' || rawRes === '4k' || rawRes === 'original'
          ? rawRes
          : undefined;

      const { filePath, fileSize, chromaHex } = await renderChromaCaptionsMp4({
        project,
        clip,
        chromaColor: rawColor,
        includeAudio,
        resolution,
      });

      const baseName =
        clip.title.replace(/[^a-zA-Z0-9-_]/g, '_').replace(/_+/g, '_').slice(0, 50) || 'captions';
      const colorTag =
        chromaHex === '#00FF00' || chromaHex === '#00B140'
          ? 'chroma_green'
          : chromaHex === '#0047AB'
            ? 'chroma_blue'
            : 'chroma_matte';
      const downloadFilename = `${baseName}_${colorTag}_captions.mp4`;

      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
      res.setHeader('Content-Length', String(fileSize));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');

      const stream = fs.createReadStream(filePath);
      res.on('close', () => {
        if (!stream.destroyed) stream.destroy();
      });
      stream.on('error', (err) => {
        logBackendError({
          projectId: project!.id,
          stage: 'chroma_captions_download',
          httpStatus: 500,
          route: 'GET /api/projects/:id/clips/:clipId/download-chroma-captions',
          error: err,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream Chroma Green Screen captions MP4.' });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: project.id,
        stage: 'chroma_captions_render',
        httpStatus: 500,
        route: 'GET /api/projects/:id/clips/:clipId/download-chroma-captions',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Download SRT subtitles for a clip
  app.get('/api/projects/:id/clips/:clipId/subtitles.srt', async (req, res) => {
    let project = store.getProject(req.params.id);
    let clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) return res.status(404).json({ error: 'Clip not found.' });

    try {
      if (getClipSegments(project, clip).length === 0 && project.sourcePath && fs.existsSync(project.sourcePath)) {
        try {
          const analyzed = await analyzeClipAudioAndGenerateCaptions(project.id, clip.id);
          project = analyzed.project;
          clip = analyzed.clip;
        } catch (autoErr) {
          console.warn('[SRTDownload] Auto audio analysis fallback warning:', autoErr);
        }
      }
      const srt = generateSrtSubtitles(project, clip);
      if (!srt.trim()) {
        return res.status(400).json({
          error: 'No captions generated for this clip yet. Click "Analyze Clip Audio & Generate Captions" first.',
        });
      }
      const safeName = clip.title.replace(/[^a-zA-Z0-9-_]/g, '_').replace(/_+/g, '_').slice(0, 60) || 'captions';
      res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.srt"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.send(srt);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: project.id,
        stage: 'srt_download',
        httpStatus: 500,
        route: 'GET /api/projects/:id/clips/:clipId/subtitles.srt',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Download WebVTT subtitles for a clip
  app.get('/api/projects/:id/clips/:clipId/subtitles.vtt', async (req, res) => {
    let project = store.getProject(req.params.id);
    let clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) return res.status(404).json({ error: 'Clip not found.' });

    try {
      if (getClipSegments(project, clip).length === 0 && project.sourcePath && fs.existsSync(project.sourcePath)) {
        try {
          const analyzed = await analyzeClipAudioAndGenerateCaptions(project.id, clip.id);
          project = analyzed.project;
          clip = analyzed.clip;
        } catch (autoErr) {
          console.warn('[VTTDownload] Auto audio analysis fallback warning:', autoErr);
        }
      }
      const vtt = generateVttSubtitles(project, clip);
      if (vtt.trim() === 'WEBVTT') {
        return res.status(400).json({
          error: 'No captions generated for this clip yet. Click "Analyze Clip Audio & Generate Captions" first.',
        });
      }
      const safeName = clip.title.replace(/[^a-zA-Z0-9-_]/g, '_').replace(/_+/g, '_').slice(0, 60) || 'captions';
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.vtt"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.send(vtt);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: project.id,
        stage: 'vtt_download',
        httpStatus: 500,
        route: 'GET /api/projects/:id/clips/:clipId/subtitles.vtt',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Download Styled High-End ASS subtitles for a clip
  app.get('/api/projects/:id/clips/:clipId/subtitles.ass', async (req, res) => {
    let project = store.getProject(req.params.id);
    let clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) return res.status(404).json({ error: 'Clip not found.' });

    try {
      if (getClipSegments(project, clip).length === 0 && project.sourcePath && fs.existsSync(project.sourcePath)) {
        try {
          const analyzed = await analyzeClipAudioAndGenerateCaptions(project.id, clip.id);
          project = analyzed.project;
          clip = analyzed.clip;
        } catch (autoErr) {
          console.warn('[ASSDownload] Auto audio analysis fallback warning:', autoErr);
        }
      }
      if (getClipSegments(project, clip).length === 0) {
        return res.status(400).json({
          error: 'No captions generated for this clip yet. Click "Analyze Clip Audio & Generate Captions" first.',
        });
      }
      const outW = project.metadata?.width || 1920;
      const outH = project.metadata?.height || 1080;
      const ass = generateAssSubtitles(project, clip, outW, outH);
      const safeName = clip.title.replace(/[^a-zA-Z0-9-_]/g, '_').replace(/_+/g, '_').slice(0, 60) || 'captions';
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.ass"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');
      res.send(ass);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: project.id,
        stage: 'ass_download',
        httpStatus: 500,
        route: 'GET /api/projects/:id/clips/:clipId/subtitles.ass',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Download 0%-re-encode bit-exact MP4 with embedded selectable mov_text captions
  app.get('/api/projects/:id/clips/:clipId/download-softsub', async (req, res) => {
    const project = store.getProject(req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) return res.status(404).json({ error: 'Clip not found.' });

    try {
      const { filePath, fileSize } = await renderSoftSubtitledMp4({ project, clip });
      const baseName =
        clip.title.replace(/[^a-zA-Z0-9-_]/g, '_').replace(/_+/g, '_').slice(0, 56) || 'video';
      const downloadFilename = `${baseName}_softsub_original.mp4`;

      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
      res.setHeader('Content-Length', String(fileSize));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-store');

      const stream = fs.createReadStream(filePath);
      res.on('close', () => {
        if (!stream.destroyed) stream.destroy();
      });
      stream.on('error', (err) => {
        logBackendError({
          projectId: project.id,
          stage: 'softsub_download',
          httpStatus: 500,
          route: 'GET /api/projects/:id/clips/:clipId/download-softsub',
          error: err,
        });
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream soft-subtitled MP4.' });
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      const safeErr = logBackendError({
        projectId: project.id,
        stage: 'softsub_mux',
        httpStatus: 500,
        route: 'GET /api/projects/:id/clips/:clipId/download-softsub',
        error: err,
      });
      res.status(500).json({ error: safeErr });
    }
  });

  // Generate fresh signed download URL after verifying persistent MP4 exists and is non-empty
  app.get('/api/projects/:id/clips/:clipId/download-url', (req, res) => {
    const project = store.getProject(req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      return res.status(404).json({ ready: false, error: 'Clip not found.' });
    }
    if (clip.renderStatus === 'failed') {
      return res.status(409).json({
        ready: false,
        renderStatus: 'failed',
        error: clip.renderError || 'MP4 rendering failed for this clip. Please re-render.',
      });
    }
    if (
      clip.renderStatus === 'queued' ||
      clip.renderStatus === 'rendering' ||
      clip.renderStatus === 'validating' ||
      clip.renderStatus === 'saving'
    ) {
      return res.status(409).json({
        ready: false,
        renderStatus: clip.renderStatus,
        error: clip.renderStageDetail || 'Clip MP4 is still being rendered and validated. Please wait a moment.',
      });
    }

    const fullPath = resolveClipMp4Path(project, clip);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(409).json({
        ready: false,
        renderStatus: 'not_rendered',
        error: 'Verified MP4 file is not rendered yet. Render the clip first.',
      });
    }
    const stat = fs.statSync(fullPath);
    if (stat.size <= 0) {
      return res.status(409).json({
        ready: false,
        renderStatus: 'failed',
        error: 'Rendered MP4 file is empty or corrupted. Please re-render.',
      });
    }

    const filename = buildClipDownloadFilename(clip);
    const storedName = path.basename(fullPath);
    const exp = Math.floor(Date.now() / 1000) + 600; // 10-minute fresh signed URL
    const token = signDownloadToken(project.id, clip.id, storedName, exp);

    res.json({
      ready: true,
      downloadUrl: `/api/projects/${project.id}/clips/${clip.id}/download?token=${token}&exp=${exp}`,
      filename,
      fileSize: stat.size,
      duration: clip.renderedDuration ?? clip.duration,
      resolution: clip.renderedResolution ?? (clip.lastExportConfig?.resolution || '1080p'),
      mimeType: 'video/mp4',
      expiresAt: new Date(exp * 1000).toISOString(),
    });
  });

  // Direct verified MP4 download stream with strict video/mp4 Content-Type & Content-Disposition headers
  app.get('/api/projects/:id/clips/:clipId/download', (req, res) => {
    const project = store.getProject(req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) {
      return res.status(404).json({ error: 'Clip not found.' });
    }
    const fullPath = resolveClipMp4Path(project, clip);
    if (!fullPath || !fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Rendered MP4 file is not available on disk. Please render the clip first.' });
    }
    const stat = fs.statSync(fullPath);
    if (stat.size <= 0) {
      return res.status(404).json({ error: 'Rendered MP4 file is empty. Please re-render.' });
    }

    // Verify signed URL token when provided
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const exp = typeof req.query.exp === 'string' ? Number(req.query.exp) : NaN;
    if (token) {
      const storedName = path.basename(fullPath);
      if (!verifyDownloadToken(project.id, clip.id, storedName, token, exp)) {
        return res.status(403).json({ error: 'Download link expired or invalid. Click Download MP4 to generate a fresh link.' });
      }
    }

    const downloadFilename = buildClipDownloadFilename(clip);
    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
    res.setHeader('Content-Length', String(stat.size));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    const readStream = fs.createReadStream(fullPath);
    res.on('close', () => {
      if (!readStream.destroyed) readStream.destroy();
    });
    readStream.on('error', (err) => {
      logBackendError({
        projectId: project.id,
        stage: 'mp4_download_stream',
        httpStatus: 500,
        route: 'GET /api/projects/:id/clips/:clipId/download',
        error: err,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream MP4 file.' });
      } else {
        res.end();
      }
    });
    readStream.pipe(res);
  });

  // Queue real FFmpeg render for a single clip
  app.post('/api/projects/:id/clips/:clipId/export', (req, res) => {
    const project = store.getProject(req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) return res.status(404).json({ error: 'Clip not found.' });

    const settings = store.getSettings();
    const body = (req.body ?? {}) as Partial<ExportOptions>;
    const preserveOrig = Boolean(clip.preserveOriginalVideo || clip.isFullVideoCaption);
    const options: ExportOptions = {
      resolution: body.resolution ?? (preserveOrig ? 'original' : settings.defaultExportResolution),
      codec: body.codec ?? settings.defaultExportCodec,
      fps: body.fps ?? (preserveOrig ? 'original' : settings.defaultExportFps),
      quality: body.quality ?? (preserveOrig ? 'master' : 'excellent'),
      embedCaptions: body.embedCaptions ?? true,
      includeMusic: body.includeMusic ?? (preserveOrig ? false : true),
    };

    const job: ExportJob = {
      id: uuidv4(),
      projectId: project.id,
      clipId: clip.id,
      clipTitle: clip.title,
      status: 'queued',
      stage: 'queued',
      stageDetail: 'Queued for MP4 rendering & FFprobe validation...',
      progress: 0,
      options,
      createdAt: new Date().toISOString(),
    };
    clip.renderStatus = 'queued';
    clip.renderStageDetail = 'Queued for MP4 render...';
    clip.renderError = undefined;
    store.upsertProject(project);
    store.upsertExportJob(job);

    renderQueue.push({ projectId: project.id, clipId: clip.id, jobId: job.id, options });
    void processRenderQueue();

    res.json(job);
  });

  // Queue real FFmpeg batch export for selected or all clips
  app.post('/api/projects/:id/export-batch', (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const settings = store.getSettings();
    const { clipIds, options: rawOptions } = (req.body ?? {}) as {
      clipIds?: string[];
      options?: Partial<ExportOptions>;
    };

    const options: ExportOptions = {
      resolution: rawOptions?.resolution ?? settings.defaultExportResolution,
      codec: rawOptions?.codec ?? settings.defaultExportCodec,
      fps: rawOptions?.fps ?? settings.defaultExportFps,
      quality: rawOptions?.quality ?? 'excellent',
      embedCaptions: rawOptions?.embedCaptions ?? true,
      includeMusic: rawOptions?.includeMusic ?? true,
    };

    const targets =
      Array.isArray(clipIds) && clipIds.length > 0
        ? project.clips.filter((c) => clipIds.includes(c.id))
        : project.clips;

    if (targets.length === 0) {
      return res.status(400).json({ error: 'No clips selected for export.' });
    }

    const jobs: ExportJob[] = targets.map((clip) => {
      const job: ExportJob = {
        id: uuidv4(),
        projectId: project.id,
        clipId: clip.id,
        clipTitle: clip.title,
        status: 'queued',
        stage: 'queued',
        stageDetail: 'Queued for MP4 rendering & FFprobe validation...',
        progress: 0,
        options,
        createdAt: new Date().toISOString(),
      };
      clip.renderStatus = 'queued';
      clip.renderStageDetail = 'Queued for MP4 render...';
      clip.renderError = undefined;
      store.upsertExportJob(job);
      renderQueue.push({ projectId: project.id, clipId: clip.id, jobId: job.id, options });
      return job;
    });
    store.upsertProject(project);

    void processRenderQueue();
    res.json({ jobs });
  });

  // Export jobs polling
  app.get('/api/exports', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json(store.getExportJobs(projectId));
  });

  app.get('/api/exports/:jobId', (req, res) => {
    const job = store.getExportJob(req.params.jobId);
    if (!job) return res.status(404).json({ error: 'Export job not found.' });
    res.json(job);
  });

  // Download all verified, rendered MP4 clips for a project as a real ZIP bundle
  app.get('/api/projects/:id/download-zip', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const verifiedCount = project.clips.filter((c) => {
      const p = resolveClipMp4Path(project, c);
      return Boolean(p && fs.existsSync(p) && fs.statSync(p).size > 0);
    }).length;

    if (verifiedCount === 0) {
      return res.status(409).json({ error: 'No verified MP4 clips are ready yet. Render clips first before downloading ZIP.' });
    }

    const safeProjName =
      project.name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '_') || 'clipgenius_export';
    res.status(200);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeProjName}_clips.zip"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');

    try {
      await streamProjectClipsZip(project, res);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'ZIP creation failed.' });
      }
    }
  });

  // Ensure unmatched /api routes return JSON 404 instead of SPA index.html
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // Always return JSON on Express body-parser / middleware errors under /api
  app.use('/api', (err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof err === 'object' && err && 'status' in err && typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const safeErr = logBackendError({
      stage: 'api_middleware',
      httpStatus: status,
      route: `${req.method} ${req.originalUrl}`,
      error: err,
    });
    if (!res.headersSent) {
      res.status(status).json({ error: sanitizeErrorMessage(safeErr) });
    }
  });

  // Prevent browsers/proxies from caching stale HTML entry pages pointing to outdated Vite dep hashes
  app.use((req, res, next) => {
    const accept = req.headers.accept || '';
    if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html') || accept.includes('text/html'))) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });

  // Mount Vite dev server middleware or serve built dist/
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: false,
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const portFlagIdx = process.argv.indexOf('--port');
  const cliPort =
    portFlagIdx >= 0 && process.argv[portFlagIdx + 1]
      ? Number(process.argv[portFlagIdx + 1])
      : undefined;
  const PORT = Number(cliPort || process.env.PORT || 3000);
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipGenius AI server running at http://0.0.0.0:${PORT}`);
  });
  // Keep Node's keep-alive timeout above Nginx/Cloud Run proxy timeouts to prevent 502 -> warmup HTML 200 races
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 70_000;
  httpServer.requestTimeout = 0;
}

process.on('uncaughtException', (err) => {
  console.error('[ClipGenius Server] Caught uncaughtException (keeping server alive):', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ClipGenius Server] Caught unhandledRejection (keeping server alive):', reason);
});

createServer().catch((err) => {
  console.error('Fatal error starting ClipGenius AI server:', err);
  process.exit(1);
});
