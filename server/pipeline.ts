import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import type {
  ClipRecord,
  PipelineStageKey,
  PipelineStageState,
  ProjectRecord,
  SceneMarker,
  VideoMetadata,
} from '../shared/types.ts';
import {
  createDefaultAudioMix,
  createDefaultFraming,
  createDefaultMotionGraphics,
  getCaptionPreset,
  getVisualStylePreset,
} from '../shared/presets.ts';
import { store } from './store.ts';
import {
  analyzeKeyframesForFraming,
  generateSampleSpokenAudio,
  selectHighlightsWithGemini,
  transcribeAudioChunk,
} from './gemini.ts';

const execFileAsync = promisify(execFile);

const AUDIO_CHUNK_SECONDS = 480; // 8-minute chunks -> supports 5-hour videos (~38 chunks) cleanly

const activePipelines = new Set<string>();

export function createInitialPipelineStages(): PipelineStageState[] {
  return [
    { key: 'probe', label: 'Media Probe & Metadata', status: 'pending', progress: 0, detail: 'Waiting to inspect video streams' },
    { key: 'audio_chunks', label: 'Chunked Audio Extraction', status: 'pending', progress: 0, detail: 'Splits long audio into resumable 8-min chunks' },
    { key: 'signal_analysis', label: 'Silence & Scene Detection', status: 'pending', progress: 0, detail: 'Maps speech pauses and visual cut points' },
    { key: 'transcription', label: 'AI Speech-to-Text Transcription', status: 'pending', progress: 0, detail: 'Generates verbatim timestamped transcript' },
    { key: 'visual_framing', label: 'Speaker & Visual Framing Analysis', status: 'pending', progress: 0, detail: 'Detects active speaker positions for auto-reframe' },
    { key: 'highlight_selection', label: 'Gemini Semantic Highlight Engine', status: 'pending', progress: 0, detail: 'Scores hooks, stories, and standalone clips' },
    { key: 'clip_thumbnails', label: 'Clip Extraction & Thumbnails', status: 'pending', progress: 0, detail: 'Generates clip previews and frame thumbnails' },
  ];
}

function updateStage(
  project: ProjectRecord,
  key: PipelineStageKey,
  patch: Partial<PipelineStageState>
): void {
  const stage = project.pipelineStages.find((s) => s.key === key);
  if (stage) {
    Object.assign(stage, patch, { updatedAt: new Date().toISOString() });
  }
  store.upsertProject(project);
}

function parseDurationValue(raw?: string | number | null): number {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }
  if (!raw || typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toUpperCase() === 'N/A') return 0;
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  // Parse HH:MM:SS.mmm format used in MKV/WebM stream tags
  const parts = trimmed.split(':');
  if (parts.length === 3) {
    const hrs = Number(parts[0]);
    const mins = Number(parts[1]);
    const secs = Number(parts[2]);
    if (Number.isFinite(hrs) && Number.isFinite(mins) && Number.isFinite(secs)) {
      const total = hrs * 3600 + mins * 60 + secs;
      return total > 0 ? total : 0;
    }
  }
  return 0;
}

async function probeDurationFallbackWithFFmpeg(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-i', filePath, '-f', 'null', '-']);
    let lastTime = 0;
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      const matches = text.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g);
      for (const m of matches) {
        const parsed = parseDurationValue(m[1]);
        if (parsed > lastTime) lastTime = parsed;
      }
    });
    proc.on('close', () => resolve(lastTime));
    proc.on('error', () => resolve(0));
  });
}

