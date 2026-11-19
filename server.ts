import 'dotenv/config';
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
  ProjectRecord,
  SystemCapabilities,
} from './shared/types.ts';
import { store, MUSIC_DIR, PROJECTS_DIR } from './server/store.ts';
import { ensureMusicFileByName, getMusicTracks } from './server/music.ts';
import { isGeminiConfigured } from './server/gemini.ts';
import {
  createInitialPipelineStages,
  createRealSampleVideoProject,
  extractThumbnail,
  isPipelineRunning,
  probeVideoFile,
  regenerateSingleClip,
  runAnalysisPipeline,
} from './server/pipeline.ts';
import {
  generateSrtSubtitles,
  renderClipWithFFmpeg,
  streamProjectClipsZip,
} from './server/renderer.ts';

const execFileAsync = promisify(execFile);

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
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
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
    const projectDir = store.getProjectDir(projectId);
    fs.mkdirSync(path.join(projectDir, 'chunks'), { recursive: true });

    const computedChunks = totalChunks && totalChunks > 0 ? totalChunks : Math.ceil(fileSize / CHUNK_SIZE_BYTES);
    const now = new Date().toISOString();

    const project: ProjectRecord = {
      id: projectId,
      name: path.basename(filename, ext),
      originalFilename: filename,
      mimeType: mimeType || 'video/mp4',
      status: 'uploading',
      uploadProgress: 0,
      uploadedChunks: [],
      totalChunks: computedChunks,
      fileSize,
      analysisConfig: {
        targetClipDuration: analysisConfig?.targetClipDuration ?? settings.defaultClipDuration,
        clipCount: analysisConfig?.clipCount ?? settings.defaultClipCount,
        language: analysisConfig?.language ?? settings.defaultLanguage,
        aspectRatio: analysisConfig?.aspectRatio ?? settings.defaultAspectRatio,
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
    res.json({ projectId, chunkSize: CHUNK_SIZE_BYTES, project });
  });

  // Resumable Upload — Step 2: Receive binary chunk (supports both POST and PUT for universal proxy compatibility)
  const rawChunkParser = express.raw({ type: '*/*', limit: '20mb' });
  const handleUploadChunk: express.RequestHandler = (req, res) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Upload session not found.' });

    const chunkIndex = Number(req.params.index);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= project.totalChunks) {
      return res.status(400).json({ error: 'Invalid chunk index.' });
    }

    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: 'Empty chunk payload received.' });
    }

    const chunkDir = path.join(store.getProjectDir(project.id), 'chunks');
    fs.mkdirSync(chunkDir, { recursive: true });
    const chunkPath = path.join(chunkDir, `part_${String(chunkIndex).padStart(6, '0')}`);
    fs.writeFileSync(chunkPath, body);

    if (!project.uploadedChunks.includes(chunkIndex)) {
      project.uploadedChunks.push(chunkIndex);
    }
    project.uploadProgress = Math.min(
      99,
      Math.round((project.uploadedChunks.length / project.totalChunks) * 100)
    );
    store.upsertProject(project);

    res.json({
      received: chunkIndex,
      uploadedCount: project.uploadedChunks.length,
      totalChunks: project.totalChunks,
      uploadProgress: project.uploadProgress,
    });
  };
  app.post('/api/uploads/:projectId/chunk/:index', rawChunkParser, handleUploadChunk);
  app.put('/api/uploads/:projectId/chunk/:index', rawChunkParser, handleUploadChunk);

  // Resumable Upload — Step 3: Assemble chunks, probe with FFprobe, extract thumbnail (idempotent & non-blocking)
  app.post('/api/uploads/:projectId/complete', async (req, res) => {
    const project = store.getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Upload session not found.' });

    // Idempotency guard: if a previous /complete succeeded and client retried after a network blip, return it cleanly
    if (project.status === 'uploaded' && project.sourcePath && fs.existsSync(project.sourcePath)) {
      return res.json(project);
    }

    try {
      const projectDir = store.getProjectDir(project.id);
      const chunkDir = path.join(projectDir, 'chunks');
      const ext = path.extname(project.originalFilename).toLowerCase() || '.mp4';
      const targetFilename = `source${ext}`;
      const targetPath = path.join(projectDir, targetFilename);

      const alreadyAssembled = fs.existsSync(targetPath) && fs.statSync(targetPath).size === project.fileSize;

      if (!alreadyAssembled) {
        // Verify all chunks exist before assembling
        for (let i = 0; i < project.totalChunks; i++) {
          const partPath = path.join(chunkDir, `part_${String(i).padStart(6, '0')}`);
          if (!fs.existsSync(partPath)) {
            return res.status(400).json({
              error: `Missing upload chunk ${i + 1} of ${project.totalChunks}. Please resume upload.`,
              missingChunk: i,
            });
          }
        }

        // Concatenate sequentially with explicit backpressure & zero MaxListeners buildup
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
          throw assembleErr;
        }
      }

      // Probe with FFprobe (handles MP4, MKV, MOV, WebM, HEVC, VFR, and missing header duration)
      const meta = await probeVideoFile(targetPath);
      if (!Number.isFinite(meta.duration) || meta.duration <= 0) {
        fs.rmSync(targetPath, { force: true });
        return res.status(400).json({
          error: 'Uploaded file could not be decoded as a valid video. Please verify the file is not corrupted.',
        });
      }

      // Remove temporary chunk files only after assembly & FFprobe succeed
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

      // Ensure MKV, MOV, AVI, or non-H.264 uploads get a browser-playable MP4 preview
      // WITHOUT ever blocking /complete past HTTP proxy timeouts.
      let browserPreviewUrl = `/media/projects/${project.id}/${targetFilename}`;
      const isH264 = meta.codec === 'h264' || meta.codec === 'avc1';
      const needsBrowserProxy =
        (ext !== '.mp4' && ext !== '.webm') ||
        (!isH264 && ext !== '.webm') ||
        (meta.audioCodec !== 'aac' && meta.audioCodec !== 'mp3' && meta.audioCodec !== 'opus' && meta.audioCodec !== 'none');

      if (needsBrowserProxy) {
        const previewPath = path.join(projectDir, 'preview_browser.mp4');
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
                ...(meta.audioCodec !== 'none' ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']),
                '-movflags',
                '+faststart',
                previewPath,
              ],
              { maxBuffer: 16 * 1024 * 1024, timeout: 25000 }
            );
            if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 0) {
              browserPreviewUrl = `/media/projects/${project.id}/preview_browser.mp4`;
            }
          } catch (proxyErr) {
            console.warn('Fast preview remux skipped, using original file:', proxyErr);
          }
        } else {
          // Background proxy transcode for large MKV/MOV/HEVC/ProRes files so upload completes immediately
          const proxyArgs = isH264
            ? [
                '-loglevel',
                'error',
                '-y',
                '-i',
                targetPath,
                '-c:v',
                'copy',
                ...(meta.audioCodec !== 'none' ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']),
                '-movflags',
                '+faststart',
                previewPath,
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
                ...(meta.audioCodec !== 'none' ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']),
                '-movflags',
                '+faststart',
                previewPath,
              ];
          const bgProc = spawn('ffmpeg', proxyArgs, { stdio: 'ignore' });
          bgProc.on('close', (code) => {
            if (code === 0 && fs.existsSync(previewPath) && fs.statSync(previewPath).size > 0) {
              const latest = store.getProject(project.id);
              if (latest) {
                latest.sourceUrl = `/media/projects/${project.id}/preview_browser.mp4`;
                store.upsertProject(latest);
              }
            }
          });
          bgProc.on('error', () => {
            // Non-fatal; original source remains playable/renderable
          });
        }
      }

      project.sourcePath = targetPath;
      project.sourceUrl = browserPreviewUrl;
      project.originalContainer = ext.replace('.', '').toUpperCase();
      project.thumbnailUrl = hasThumbnail ? `/media/projects/${project.id}/thumb.jpg` : undefined;
      project.fileSize = meta.fileSize;
      project.metadata = meta;
      project.uploadProgress = 100;
      project.status = 'uploaded';
      project.errorMessage = undefined;
      store.upsertProject(project);

      res.json(project);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to assemble uploaded video.';
      console.error('Upload completion error:', err);
      project.status = 'failed';
      project.errorMessage = message;
      store.upsertProject(project);
      res.status(500).json({ error: message });
    }
  });

  // Cancel in-progress upload
  app.delete('/api/uploads/:projectId/cancel', (req, res) => {
    store.deleteProject(req.params.projectId);
    res.json({ cancelled: true });
  });

  // Create real spoken sample video (Gemini TTS + FFmpeg) for immediate testing
  app.post('/api/projects/sample', async (req, res) => {
    try {
      if (!isGeminiConfigured()) {
        return res.status(400).json({
          error: 'GEMINI_API_KEY is not configured. Configure it in Settings > Secrets first.',
        });
      }
      const settings = store.getSettings();
      const bodyConfig = (req.body?.analysisConfig ?? {}) as Partial<AnalysisConfig>;
      const projectId = uuidv4();
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: projectId,
        name: 'Creator Craft Podcast — Ep 42 (Spoken Test)',
        originalFilename: 'creator_craft_ep42.mp4',
        mimeType: 'video/mp4',
        status: 'uploading',
        uploadProgress: 50,
        uploadedChunks: [0],
        totalChunks: 1,
        fileSize: 0,
        analysisConfig: {
          targetClipDuration: bodyConfig.targetClipDuration ?? 18,
          clipCount: bodyConfig.clipCount ?? 3,
          language: bodyConfig.language ?? 'en',
          aspectRatio: bodyConfig.aspectRatio ?? settings.defaultAspectRatio,
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
      const completed = await createRealSampleVideoProject(project);
      res.json(completed);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to generate spoken sample video.',
      });
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
      for (const s of project.pipelineStages) {
        if (s.key === 'highlight_selection' || s.key === 'clip_thumbnails') {
          s.status = 'pending';
          s.progress = 0;
        }
      }
    }
    store.upsertProject(project);

    if (!isPipelineRunning(project.id)) {
      void runAnalysisPipeline(project.id);
    }
    res.json({ started: true, project: store.getProject(project.id) });
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
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to regenerate clip.',
      });
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

  // Download SRT subtitles for a clip
  app.get('/api/projects/:id/clips/:clipId/subtitles.srt', (req, res) => {
    const project = store.getProject(req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) return res.status(404).json({ error: 'Clip not found.' });
    const srt = generateSrtSubtitles(project, clip);
    const safeName = clip.title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'captions';
    res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.srt"`);
    res.send(srt);
  });

  // Direct attachment download for a rendered clip MP4
  app.get('/api/projects/:id/clips/:clipId/download', (req, res) => {
    const project = store.getProject(req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip || !clip.renderedVideoUrl) {
      return res.status(404).json({ error: 'Rendered clip file not found. Render the clip first.' });
    }
    const filename = path.basename(clip.renderedVideoUrl.split('?')[0]);
    const fullPath = path.join(store.getProjectDir(project.id), 'clips', clip.id, filename);
    if (!fs.existsSync(fullPath)) {
      return res.status(404).json({ error: 'Rendered MP4 is no longer on disk. Please re-render.' });
    }
    const safeTitle =
      clip.title
        .replace(/[^a-zA-Z0-9-_ ]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 60) || 'ClipGenius_Clip';
    const resTag = clip.lastExportConfig?.resolution ?? '1080p';
    res.download(fullPath, `${safeTitle}_${resTag}.mp4`);
  });

  // Queue real FFmpeg render for a single clip
  app.post('/api/projects/:id/clips/:clipId/export', (req, res) => {
    const project = store.getProject(req.params.id);
    const clip = project?.clips.find((c) => c.id === req.params.clipId);
    if (!project || !clip) return res.status(404).json({ error: 'Clip not found.' });

    const settings = store.getSettings();
    const body = (req.body ?? {}) as Partial<ExportOptions>;
    const options: ExportOptions = {
      resolution: body.resolution ?? settings.defaultExportResolution,
      codec: body.codec ?? settings.defaultExportCodec,
      fps: body.fps ?? settings.defaultExportFps,
      quality: body.quality ?? 'excellent',
      embedCaptions: body.embedCaptions ?? true,
      includeMusic: body.includeMusic ?? true,
    };

    const job: ExportJob = {
      id: uuidv4(),
      projectId: project.id,
      clipId: clip.id,
      clipTitle: clip.title,
      status: 'queued',
      progress: 0,
      options,
      createdAt: new Date().toISOString(),
    };
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
        progress: 0,
        options,
        createdAt: new Date().toISOString(),
      };
      store.upsertExportJob(job);
      renderQueue.push({ projectId: project.id, clipId: clip.id, jobId: job.id, options });
      return job;
    });

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

  // Download all rendered clips for a project as a real ZIP bundle
  app.get('/api/projects/:id/download-zip', async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found.' });

    const renderedCount = project.clips.filter((c) => c.renderedVideoUrl).length;
    if (renderedCount === 0) {
      return res.status(400).json({ error: 'No clips have been rendered yet. Render clips first before downloading ZIP.' });
    }

    const safeProjName = project.name.replace(/[^a-zA-Z0-9-_ ]/g, '').trim() || 'clipgenius_export';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeProjName}_clips.zip"`);

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
  app.use('/api', (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status =
      typeof err === 'object' && err && 'status' in err && typeof (err as { status: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const message = err instanceof Error ? err.message : 'Unexpected server error.';
    if (!res.headersSent) {
      res.status(status).json({ error: message });
    }
  });

  // Mount Vite dev server middleware or serve built dist/
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
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
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipGenius AI server running at http://0.0.0.0:${PORT}`);
  });
}

createServer().catch((err) => {
  console.error('Fatal error starting ClipGenius AI server:', err);
  process.exit(1);
});