export async function probeVideoFile(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    { maxBuffer: 25 * 1024 * 1024 }
  );
  const data = JSON.parse(stdout) as {
    format?: {
      duration?: string;
      bit_rate?: string;
      size?: string;
      tags?: Record<string, string>;
    };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      duration?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      tags?: Record<string, string>;
    }>;
  };

  const videoStream = data.streams?.find((s) => s.codec_type === 'video');
  const audioStream = data.streams?.find((s) => s.codec_type === 'audio');

  let duration =
    parseDurationValue(data.format?.duration) ||
    parseDurationValue(videoStream?.duration) ||
    parseDurationValue(audioStream?.duration) ||
    parseDurationValue(videoStream?.tags?.DURATION) ||
    parseDurationValue(videoStream?.tags?.duration) ||
    parseDurationValue(audioStream?.tags?.DURATION) ||
    parseDurationValue(data.format?.tags?.DURATION) ||
    parseDurationValue(data.format?.tags?.duration);

  if (duration <= 0 && videoStream) {
    duration = await probeDurationFallbackWithFFmpeg(filePath);
  }

  let fps = 30;
  const fpsRaw = videoStream?.avg_frame_rate || videoStream?.r_frame_rate || '30/1';
  if (fpsRaw.includes('/')) {
    const [num, den] = fpsRaw.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
      fps = Number((num / den).toFixed(2));
    }
  } else if (Number.isFinite(Number(fpsRaw)) && Number(fpsRaw) > 0) {
    fps = Number(fpsRaw);
  }

  const stat = fs.statSync(filePath);
  const rawBitrate = Number(data.format?.bit_rate || 0);
  return {
    duration: Number.isFinite(duration) ? duration : 0,
    width: videoStream?.width || 1920,
    height: videoStream?.height || 1080,
    fps: Math.min(120, Math.max(10, Number.isFinite(fps) ? fps : 30)),
    codec: videoStream?.codec_name || 'unknown',
    audioCodec: audioStream?.codec_name || 'none',
    bitrate: Number.isFinite(rawBitrate) ? rawBitrate : 0,
    fileSize: stat.size,
  };
}

export async function extractThumbnail(
  videoPath: string,
  outPath: string,
  timestampSeconds: number
): Promise<void> {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const safeTs = Number.isFinite(timestampSeconds) && timestampSeconds > 0 ? timestampSeconds : 0;

  const runThumb = async (ts: number) => {
    await execFileAsync(
      'ffmpeg',
      [
        '-loglevel',
        'error',
        '-y',
        '-ss',
        ts.toFixed(2),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-vf',
        'scale=640:-2',
        outPath,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 30000 }
    );
  };

  try {
    await runThumb(safeTs);
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return;
  } catch {
    // Fallback to frame 0 for short/VFR/MKV/WebM streams where seeking fails
  }

  if (safeTs > 0) {
    await runThumb(0);
  }
}

async function detectSilences(videoPath: string): Promise<Array<{ start: number; end: number }>> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-i',
      videoPath,
      '-af',
      'silencedetect=noise=-32dB:d=0.6',
      '-f',
      'null',
      '-',
    ]);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', () => {
      const silences: Array<{ start: number; end: number }> = [];
      let currentStart: number | null = null;
      for (const line of stderr.split('\n')) {
        const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
        if (startMatch) {
          currentStart = Number(startMatch[1]);
        }
        const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
        if (endMatch && currentStart !== null) {
          silences.push({ start: currentStart, end: Number(endMatch[1]) });
          currentStart = null;
        }
      }
      resolve(silences);
    });
    proc.on('error', () => resolve([]));
  });
}

async function extractSampleKeyframes(
  videoPath: string,
  duration: number,
  outDir: string
): Promise<Array<{ time: number; filePath: string; filename: string }>> {
  fs.mkdirSync(outDir, { recursive: true });
  const targetFrames = Math.min(12, Math.max(4, Math.ceil(duration / 25)));
  const interval = Math.max(1, duration / (targetFrames + 1));
  const results: Array<{ time: number; filePath: string; filename: string }> = [];

  for (let i = 1; i <= targetFrames; i++) {
    const t = Number(Math.min(duration - 0.5, i * interval).toFixed(2));
    if (t < 0) continue;
    const filename = `kf_${String(i).padStart(3, '0')}.jpg`;
    const filePath = path.join(outDir, filename);
    if (!fs.existsSync(filePath)) {
      try {
        await execFileAsync('ffmpeg', [
          '-y',
          '-ss',
          t.toFixed(2),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          'scale=480:-2',
          '-q:v',
          '5',
          filePath,
        ]);
      } catch {
        continue;
      }
    }
    if (fs.existsSync(filePath)) {
      results.push({ time: t, filePath, filename });
    }
  }
  return results;
}

export function isPipelineRunning(projectId: string): boolean {
  return activePipelines.has(projectId);
}

/**
 * Runs or resumes the full multi-stage AI Video Intelligence Pipeline for a project.
 * Every stage checkpoints progress to disk so long videos (up to 5 hours) can resume cleanly.
 */
export async function runAnalysisPipeline(projectId: string): Promise<void> {
  if (activePipelines.has(projectId)) return;
  const project = store.getProject(projectId);
  if (!project || !project.sourcePath || !fs.existsSync(project.sourcePath)) {
    throw new Error('Source video file not found for this project.');
  }

  activePipelines.add(projectId);
  project.status = 'analyzing';
  project.errorMessage = undefined;
  if (!project.pipelineStages || project.pipelineStages.length === 0) {
    project.pipelineStages = createInitialPipelineStages();
  }
  store.upsertProject(project);

  const projectDir = store.getProjectDir(projectId);
  const audioChunksDir = path.join(projectDir, 'audio_chunks');
  const keyframesDir = path.join(projectDir, 'keyframes');
  const clipsDir = path.join(projectDir, 'clips');

  try {
    // STAGE 1: Probe media & extract source thumbnail
    const probeStage = project.pipelineStages.find((s) => s.key === 'probe');
    if (!probeStage || probeStage.status !== 'completed' || !project.metadata) {
      updateStage(project, 'probe', {
        status: 'running',
        progress: 25,
        detail: 'Running FFprobe stream inspection...',
      });
      const meta = await probeVideoFile(project.sourcePath);
      if (meta.duration <= 0) {
        throw new Error('Could not read valid video duration from uploaded file.');
      }
      project.metadata = meta;

      const thumbPath = path.join(projectDir, 'thumb.jpg');
      if (!fs.existsSync(thumbPath)) {
        try {
          await extractThumbnail(project.sourcePath, thumbPath, Math.min(2, meta.duration * 0.15));
        } catch {
          // non-fatal
        }
      }
      project.thumbnailUrl = `/media/projects/${projectId}/thumb.jpg`;
      updateStage(project, 'probe', {
        status: 'completed',
        progress: 100,
        detail: `${meta.width}x${meta.height} · ${meta.fps} FPS · ${Math.round(meta.duration)}s · ${meta.codec.toUpperCase()}`,
      });
    }

    const meta = project.metadata!;

    // STAGE 2: Chunked Audio Extraction (supports 5-hour videos)
    const audioStage = project.pipelineStages.find((s) => s.key === 'audio_chunks');
    fs.mkdirSync(audioChunksDir, { recursive: true });
    let audioChunkFiles: string[] = [];

    if (meta.audioCodec === 'none') {
      project.totalAudioChunks = 0;
      project.completedAudioChunks = 0;
      updateStage(project, 'audio_chunks', {
        status: 'completed',
        progress: 100,
        detail: 'No audio track detected in source video (visual-only mode).',
      });
    } else if (!audioStage || audioStage.status !== 'completed') {
      updateStage(project, 'audio_chunks', {
        status: 'running',
        progress: 15,
        detail: 'Extracting 16kHz mono speech audio into resumable chunks...',
      });
      const expectedChunks = Math.max(1, Math.ceil(meta.duration / AUDIO_CHUNK_SECONDS));
      project.totalAudioChunks = expectedChunks;
      store.upsertProject(project);

      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        project.sourcePath,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '32k',
        '-f',
        'segment',
        '-segment_time',
        String(AUDIO_CHUNK_SECONDS),
        '-reset_timestamps',
        '1',
        path.join(audioChunksDir, 'chunk_%03d.mp3'),
      ]);

      audioChunkFiles = fs
        .readdirSync(audioChunksDir)
        .filter((f) => f.endsWith('.mp3'))
        .sort()
        .map((f) => path.join(audioChunksDir, f));

      project.totalAudioChunks = audioChunkFiles.length;
      project.completedAudioChunks = audioChunkFiles.length;
      updateStage(project, 'audio_chunks', {
        status: 'completed',
        progress: 100,
        detail: `Extracted ${audioChunkFiles.length} audio chunk${audioChunkFiles.length === 1 ? '' : 's'} for scalable AI processing`,
      });
    } else {
      audioChunkFiles = fs
        .readdirSync(audioChunksDir)
        .filter((f) => f.endsWith('.mp3'))
        .sort()
        .map((f) => path.join(audioChunksDir, f));
    }

    // STAGE 3: Silence Detection & Keyframe Sampling
    const signalStage = project.pipelineStages.find((s) => s.key === 'signal_analysis');
    let sampledKeyframes: Array<{ time: number; filePath: string; filename: string }> = [];
    if (!signalStage || signalStage.status !== 'completed') {
      updateStage(project, 'signal_analysis', {
        status: 'running',
        progress: 20,
        detail: 'Analyzing speech pauses and sampling visual keyframes...',
      });
      const silences = meta.audioCodec !== 'none' ? await detectSilences(project.sourcePath) : [];
      project.silences = silences;
      updateStage(project, 'signal_analysis', {
        status: 'running',
        progress: 65,
        detail: `Detected ${silences.length} speech pauses · Extracting scene keyframes...`,
      });
      sampledKeyframes = await extractSampleKeyframes(project.sourcePath, meta.duration, keyframesDir);
      project.scenes = sampledKeyframes.map((kf) => ({
        time: kf.time,
        score: 0.5,
        speakerX: 0.5,
        speakerY: 0.45,
        keyframeUrl: `/media/projects/${projectId}/keyframes/${kf.filename}`,
      }));
      updateStage(project, 'signal_analysis', {
        status: 'completed',
        progress: 100,
        detail: `${silences.length} silence boundaries · ${sampledKeyframes.length} visual keyframes indexed`,
      });
    } else {
      sampledKeyframes = project.scenes
        .map((s, idx) => ({
          time: s.time,
          filename: `kf_${String(idx + 1).padStart(3, '0')}.jpg`,
          filePath: path.join(keyframesDir, `kf_${String(idx + 1).padStart(3, '0')}.jpg`),
        }))
        .filter((k) => fs.existsSync(k.filePath));
    }

    // STAGE 4: Chunked AI Transcription (resumable per chunk!)
    const transcriptStage = project.pipelineStages.find((s) => s.key === 'transcription');
    if (audioChunkFiles.length === 0) {
      updateStage(project, 'transcription', {
        status: 'completed',
        progress: 100,
        detail: 'Skipped transcription (no spoken audio track present)',
      });
    } else if (!transcriptStage || transcriptStage.status !== 'completed') {
      const doneChunks = new Set(project.transcript.map((seg) => seg.chunkIndex));
      for (let i = 0; i < audioChunkFiles.length; i++) {
        if (doneChunks.has(i)) continue;
        const pct = Math.round((i / audioChunkFiles.length) * 100);
        updateStage(project, 'transcription', {
          status: 'running',
          progress: Math.max(5, pct),
          detail: `Transcribing audio chunk ${i + 1} of ${audioChunkFiles.length} with Gemini Speech-to-Text...`,
        });
        const chunkOffset = i * AUDIO_CHUNK_SECONDS;
        const chunkDuration = Math.min(AUDIO_CHUNK_SECONDS, Math.max(1, meta.duration - chunkOffset));
        const res = await transcribeAudioChunk({
          audioPath: audioChunkFiles[i],
          chunkIndex: i,
          chunkOffsetSeconds: chunkOffset,
          chunkDurationSeconds: chunkDuration,
          language: project.analysisConfig.language,
        });
        if (!project.detectedLanguage && res.detectedLanguage) {
          project.detectedLanguage = res.detectedLanguage;
        }
        project.transcript = [...project.transcript, ...res.segments].sort((a, b) => a.start - b.start);
        project.completedTranscriptChunks = i + 1;
        store.upsertProject(project);
      }

      const wordCount = project.transcript.reduce((acc, s) => acc + s.words.length, 0);
      updateStage(project, 'transcription', {
        status: 'completed',
        progress: 100,
        detail: `${project.transcript.length} timestamped segments · ${wordCount} words (${project.detectedLanguage || 'detected'})`,
      });
    }

    // STAGE 5: Visual Framing & Active Speaker Detection
    const framingStage = project.pipelineStages.find((s) => s.key === 'visual_framing');
    if (!framingStage || framingStage.status !== 'completed') {
      updateStage(project, 'visual_framing', {
        status: 'running',
        progress: 35,
        detail: 'Analyzing speaker face coordinates across sampled video frames...',
      });
      const framingPoints = await analyzeKeyframesForFraming(sampledKeyframes);
      const updatedScenes: SceneMarker[] = project.scenes.map((scene) => {
        const closest = framingPoints.reduce<(typeof framingPoints)[number] | null>((best, curr) => {
          if (!best) return curr;
          return Math.abs(curr.time - scene.time) < Math.abs(best.time - scene.time) ? curr : best;
        }, null);
        return {
          ...scene,
          speakerX: closest?.speakerX ?? scene.speakerX ?? 0.5,
          speakerY: closest?.speakerY ?? scene.speakerY ?? 0.45,
          description: closest?.description ?? scene.description,
        };
      });
      project.scenes = updatedScenes;
      updateStage(project, 'visual_framing', {
        status: 'completed',
        progress: 100,
        detail: `Mapped active speaker focal tracks across ${updatedScenes.length} scene points`,
      });
    }

    // STAGE 6: Gemini Semantic Highlight Selection
    const highlightStage = project.pipelineStages.find((s) => s.key === 'highlight_selection');
    if (!highlightStage || highlightStage.status !== 'completed') {
      updateStage(project, 'highlight_selection', {
        status: 'running',
        progress: 40,
        detail: 'Scoring hooks, story arcs, and educational moments with Gemini...',
      });

      const highlights = await selectHighlightsWithGemini({
        transcript: project.transcript,
        scenes: project.scenes,
        videoDuration: meta.duration,
        targetDuration: project.analysisConfig.targetClipDuration,
        desiredCount: project.analysisConfig.clipCount,
      });

      const now = new Date().toISOString();
      const generatedClips: ClipRecord[] = highlights.map((h) => {
        const clipId = uuidv4();
        // Gather focal keyframes inside this clip window
        const localFocalPoints = project.scenes
          .filter((s) => s.time >= h.startTime - 5 && s.time <= h.endTime + 5)
          .map((s) => ({
            time: Math.max(0, Number((s.time - h.startTime).toFixed(2))),
            x: s.speakerX ?? 0.5,
            y: s.speakerY ?? 0.45,
          }));

        const avgX =
          localFocalPoints.length > 0
            ? Number(
                (localFocalPoints.reduce((acc, p) => acc + p.x, 0) / localFocalPoints.length).toFixed(3)
              )
            : 0.5;
        const avgY =
          localFocalPoints.length > 0
            ? Number(
                (localFocalPoints.reduce((acc, p) => acc + p.y, 0) / localFocalPoints.length).toFixed(3)
              )
            : 0.45;

        const framing = createDefaultFraming(
          project.analysisConfig.aspectRatio,
          project.analysisConfig.framingMode
        );
        framing.manualX = avgX;
        framing.manualY = avgY;
        framing.focalKeyframes = localFocalPoints;

        const motion = createDefaultMotionGraphics(
          project.analysisConfig.motionIntensity,
          h.hookTitle,
          h.speakerLabel
        );
        motion.emphasizedKeywords = h.emphasizedKeywords;

        return {
          id: clipId,
          projectId,
          title: h.title,
          description: h.description,
          reasonSelected: h.reasonSelected,
          category: h.category,
          startTime: h.startTime,
          endTime: h.endTime,
          duration: Number((h.endTime - h.startTime).toFixed(2)),
          scores: h.scores,
          editingStatus: 'auto_generated',
          thumbnailUrl: `/media/projects/${projectId}/clips/${clipId}/thumb.jpg`,
          framing,
          captionStyle: getCaptionPreset(project.analysisConfig.captionPresetId),
          colorGrading: getVisualStylePreset(project.analysisConfig.stylePresetId),
          motionGraphics: motion,
          audioMix: createDefaultAudioMix(),
          textOverlays: [],
          createdAt: now,
          updatedAt: now,
        };
      });

      project.clips = generatedClips;
      updateStage(project, 'highlight_selection', {
        status: 'completed',
        progress: 100,
        detail: `Selected ${generatedClips.length} standalone highlight clip${generatedClips.length === 1 ? '' : 's'}`,
      });
    }

    // STAGE 7: Extract real FFmpeg thumbnails for every generated clip
    updateStage(project, 'clip_thumbnails', {
      status: 'running',
      progress: 10,
      detail: 'Generating frame thumbnails for each highlight clip...',
    });
    fs.mkdirSync(clipsDir, { recursive: true });
    for (let i = 0; i < project.clips.length; i++) {
      const clip = project.clips[i];
      const clipThumbPath = path.join(clipsDir, clip.id, 'thumb.jpg');
      if (!fs.existsSync(clipThumbPath)) {
        const sampleTime = clip.startTime + Math.min(2, clip.duration * 0.25);
        await extractThumbnail(project.sourcePath, clipThumbPath, sampleTime);
      }
      updateStage(project, 'clip_thumbnails', {
        status: 'running',
        progress: Math.round(((i + 1) / Math.max(1, project.clips.length)) * 100),
        detail: `Generated thumbnail ${i + 1} of ${project.clips.length}`,
      });
    }

    updateStage(project, 'clip_thumbnails', {
      status: 'completed',
      progress: 100,
      detail: `All ${project.clips.length} clips ready for preview, editing, and export`,
    });

    project.status = 'ready';
    project.errorMessage = undefined;
    store.upsertProject(project);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    project.status = 'failed';
    project.errorMessage = message;
    for (const s of project.pipelineStages) {
      if (s.status === 'running') {
        s.status = 'failed';
        s.detail = message;
      }
    }
    store.upsertProject(project);
  } finally {
    activePipelines.delete(projectId);
  }
}

/**
 * Regenerates a single clip (selecting a fresh section or new target duration) using Gemini.
 */
export async function regenerateSingleClip(params: {
  projectId: string;
  clipId: string;
  targetDuration?: number;
  focusPrompt?: string;
}): Promise<ClipRecord> {
  const project = store.getProject(params.projectId);
  if (!project || !project.metadata || !project.sourcePath) {
    throw new Error('Project or source media not found.');
  }
  const existingIdx = project.clips.findIndex((c) => c.id === params.clipId);
  if (existingIdx < 0) {
    throw new Error('Clip not found.');
  }

  const otherRanges = project.clips
    .filter((c) => c.id !== params.clipId)
    .map((c) => ({ start: c.startTime, end: c.endTime }));

  const highlights = await selectHighlightsWithGemini({
    transcript: project.transcript,
    scenes: project.scenes,
    videoDuration: project.metadata.duration,
    targetDuration: params.targetDuration ?? project.analysisConfig.targetClipDuration,
    desiredCount: 1,
    excludeRanges: otherRanges,
    customFocusPrompt:
      params.focusPrompt || 'Pick a fresh, different compelling moment than the excluded ranges.',
  });

  if (highlights.length === 0) {
    throw new Error('Could not find an alternate non-overlapping highlight in this video.');
  }

  const h = highlights[0];
  const old = project.clips[existingIdx];
  const updated: ClipRecord = {
    ...old,
    title: h.title,
    description: h.description,
    reasonSelected: h.reasonSelected,
    category: h.category,
    startTime: h.startTime,
    endTime: h.endTime,
    duration: Number((h.endTime - h.startTime).toFixed(2)),
    scores: h.scores,
    editingStatus: 'auto_generated',
    renderedVideoUrl: undefined,
    motionGraphics: {
      ...old.motionGraphics,
      hookTitleText: h.hookTitle,
      speakerLabel: h.speakerLabel,
      emphasizedKeywords: h.emphasizedKeywords,
    },
    updatedAt: new Date().toISOString(),
  };

  const thumbPath = path.join(store.getProjectDir(project.id), 'clips', updated.id, 'thumb.jpg');
  await extractThumbnail(project.sourcePath, thumbPath, updated.startTime + Math.min(2, updated.duration * 0.2));
  updated.thumbnailUrl = `/media/projects/${project.id}/clips/${updated.id}/thumb.jpg?t=${Date.now()}`;

  project.clips[existingIdx] = updated;
  store.upsertProject(project);
  return updated;
}

/**
 * Generates a genuine spoken multi-scene MP4 test video on the server using Gemini TTS + FFmpeg
 * so anyone can test the full real upload -> FFmpeg -> Gemini transcription -> highlight -> FFmpeg export workflow immediately.
 */
export async function createRealSampleVideoProject(project: ProjectRecord): Promise<ProjectRecord> {
  const projectDir = store.getProjectDir(project.id);
  const wavPath = path.join(projectDir, 'narration.wav');
  const videoPath = path.join(projectDir, 'source.mp4');

  // Step 1: Synthesize real spoken narration using Gemini TTS
  await generateSampleSpokenAudio(wavPath);

  // Measure actual WAV duration
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    wavPath,
  ]);
  const wavDur = Number((JSON.parse(stdout) as { format?: { duration?: string } }).format?.duration || 35);

  // Step 2: Render a crisp 1280x720 multi-scene studio presentation video synced to the real spoken WAV
  const drawFilters = [
    `color=c=#101320:s=1280x720:r=30:d=${wavDur.toFixed(2)}`,
    `drawbox=x=80:y=80:w=1120:h=560:color=#171B2E@0.95:t=fill`,
    `drawbox=x=80:y=80:w=1120:h=6:color=#8B5CF6@1:t=fill`,
    `drawbox=x=460:y=160:w=360:h=360:color=#222742@0.95:t=fill`,
    `drawbox=x=560:y=220:w=160:h=160:color=#3B82F6@0.85:t=fill`,
    `drawtext=font='DejaVu Sans':text='CREATOR CRAFT PODCAST':x=(w-text_w)/2:y=115:fontsize=26:fontcolor=#A78BFA`,
    `drawtext=font='DejaVu Sans':text='Episode 42 - Short-Form Mastery':x=(w-text_w)/2:y=555:fontsize=30:fontcolor=#F4F5F8`,
    `drawtext=font='DejaVu Sans':text='Lesson 1 - The 2-Second Opening Hook':x=(w-text_w)/2:y=470:fontsize=22:fontcolor=#38BDF8:enable='between(t,7,20)'`,
    `drawtext=font='DejaVu Sans':text='Lesson 2 - Synchronized Visual Captions':x=(w-text_w)/2:y=470:fontsize=22:fontcolor=#38BDF8:enable='between(t,20,33)'`,
    `drawtext=font='DejaVu Sans':text='Lesson 3 - Complete Story Arc & Payoff':x=(w-text_w)/2:y=470:fontsize=22:fontcolor=#38BDF8:enable='gte(t,33)'`,
  ].join(',');

  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    drawFilters,
    '-i',
    wavPath,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-shortest',
    videoPath,
  ]);

  fs.rmSync(wavPath, { force: true });

  const meta = await probeVideoFile(videoPath);
  const thumbPath = path.join(projectDir, 'thumb.jpg');
  await extractThumbnail(videoPath, thumbPath, 2);

  project.sourcePath = videoPath;
  project.sourceUrl = `/media/projects/${project.id}/source.mp4`;
  project.thumbnailUrl = `/media/projects/${project.id}/thumb.jpg`;
  project.fileSize = meta.fileSize;
  project.metadata = meta;
  project.uploadProgress = 100;
  project.status = 'uploaded';
  store.upsertProject(project);
  return project;
}
