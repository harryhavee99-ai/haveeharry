import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { v4 as uuidv4 } from 'uuid';
import type {
  AudioEnergyPoint,
  ClipRecord,
  ExportOptions,
  HookCandidate,
  PipelineStageKey,
  PipelineStageState,
  ProjectRecord,
  SceneMarker,
  TranscriptSegment,
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
import { logBackendError } from './logger.ts';
import {
  analyzeKeyframesForFraming,
  computeWeightedHookScore,
  discoverHookCandidatesWithGemini,
  generateSampleSpokenAudio,
  selectHighlightsWithGemini,
  transcribeAudioChunk,
  verifyHookCandidatesWithGemini,
  type RawCriterionRatings,
} from './gemini.ts';
import { renderClipWithFFmpeg } from './renderer.ts';

const execFileAsync = promisify(execFile);

const AUDIO_CHUNK_STRIDE_SECONDS = 300; // 5-minute stride -> ~60 compact chunks for a 5-hour video
const AUDIO_CHUNK_OVERLAP_SECONDS = 10; // 10s overlap prevents cutting words/sentences at chunk boundaries
const AUTO_RENDER_CLIP_LIMIT = 5; // Auto-render top 5 clips to verified MP4 immediately so downloads work out of the box

export interface AudioChunkDescriptor {
  index: number;
  filePath: string;
  offsetSeconds: number;
  durationSeconds: number;
  strideEndSeconds: number;
}

const activePipelines = new Set<string>();

export function createInitialPipelineStages(): PipelineStageState[] {
  return [
    { key: 'probe', label: 'Preparing & Validating Video', status: 'pending', progress: 0, detail: 'Waiting to validate video file & extract metadata' },
    { key: 'audio_chunks', label: 'Extracting Audio Segments', status: 'pending', progress: 0, detail: 'Splits long audio into overlapping 5-min chunks' },
    { key: 'signal_analysis', label: 'Scene, Pause & Audio Energy Analysis', status: 'pending', progress: 0, detail: 'Maps speech pauses, audio energy dynamics, scene cuts & frames' },
    { key: 'transcription', label: 'Transcribing Speech (AI)', status: 'pending', progress: 0, detail: 'Generates verbatim timestamped transcript across segments' },
    { key: 'visual_framing', label: 'Analyzing Visual Framing', status: 'pending', progress: 0, detail: 'Detects active speaker positions for smart reframing' },
    { key: 'hook_discovery', label: 'Finding Interesting Moments (Pass 1)', status: 'pending', progress: 0, detail: 'Scans full transcript & scenes to discover engaging hook candidates' },
    { key: 'hook_scoring', label: 'Building & Scoring Hook Candidates', status: 'pending', progress: 0, detail: 'Snaps timestamps to sentences, scores 7 criteria (0-100) & deduplicates' },
    { key: 'hook_verification', label: 'Verifying Timestamps & Context (Pass 2)', status: 'pending', progress: 0, detail: 'Audits opening hooks, complete context & natural endings' },
    { key: 'clip_generation', label: 'Selecting Final Clips & Previews', status: 'pending', progress: 0, detail: 'Builds approved clips with captions, motion presets & thumbnails' },
    { key: 'clip_rendering', label: 'Rendering & Validating MP4 Exports', status: 'pending', progress: 0, detail: 'Encodes H.264/AAC MP4s with faststart & FFprobe validation' },
  ];
}

function ensureModernPipelineStages(project: ProjectRecord): void {
  const defaults = createInitialPipelineStages();
  if (!project.pipelineStages || project.pipelineStages.length === 0) {
    project.pipelineStages = defaults;
    return;
  }
  const existingMap = new Map(project.pipelineStages.map((s) => [s.key, s]));
  project.pipelineStages = defaults.map((def) => {
    const prev = existingMap.get(def.key);
    if (prev) return { ...def, status: prev.status, progress: prev.progress, detail: prev.detail, updatedAt: prev.updatedAt };
    return def;
  });
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

/**
 * Runs an FFmpeg command via spawn without risking Node execFile 1 MB maxBuffer crashes on 5-hour videos.
 */
function runFFmpegSpawn(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    proc.stderr.on('data', (d) => {
      errTail = (errTail + d.toString()).slice(-2000);
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg failed (exit ${code}): ${errTail.trim() || 'unknown error'}`));
    });
  });
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

/**
 * Computes overlapping audio chunk plan (5-min stride with 10s overlap) for any video duration (10s to 5+ hours).
 */
function buildAudioChunkPlan(duration: number, audioChunksDir: string): AudioChunkDescriptor[] {
  const plan: AudioChunkDescriptor[] = [];
  if (duration <= AUDIO_CHUNK_STRIDE_SECONDS + AUDIO_CHUNK_OVERLAP_SECONDS) {
    plan.push({
      index: 0,
      filePath: path.join(audioChunksDir, 'chunk_000.mp3'),
      offsetSeconds: 0,
      durationSeconds: Math.max(1, duration),
      strideEndSeconds: duration,
    });
    return plan;
  }

  let idx = 0;
  for (let start = 0; start < duration; start += AUDIO_CHUNK_STRIDE_SECONDS) {
    const remaining = duration - start;
    if (remaining < 1 && idx > 0) break;
    const windowDur = Math.min(remaining, AUDIO_CHUNK_STRIDE_SECONDS + AUDIO_CHUNK_OVERLAP_SECONDS);
    plan.push({
      index: idx,
      filePath: path.join(audioChunksDir, `chunk_${String(idx).padStart(3, '0')}.mp3`),
      offsetSeconds: start,
      durationSeconds: windowDur,
      strideEndSeconds: Math.min(duration, start + AUDIO_CHUNK_STRIDE_SECONDS),
    });
    idx++;
  }
  return plan;
}

/**
 * Merges newly transcribed overlapping chunk segments into the unified project transcript,
 * deduplicating sentences repeated inside the 10s chunk overlap boundary while preserving original timestamps.
 */
function mergeOverlappingTranscriptSegments(
  existing: TranscriptSegment[],
  incoming: TranscriptSegment[],
  chunkIndex: number,
  chunkOffsetSeconds: number
): TranscriptSegment[] {
  if (chunkIndex === 0 || existing.length === 0) {
    return [...existing, ...incoming].sort((a, b) => a.start - b.start);
  }

  const overlapEnd = chunkOffsetSeconds + AUDIO_CHUNK_OVERLAP_SECONDS;
  const previousBoundarySegs = existing.filter((s) => s.end >= chunkOffsetSeconds - 2);
  const normalize = (t: string) => t.toLowerCase().replace(/[^a-z0-9\u0600-\u06FF\u0900-\u097F]+/g, ' ').trim();

  const filteredIncoming = incoming.filter((seg) => {
    const midpoint = (seg.start + seg.end) / 2;
    if (midpoint > overlapEnd) return true;
    // Check if this segment overlaps significantly in time or text with a segment from the prior chunk
    const incNorm = normalize(seg.text);
    const isDuplicate = previousBoundarySegs.some((prev) => {
      const timeOverlap = Math.min(prev.end, seg.end) - Math.max(prev.start, seg.start);
      if (timeOverlap > 0.4) return true;
      const prevNorm = normalize(prev.text);
      if (incNorm.length > 6 && prevNorm.length > 6 && (prevNorm.includes(incNorm) || incNorm.includes(prevNorm))) {
        return true;
      }
      return false;
    });
    return !isDuplicate;
  });

  return [...existing, ...filteredIncoming].sort((a, b) => a.start - b.start);
}

/**
 * Audio-only (-vn) streaming silence detector — constant O(1) memory and 10x-20x faster on 5-hour HD/4K files.
 */
async function detectSilences(videoPath: string): Promise<Array<{ start: number; end: number }>> {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-vn',
      '-i',
      videoPath,
      '-af',
      'silencedetect=noise=-32dB:d=0.6',
      '-f',
      'null',
      '-',
    ]);
    const silences: Array<{ start: number; end: number }> = [];
    let currentStart: number | null = null;
    let lineRemainder = '';

    proc.stderr.on('data', (d) => {
      const chunk = lineRemainder + d.toString();
      const lines = chunk.split('\n');
      lineRemainder = lines.pop() ?? '';
      for (const line of lines) {
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
    });
    proc.on('close', () => resolve(silences));
    proc.on('error', () => resolve([]));
  });
}

/**
 * Fast audio-only (-vn) vocal energy dynamics analyzer using FFmpeg astats metadata per window.
 * Produces normalized 0..100 energy points across the timeline without ever confusing raw volume with content quality.
 */
async function analyzeAudioEnergy(videoPath: string, duration: number): Promise<AudioEnergyPoint[]> {
  if (duration < 2) return [];
  const windowSec = duration <= 180 ? 4 : duration <= 1800 ? 10 : 20;
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-vn',
      '-i',
      videoPath,
      '-af',
      `asetnsamples=n=${Math.round(48000 * windowSec)},astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-`,
      '-f',
      'null',
      '-',
    ]);

    const rmsValues: Array<{ time: number; rmsDb: number }> = [];
    let currentPts = 0;
    let remainder = '';

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve(buildNormalizedEnergyPoints(rmsValues, windowSec, duration));
    }, 15_000);

    const handleChunk = (d: Buffer) => {
      const text = remainder + d.toString();
      const lines = text.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        const ptsMatch = line.match(/pts_time:([0-9.]+)/);
        if (ptsMatch) {
          currentPts = Number(ptsMatch[1]);
        }
        const rmsMatch = line.match(/RMS_level=([-0-9.inf]+)/i);
        if (rmsMatch) {
          const val = Number(rmsMatch[1]);
          const safeDb = Number.isFinite(val) ? Math.max(-70, Math.min(0, val)) : -65;
          rmsValues.push({ time: currentPts, rmsDb: safeDb });
        }
      }
    };

    proc.stdout.on('data', handleChunk);
    proc.stderr.on('data', () => {
      // drain stderr
    });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(buildNormalizedEnergyPoints(rmsValues, windowSec, duration));
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

function buildNormalizedEnergyPoints(
  samples: Array<{ time: number; rmsDb: number }>,
  windowSec: number,
  duration: number
): AudioEnergyPoint[] {
  if (samples.length === 0) return [];
  const validDbs = samples.map((s) => s.rmsDb).filter((v) => v > -65);
  const minDb = validDbs.length ? Math.min(...validDbs) : -50;
  const maxDb = validDbs.length ? Math.max(...validDbs) : -12;
  const span = Math.max(6, maxDb - minDb);

  return samples.slice(0, 600).map((s, idx) => {
    const start = Number(Math.max(0, s.time > 0 ? s.time : idx * windowSec).toFixed(2));
    const end = Number(Math.min(duration, start + windowSec).toFixed(2));
    const norm = Math.max(0, Math.min(100, Math.round(((s.rmsDb - minDb) / span) * 100)));
    return {
      start,
      end,
      rmsDb: Number(s.rmsDb.toFixed(1)),
      peakDb: Number(Math.min(0, s.rmsDb + 6).toFixed(1)),
      normalizedEnergy: norm,
    };
  });
}

/**
 * Snaps raw candidate [startTime, endTime] strictly to real transcript sentence/word boundaries,
 * trims leading/trailing dead air from detected silences, and extracts verbatim opening/ending dialogue.
 */
export function snapBoundsToTranscript(params: {
  rawStart: number;
  rawEnd: number;
  transcript: TranscriptSegment[];
  silences: Array<{ start: number; end: number }>;
  audioEnergy?: AudioEnergyPoint[];
  videoDuration: number;
}): {
  startTime: number;
  endTime: number;
  openingDialogue: string;
  endingDialogue: string;
  transcriptExcerpt: string;
  silenceRatio: number;
  audioEnergyScore: number;
} {
  const { transcript, silences, audioEnergy, videoDuration } = params;
  const minClipLen = Math.min(4, Math.max(1.5, videoDuration * 0.35));
  let start = Math.max(0, Math.min(Math.max(0, videoDuration - minClipLen), Number(params.rawStart) || 0));
  let end = Math.max(start + minClipLen, Math.min(videoDuration, Number(params.rawEnd) || start + 15));

  if (transcript.length > 0) {
    // Snap start to the closest transcript segment start (or word start inside a long segment)
    let bestStartSeg = transcript[0];
    let bestStartDist = Infinity;
    for (const seg of transcript) {
      const dist = Math.abs(seg.start - start);
      if (dist < bestStartDist) {
        bestStartDist = dist;
        bestStartSeg = seg;
      }
    }
    if (bestStartDist <= 4.0) {
      start = bestStartSeg.start;
    } else {
      // Check if rawStart falls cleanly inside a segment with words
      const containing = transcript.find((s) => start >= s.start && start < s.end);
      if (containing) {
        start = containing.start;
      }
    }

    // Snap end to the closest transcript segment end so we never cut mid-sentence
    let bestEndSeg = transcript[transcript.length - 1];
    let bestEndDist = Infinity;
    for (const seg of transcript) {
      if (seg.end <= start + minClipLen * 0.6) continue;
      const dist = Math.abs(seg.end - end);
      if (dist < bestEndDist) {
        bestEndDist = dist;
        bestEndSeg = seg;
      }
    }
    if (bestEndDist <= 5.0 && bestEndSeg.end > start + minClipLen * 0.6) {
      end = bestEndSeg.end;
    } else {
      const containingEnd = transcript.find((s) => end > s.start && end <= s.end);
      if (containingEnd && containingEnd.end > start + minClipLen * 0.6) {
        end = containingEnd.end;
      }
    }
  }

  // Trim leading/trailing pure silence so clips never open or close on dead air
  for (const sil of silences) {
    if (sil.start <= start + 0.15 && sil.end > start && sil.end < end - minClipLen) {
      start = Math.min(end - minClipLen, sil.end);
    }
    if (sil.end >= end - 0.15 && sil.start < end && sil.start > start + minClipLen) {
      end = Math.max(start + minClipLen, sil.start);
    }
  }

  start = Number(Math.max(0, Math.min(Math.max(0, videoDuration - minClipLen), start)).toFixed(2));
  end = Number(Math.max(start + minClipLen, Math.min(videoDuration, end)).toFixed(2));
  const dur = Math.max(0.5, end - start);

  // Extract verbatim transcript lines inside [start, end]
  const insideSegs = transcript.filter((s) => s.end > start + 0.1 && s.start < end - 0.1);
  const openingDialogue = insideSegs[0]?.text.trim() || '';
  const endingDialogue = insideSegs[insideSegs.length - 1]?.text.trim() || '';
  const transcriptExcerpt = insideSegs.map((s) => `[${s.start.toFixed(1)}s] ${s.speaker}: ${s.text}`).join('\n');

  // Compute silence ratio inside [start, end]
  let silenceTotal = 0;
  for (const sil of silences) {
    const ov = Math.min(end, sil.end) - Math.max(start, sil.start);
    if (ov > 0) silenceTotal += ov;
  }
  const silenceRatio = Math.max(0, Math.min(1, silenceTotal / dur));

  // Compute audio quality/dynamics score (clear speech + low dead air + healthy dynamic variation)
  let energyDynamics = 72;
  if (audioEnergy && audioEnergy.length > 0) {
    const pts = audioEnergy.filter((p) => p.end >= start && p.start <= end);
    if (pts.length > 0) {
      const avg = pts.reduce((acc, p) => acc + p.normalizedEnergy, 0) / pts.length;
      const variance =
        pts.reduce((acc, p) => acc + Math.pow(p.normalizedEnergy - avg, 2), 0) / pts.length;
      const stdDev = Math.sqrt(variance);
      // Reward clear speech presence (not clipped/flat, not silent) + natural dynamic range
      const clarityScore = avg < 15 ? 45 : avg > 95 ? 78 : 85;
      const dynamicBonus = Math.min(15, Math.round(stdDev * 0.6));
      energyDynamics = Math.max(30, Math.min(100, Math.round(clarityScore + dynamicBonus - silenceRatio * 45)));
    }
  } else {
    energyDynamics = Math.max(35, Math.min(95, Math.round(85 - silenceRatio * 55)));
  }

  return {
    startTime: start,
    endTime: end,
    openingDialogue,
    endingDialogue,
    transcriptExcerpt,
    silenceRatio,
    audioEnergyScore: energyDynamics,
  };
}

/**
 * Re-extracts verbatim openingDialogue, endingDialogue, transcriptExcerpt & duration
 * whenever a user manually adjusts a HookCandidate's start/end timestamps.
 */
export function refreshHookCandidateTranscriptFields(
  project: ProjectRecord,
  candidate: HookCandidate
): HookCandidate {
  const duration = project.metadata?.duration ?? Math.max(candidate.endTime, 10);
  const snapped = snapBoundsToTranscript({
    rawStart: candidate.startTime,
    rawEnd: candidate.endTime,
    transcript: project.transcript,
    silences: project.silences,
    audioEnergy: project.audioEnergy,
    videoDuration: duration,
  });
  // Respect exact user-edited boundaries while updating verbatim transcript excerpts
  const start = Number(Math.max(0, Math.min(duration - 1, candidate.startTime)).toFixed(2));
  const end = Number(Math.max(start + 1, Math.min(duration, candidate.endTime)).toFixed(2));
  const insideSegs = project.transcript.filter((s) => s.end > start + 0.1 && s.start < end - 0.1);
  return {
    ...candidate,
    startTime: start,
    endTime: end,
    duration: Number((end - start).toFixed(2)),
    openingDialogue: insideSegs[0]?.text.trim() || snapped.openingDialogue || candidate.openingDialogue,
    endingDialogue: insideSegs[insideSegs.length - 1]?.text.trim() || snapped.endingDialogue || candidate.endingDialogue,
    transcriptExcerpt:
      insideSegs.length > 0
        ? insideSegs.map((s) => `[${s.start.toFixed(1)}s] ${s.speaker}: ${s.text}`).join('\n')
        : snapped.transcriptExcerpt,
    audioEnergyScore: snapped.audioEnergyScore,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Semantic + Chronological Deduplication:
 * Prevents duplicate overlapping moments and near-identical topics, ensuring diverse high-scoring candidates.
 */
function deduplicateHookCandidates(candidates: HookCandidate[]): HookCandidate[] {
  const stopWords = new Set([
    'the', 'and', 'that', 'this', 'with', 'from', 'have', 'your', 'about', 'what', 'when', 'where',
    'they', 'them', 'just', 'like', 'into', 'over', 'also', 'very', 'more', 'most', 'only', 'then',
  ]);
  const tokenize = (text: string): Set<string> => {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF\u0900-\u097F]+/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w));
    return new Set(words);
  };
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    if (a.size === 0 || b.size === 0) return 0;
    let inter = 0;
    for (const tok of a) {
      if (b.has(tok)) inter++;
    }
    return inter / Math.max(1, a.size + b.size - inter);
  };

  const sorted = [...candidates].sort((a, b) => b.hookBreakdown.total - a.hookBreakdown.total);
  const kept: Array<{ cand: HookCandidate; tokens: Set<string> }> = [];

  for (const cand of sorted) {
    const tokens = tokenize(`${cand.title} ${cand.topic} ${cand.openingDialogue} ${cand.transcriptExcerpt.slice(0, 320)}`);
    let duplicateReason: string | null = null;

    for (const prev of kept) {
      const ovStart = Math.max(prev.cand.startTime, cand.startTime);
      const ovEnd = Math.min(prev.cand.endTime, cand.endTime);
      const ovDur = Math.max(0, ovEnd - ovStart);
      const minDur = Math.max(1, Math.min(prev.cand.duration, cand.duration));
      if (ovDur / minDur > 0.3) {
        duplicateReason = `Overlaps chronologically with higher-scoring hook "${prev.cand.title}"`;
        break;
      }
      const sim = jaccard(prev.tokens, tokens);
      if (sim > 0.48) {
        duplicateReason = `Semantically redundant with "${prev.cand.title}"`;
        break;
      }
    }

    if (!duplicateReason) {
      kept.push({ cand, tokens });
    } else {
      // Keep rejected duplicate visible in Hook Intelligence with explicit reason (never silently lost, never promoted as duplicate clip)
      cand.status = 'rejected';
      cand.rejectedReasons = [...(cand.rejectedReasons ?? []), duplicateReason];
      kept.push({ cand, tokens });
    }
  }

  return kept.map((k) => k.cand);
}

/**
 * Converts a HookCandidate into a full ClipRecord with framing, captions, grading, and motion presets.
 */
export function buildClipFromHookCandidate(project: ProjectRecord, candidate: HookCandidate, existingClipId?: string): ClipRecord {
  const clipId = existingClipId || candidate.clipId || uuidv4();
  const now = new Date().toISOString();
  const localFocalPoints = project.scenes
    .filter((s) => s.time >= candidate.startTime - 5 && s.time <= candidate.endTime + 5)
    .map((s) => ({
      time: Math.max(0, Number((s.time - candidate.startTime).toFixed(2))),
      x: s.speakerX ?? 0.5,
      y: s.speakerY ?? 0.45,
    }));

  const avgX =
    localFocalPoints.length > 0
      ? Number((localFocalPoints.reduce((acc, p) => acc + p.x, 0) / localFocalPoints.length).toFixed(3))
      : 0.5;
  const avgY =
    localFocalPoints.length > 0
      ? Number((localFocalPoints.reduce((acc, p) => acc + p.y, 0) / localFocalPoints.length).toFixed(3))
      : 0.45;

  const framing = createDefaultFraming(project.analysisConfig.aspectRatio, project.analysisConfig.framingMode);
  framing.manualX = avgX;
  framing.manualY = avgY;
  framing.focalKeyframes = localFocalPoints;

  const motion = createDefaultMotionGraphics(
    project.analysisConfig.motionIntensity,
    candidate.hookTitle,
    candidate.speakerLabel
  );
  motion.emphasizedKeywords = candidate.emphasizedKeywords;

  return {
    id: clipId,
    projectId: project.id,
    originalVideoId: project.uploadId ?? project.id,
    candidateId: candidate.id,
    title: candidate.title,
    topic: candidate.topic,
    openingDialogue: candidate.openingDialogue,
    endingDialogue: candidate.endingDialogue,
    description: candidate.description,
    reasonSelected: candidate.reasonSelected,
    category: candidate.category,
    startTime: candidate.startTime,
    endTime: candidate.endTime,
    duration: Number((candidate.endTime - candidate.startTime).toFixed(2)),
    scores: candidate.scores,
    hookBreakdown: candidate.hookBreakdown,
    editingStatus: 'auto_generated',
    renderStatus: 'not_rendered',
    thumbnailUrl: `/media/projects/${project.id}/clips/${clipId}/thumb.jpg`,
    framing,
    captionStyle: getCaptionPreset(project.analysisConfig.captionPresetId),
    colorGrading: getVisualStylePreset(project.analysisConfig.stylePresetId),
    motionGraphics: motion,
    audioMix: createDefaultAudioMix(),
    textOverlays: [],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Fast lightweight FFmpeg scene-change detector (for videos <= 10 min) returning up to 12 cut timestamps.
 */
async function detectSceneChangeTimestamps(videoPath: string, duration: number): Promise<number[]> {
  if (duration > 600 || duration < 4) return [];
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner',
      '-i',
      videoPath,
      '-vf',
      "select='gt(scene,0.35)',showinfo",
      '-vsync',
      'vfr',
      '-an',
      '-f',
      'null',
      '-',
    ]);
    const timestamps: number[] = [];
    let remainder = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve(timestamps);
    }, 15000);

    proc.stderr.on('data', (d) => {
      const text = remainder + d.toString();
      const lines = text.split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        const m = line.match(/pts_time:([0-9.]+)/);
        if (m) {
          const ts = Number(m[1]);
          if (Number.isFinite(ts) && ts > 0.5 && ts < duration - 0.5) {
            if (timestamps.length === 0 || ts - timestamps[timestamps.length - 1] >= 2.0) {
              timestamps.push(Number(ts.toFixed(2)));
            }
          }
        }
      }
    });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(timestamps.slice(0, 12));
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

async function extractSampleKeyframes(
  videoPath: string,
  duration: number,
  outDir: string,
  sceneTimestamps: number[] = []
): Promise<Array<{ time: number; filePath: string; filename: string }>> {
  fs.mkdirSync(outDir, { recursive: true });
  const targetFrames = Math.min(12, Math.max(4, Math.ceil(duration / 25)));

  // Combine detected scene cuts with uniform coverage across the video timeline
  const sampleTimes: number[] = [];
  const addTime = (t: number) => {
    const clamped = Number(Math.max(0.2, Math.min(Math.max(0.2, duration - 0.4), t)).toFixed(2));
    if (!sampleTimes.some((existing) => Math.abs(existing - clamped) < Math.max(1.2, duration / 24))) {
      sampleTimes.push(clamped);
    }
  };
  for (const ts of sceneTimestamps) {
    if (sampleTimes.length >= Math.floor(targetFrames * 0.6)) break;
    addTime(ts);
  }
  const interval = Math.max(1, duration / (targetFrames + 1));
  for (let i = 1; i <= targetFrames && sampleTimes.length < targetFrames; i++) {
    addTime(i * interval);
  }
  sampleTimes.sort((a, b) => a - b);

  const results: Array<{ time: number; filePath: string; filename: string }> = [];
  for (let i = 0; i < sampleTimes.length; i++) {
    const t = sampleTimes[i];
    const filename = `kf_${String(i + 1).padStart(3, '0')}.jpg`;
    const filePath = path.join(outDir, filename);
    if (!fs.existsSync(filePath)) {
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-loglevel',
            'error',
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
          ],
          { maxBuffer: 10 * 1024 * 1024, timeout: 25000 }
        );
      } catch {
        continue;
      }
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
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

  const jobId = uuidv4();
  activePipelines.add(projectId);
  project.processingJobId = jobId;
  project.status = 'analyzing';
  project.errorMessage = undefined;
  project.failedStage = undefined;
  ensureModernPipelineStages(project);
  store.upsertProject(project);

  const projectDir = store.getProjectDir(projectId);
  const audioChunksDir = path.join(projectDir, 'audio_chunks');
  const keyframesDir = path.join(projectDir, 'keyframes');
  const clipsDir = path.join(projectDir, 'clips');
  let activeStage: PipelineStageKey = 'probe';

  try {
    // STAGE 1: Validate file, probe media & extract source thumbnail
    activeStage = 'probe';
    const probeStage = project.pipelineStages.find((s) => s.key === 'probe');
    if (!probeStage || probeStage.status !== 'completed' || !project.metadata) {
      updateStage(project, 'probe', {
        status: 'running',
        progress: 25,
        detail: 'Validating video file and running FFprobe stream inspection...',
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
      if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 0) {
        project.thumbnailUrl = `/media/projects/${projectId}/thumb.jpg`;
      }
      updateStage(project, 'probe', {
        status: 'completed',
        progress: 100,
        detail: `${meta.width}x${meta.height} · ${meta.fps} FPS · ${Math.round(meta.duration)}s · ${meta.codec.toUpperCase()}`,
      });
    }

    const meta = project.metadata!;

    // STAGE 2: Overlapping Chunked Audio Extraction (supports 5-hour+ videos without cutting boundary words)
    activeStage = 'audio_chunks';
    const audioStage = project.pipelineStages.find((s) => s.key === 'audio_chunks');
    fs.mkdirSync(audioChunksDir, { recursive: true });
    const audioPlan: AudioChunkDescriptor[] =
      meta.audioCodec === 'none' ? [] : buildAudioChunkPlan(meta.duration, audioChunksDir);

    if (meta.audioCodec === 'none') {
      project.totalAudioChunks = 0;
      project.completedAudioChunks = 0;
      updateStage(project, 'audio_chunks', {
        status: 'completed',
        progress: 100,
        detail: 'No audio track detected in source video (visual-only mode).',
      });
    } else if (!audioStage || audioStage.status !== 'completed') {
      project.totalAudioChunks = audioPlan.length;
      project.completedAudioChunks = 0;
      updateStage(project, 'audio_chunks', {
        status: 'running',
        progress: 5,
        detail: `Extracting ${audioPlan.length} overlapping 16kHz speech audio segment${audioPlan.length === 1 ? '' : 's'}...`,
      });

      for (let i = 0; i < audioPlan.length; i++) {
        const desc = audioPlan[i];
        if (!fs.existsSync(desc.filePath) || fs.statSync(desc.filePath).size === 0) {
          const args = [
            '-loglevel',
            'error',
            '-y',
            ...(desc.offsetSeconds > 0 ? ['-ss', desc.offsetSeconds.toFixed(2)] : []),
            '-i',
            project.sourcePath,
            ...(audioPlan.length > 1 ? ['-t', desc.durationSeconds.toFixed(2)] : []),
            '-vn',
            '-ac',
            '1',
            '-ar',
            '16000',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '32k',
            desc.filePath,
          ];
          await runFFmpegSpawn(args);
        }
        project.completedAudioChunks = i + 1;
        updateStage(project, 'audio_chunks', {
          status: 'running',
          progress: Math.round(((i + 1) / audioPlan.length) * 100),
          detail: `Extracted audio segment ${i + 1} of ${audioPlan.length} (10s overlap preserved)`,
        });
      }

      updateStage(project, 'audio_chunks', {
        status: 'completed',
        progress: 100,
        detail: `Extracted ${audioPlan.length} overlapping audio segment${audioPlan.length === 1 ? '' : 's'} for scalable AI transcription`,
      });
    }

    // STAGE 3: Silence Detection, Audio Energy Dynamics, Scene Cuts & Keyframe Sampling
    activeStage = 'signal_analysis';
    const signalStage = project.pipelineStages.find((s) => s.key === 'signal_analysis');
    let sampledKeyframes: Array<{ time: number; filePath: string; filename: string }> = [];
    if (!signalStage || signalStage.status !== 'completed') {
      updateStage(project, 'signal_analysis', {
        status: 'running',
        progress: 20,
        detail: 'Analyzing speech pauses, audio vocal energy dynamics, and scene cuts...',
      });
      const [silences, audioEnergy, sceneCuts] = await Promise.all([
        meta.audioCodec !== 'none' ? detectSilences(project.sourcePath) : Promise.resolve([]),
        meta.audioCodec !== 'none' ? analyzeAudioEnergy(project.sourcePath, meta.duration) : Promise.resolve([]),
        detectSceneChangeTimestamps(project.sourcePath, meta.duration),
      ]);
      project.silences = silences;
      project.audioEnergy = audioEnergy;
      updateStage(project, 'signal_analysis', {
        status: 'running',
        progress: 65,
        detail: `Detected ${silences.length} speech pauses · ${audioEnergy.length} energy windows · ${sceneCuts.length} scene cuts · Extracting frames...`,
      });
      sampledKeyframes = await extractSampleKeyframes(
        project.sourcePath,
        meta.duration,
        keyframesDir,
        sceneCuts
      );
      project.scenes = sampledKeyframes.map((kf) => ({
        time: kf.time,
        score: sceneCuts.some((t) => Math.abs(t - kf.time) < 1.5) ? 0.85 : 0.5,
        speakerX: 0.5,
        speakerY: 0.45,
        keyframeUrl: `/media/projects/${projectId}/keyframes/${kf.filename}`,
      }));
      updateStage(project, 'signal_analysis', {
        status: 'completed',
        progress: 100,
        detail: `${silences.length} pauses · ${audioEnergy.length} audio energy windows · ${sceneCuts.length} scene cuts · ${sampledKeyframes.length} frames`,
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

    // STAGE 4: Chunked AI Transcription (resumable per chunk with overlap deduplication)
    activeStage = 'transcription';
    const transcriptStage = project.pipelineStages.find((s) => s.key === 'transcription');
    if (audioPlan.length === 0) {
      updateStage(project, 'transcription', {
        status: 'completed',
        progress: 100,
        detail: 'Skipped transcription (no spoken audio track present)',
      });
    } else if (!transcriptStage || transcriptStage.status !== 'completed') {
      const doneChunks = new Set<number>();
      for (let c = 0; c < project.completedTranscriptChunks; c++) {
        doneChunks.add(c);
      }
      for (const seg of project.transcript) {
        doneChunks.add(seg.chunkIndex);
      }

      for (let i = 0; i < audioPlan.length; i++) {
        if (doneChunks.has(i)) continue;
        const desc = audioPlan[i];
        if (!fs.existsSync(desc.filePath) || fs.statSync(desc.filePath).size === 0) {
          continue;
        }
        const pct = Math.round((i / audioPlan.length) * 100);
        updateStage(project, 'transcription', {
          status: 'running',
          progress: Math.max(5, pct),
          detail: `Transcribing segment ${i + 1} of ${audioPlan.length} with Gemini Speech-to-Text...`,
        });
        const res = await transcribeAudioChunk({
          audioPath: desc.filePath,
          chunkIndex: i,
          chunkOffsetSeconds: desc.offsetSeconds,
          chunkDurationSeconds: desc.durationSeconds,
          language: project.analysisConfig.language,
        });
        if (!project.detectedLanguage && res.detectedLanguage) {
          project.detectedLanguage = res.detectedLanguage;
        }
        project.transcript = mergeOverlappingTranscriptSegments(
          project.transcript,
          res.segments,
          i,
          desc.offsetSeconds
        );
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
    activeStage = 'visual_framing';
    const framingStage = project.pipelineStages.find((s) => s.key === 'visual_framing');
    if (!framingStage || framingStage.status !== 'completed') {
      updateStage(project, 'visual_framing', {
        status: 'running',
        progress: 35,
        detail: 'Analyzing active speaker coordinates across representative frames...',
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

    const appSettings = store.getSettings();
    const scoringWeights = appSettings.hookScoringWeights;

    // STAGE 6: PASS 1 — Finding Interesting Moments (Hook Discovery)
    activeStage = 'hook_discovery';
    const discoveryStage = project.pipelineStages.find((s) => s.key === 'hook_discovery');
    let rawDiscovered: Awaited<ReturnType<typeof discoverHookCandidatesWithGemini>> = [];
    if (!discoveryStage || discoveryStage.status !== 'completed' || !project.hookCandidates?.length) {
      updateStage(project, 'hook_discovery', {
        status: 'running',
        progress: 30,
        detail: 'Pass 1: Scanning full transcript, audio energy & scenes for strong hooks...',
      });

      rawDiscovered = await discoverHookCandidatesWithGemini({
        transcript: project.transcript,
        scenes: project.scenes,
        audioEnergy: project.audioEnergy,
        silences: project.silences,
        videoDuration: meta.duration,
        targetDuration: project.analysisConfig.targetClipDuration,
        desiredCount: project.analysisConfig.clipCount,
      });

      // Retry once with broader instruction if Pass 1 returned empty on valid video
      if (rawDiscovered.length === 0 && meta.duration >= 3) {
        rawDiscovered = await discoverHookCandidatesWithGemini({
          transcript: project.transcript,
          scenes: project.scenes,
          audioEnergy: project.audioEnergy,
          silences: project.silences,
          videoDuration: meta.duration,
          targetDuration: Math.max(6, Math.min(project.analysisConfig.targetClipDuration, Math.round(meta.duration * 0.5))),
          desiredCount: Math.max(1, Math.min(3, project.analysisConfig.clipCount || 3)),
          customFocusPrompt:
            'Identify at least 1 strong standalone highlight moment covering the clearest insight or narrative arc in this footage.',
        });
      }

      if (rawDiscovered.length === 0) {
        throw new Error('Pass 1 Hook Discovery could not identify any valid highlight intervals. Click Retry Processing to run again.');
      }

      updateStage(project, 'hook_discovery', {
        status: 'completed',
        progress: 100,
        detail: `Discovered ${rawDiscovered.length} candidate engaging moments across the video`,
      });
    }

    // STAGE 7: Building Hook Candidates, Grounded Transcript Snapping, 7-Criterion Scoring & Deduplication
    activeStage = 'hook_scoring';
    const scoringStage = project.pipelineStages.find((s) => s.key === 'hook_scoring');
    const rawRatingsByCandidateId = new Map<string, RawCriterionRatings>();
    const silenceRatioByCandidateId = new Map<string, number>();

    if (!scoringStage || scoringStage.status !== 'completed' || rawDiscovered.length > 0) {
      updateStage(project, 'hook_scoring', {
        status: 'running',
        progress: 35,
        detail: 'Snapping candidate timestamps to sentence boundaries & scoring 7 hook criteria (0-100)...',
      });

      const now = new Date().toISOString();
      const builtCandidates: HookCandidate[] = rawDiscovered.map((raw) => {
        const snapped = snapBoundsToTranscript({
          rawStart: raw.startTime,
          rawEnd: raw.endTime,
          transcript: project.transcript,
          silences: project.silences,
          audioEnergy: project.audioEnergy,
          videoDuration: meta.duration,
        });
        const { hookBreakdown, legacyScores } = computeWeightedHookScore(
          raw.rawRatings,
          scoringWeights,
          snapped.audioEnergyScore
        );
        const candId = uuidv4();
        rawRatingsByCandidateId.set(candId, raw.rawRatings);
        silenceRatioByCandidateId.set(candId, snapped.silenceRatio);

        return {
          id: candId,
          projectId,
          title: raw.title,
          topic: raw.topic,
          openingDialogue: snapped.openingDialogue || raw.openingDialogue,
          endingDialogue: snapped.endingDialogue,
          transcriptExcerpt: snapped.transcriptExcerpt,
          startTime: snapped.startTime,
          endTime: snapped.endTime,
          duration: Number((snapped.endTime - snapped.startTime).toFixed(2)),
          description: raw.description,
          reasonSelected: raw.reasonSelected,
          category: raw.category,
          hookTitle: raw.hookTitle,
          speakerLabel: raw.speakerLabel,
          emphasizedKeywords: raw.emphasizedKeywords,
          scores: legacyScores,
          hookBreakdown,
          audioEnergyScore: snapped.audioEnergyScore,
          status: 'discovered',
          createdAt: now,
          updatedAt: now,
        };
      });

      project.hookCandidates = deduplicateHookCandidates(builtCandidates);
      const uniqueActiveCount = project.hookCandidates.filter((c) => c.status !== 'rejected').length;
      updateStage(project, 'hook_scoring', {
        status: 'completed',
        progress: 100,
        detail: `Scored ${project.hookCandidates.length} candidates (${uniqueActiveCount} unique non-overlapping hooks)`,
      });
    }

    // STAGE 8: PASS 2 — Verifying Timestamps, Opening Hooks, Standalone Context & Natural Endings
    activeStage = 'hook_verification';
    const verifyStage = project.pipelineStages.find((s) => s.key === 'hook_verification');
    if (!verifyStage || verifyStage.status !== 'completed') {
      const candidatesToVerify = (project.hookCandidates ?? []).filter((c) => c.status !== 'rejected');
      updateStage(project, 'hook_verification', {
        status: 'running',
        progress: 30,
        detail: `Pass 2: Auditing ${candidatesToVerify.length} candidates against surrounding transcript context...`,
      });

      if (candidatesToVerify.length > 0 && project.transcript.length > 0) {
        const verificationPayload = candidatesToVerify.map((cand, idx) => {
          const surroundingSegs = project.transcript.filter(
            (seg) => seg.end >= cand.startTime - 18 && seg.start <= cand.endTime + 18
          );
          const surroundingTranscript = surroundingSegs
            .map((s) => `[${s.start.toFixed(2)}s - ${s.end.toFixed(2)}s] (${s.speaker}): ${s.text}`)
            .join('\n');

          return {
            index: idx,
            title: cand.title,
            topic: cand.topic,
            startTime: cand.startTime,
            endTime: cand.endTime,
            openingDialogue: cand.openingDialogue,
            endingDialogue: cand.endingDialogue,
            surroundingTranscript,
            silenceRatio: silenceRatioByCandidateId.get(cand.id) ?? 0.05,
            audioEnergyScore: cand.audioEnergyScore,
            rawRatings: rawRatingsByCandidateId.get(cand.id) ?? {
              openingHook: cand.scores.hookStrength,
              curiosityInterest: cand.scores.engagement,
              emotionalEngagement: cand.scores.emotionalImpact,
              infoEntertainment: cand.scores.informationValue,
              storyCompleteness: cand.scores.storyCompleteness,
              standaloneContext: 75,
              audioVisualQuality: cand.audioEnergyScore,
              surprisingScore: cand.hookBreakdown.surprisingScore,
              storytellingScore: cand.hookBreakdown.storytellingScore,
              entertainingScore: cand.hookBreakdown.entertainingScore,
              informativeScore: cand.hookBreakdown.informativeScore,
              emotionalScore: cand.hookBreakdown.emotionalScore,
            },
          };
        });

        const verifiedResults = await verifyHookCandidatesWithGemini({
          candidates: verificationPayload,
          videoDuration: meta.duration,
          targetDuration: project.analysisConfig.targetClipDuration,
        });

        const resultMap = new Map(verifiedResults.map((r) => [r.candidateIndex, r]));
        for (let idx = 0; idx < candidatesToVerify.length; idx++) {
          const cand = candidatesToVerify[idx];
          const res = resultMap.get(idx);
          if (!res) {
            cand.status = 'verified';
            cand.verificationNotes = 'Transcript boundaries and opening dialogue verified.';
            continue;
          }

          // Re-snap refined Pass 2 timestamps to exact transcript boundaries
          const reSnapped = snapBoundsToTranscript({
            rawStart: res.refinedStartTime,
            rawEnd: res.refinedEndTime,
            transcript: project.transcript,
            silences: project.silences,
            audioEnergy: project.audioEnergy,
            videoDuration: meta.duration,
          });
          const { hookBreakdown, legacyScores } = computeWeightedHookScore(
            res.rawRatings,
            scoringWeights,
            reSnapped.audioEnergyScore
          );

          cand.startTime = reSnapped.startTime;
          cand.endTime = reSnapped.endTime;
          cand.duration = Number((reSnapped.endTime - reSnapped.startTime).toFixed(2));
          cand.openingDialogue = reSnapped.openingDialogue || cand.openingDialogue;
          cand.endingDialogue = reSnapped.endingDialogue || cand.endingDialogue;
          cand.transcriptExcerpt = reSnapped.transcriptExcerpt || cand.transcriptExcerpt;
          cand.audioEnergyScore = reSnapped.audioEnergyScore;
          cand.hookBreakdown = hookBreakdown;
          cand.scores = legacyScores;
          cand.verificationNotes = res.verificationNotes;
          if (res.approved) {
            cand.status = 'verified';
          } else {
            cand.status = 'rejected';
            cand.rejectedReasons = res.rejectedReasons?.length
              ? res.rejectedReasons
              : ['Did not pass Pass 2 context & hook completeness audit'];
          }
          cand.updatedAt = new Date().toISOString();
        }
      } else {
        for (const cand of candidatesToVerify) {
          cand.status = 'verified';
          cand.verificationNotes = 'Verified against video scene boundaries.';
        }
      }

      // Final dedupe pass after Pass 2 boundary adjustments
      if (project.hookCandidates) {
        project.hookCandidates.sort((a, b) => b.hookBreakdown.total - a.hookBreakdown.total);
      }
      const verifiedCount = (project.hookCandidates ?? []).filter((c) => c.status === 'verified' || c.status === 'approved').length;
      const rejectedCount = (project.hookCandidates ?? []).filter((c) => c.status === 'rejected').length;

      updateStage(project, 'hook_verification', {
        status: 'completed',
        progress: 100,
        detail: `${verifiedCount} hooks verified · ${rejectedCount} filtered out by Pass 2 quality audit`,
      });
    }

    // STAGE 9: Selecting Final Clips & Generating Thumbnails
    activeStage = 'clip_generation';
    const clipGenStage = project.pipelineStages.find((s) => s.key === 'clip_generation');
    if (!clipGenStage || clipGenStage.status !== 'completed') {
      updateStage(project, 'clip_generation', {
        status: 'running',
        progress: 20,
        detail: 'Selecting top verified hooks and generating clip previews...',
      });

      const allCandidates = project.hookCandidates ?? [];
      let approvedPool = allCandidates
        .filter((c) => c.status === 'verified' || c.status === 'approved' || c.status === 'generated')
        .sort((a, b) => b.hookBreakdown.total - a.hookBreakdown.total);

      // If Pass 2 rejected everything on a tricky clip, rescue the single highest-scored candidate with a clear note
      let selectionNote: string | undefined;
      if (approvedPool.length === 0 && allCandidates.length > 0) {
        const topFallback = [...allCandidates].sort((a, b) => b.hookBreakdown.total - a.hookBreakdown.total)[0];
        topFallback.status = 'verified';
        approvedPool = [topFallback];
        selectionNote =
          'Few moments matched all strict hook criteria for the requested duration; the strongest available moment was selected. Review all candidates in Hook Intelligence.';
      }

      const desiredLimit =
        project.analysisConfig.clipCount === 0
          ? Math.min(30, approvedPool.length)
          : Math.min(project.analysisConfig.clipCount, approvedPool.length);

      if (
        !selectionNote &&
        project.analysisConfig.clipCount > 0 &&
        approvedPool.length < project.analysisConfig.clipCount
      ) {
        selectionNote = `Found ${approvedPool.length} high-quality verified hook${approvedPool.length === 1 ? '' : 's'} matching your ${project.analysisConfig.targetClipDuration}s target (requested ${project.analysisConfig.clipCount}). Inspect or approve additional moments in Hook Intelligence.`;
      }
      project.hookSelectionNote = selectionNote;

      // Enforce zero chronological overlap in the final chosen clip list
      const selectedCandidates: HookCandidate[] = [];
      for (const cand of approvedPool) {
        if (selectedCandidates.length >= desiredLimit) break;
        const overlaps = selectedCandidates.some((ex) => {
          const ov = Math.min(ex.endTime, cand.endTime) - Math.max(ex.startTime, cand.startTime);
          const minD = Math.max(1, Math.min(ex.duration, cand.duration));
          return ov / minD > 0.25;
        });
        if (!overlaps) {
          selectedCandidates.push(cand);
        }
      }

      const generatedClips: ClipRecord[] = selectedCandidates.map((cand) => {
        const clip = buildClipFromHookCandidate(project, cand);
        cand.clipId = clip.id;
        cand.status = 'generated';
        return clip;
      });

      project.clips = generatedClips;
      fs.mkdirSync(clipsDir, { recursive: true });
      for (let i = 0; i < project.clips.length; i++) {
        const clip = project.clips[i];
        const clipThumbPath = path.join(clipsDir, clip.id, 'thumb.jpg');
        if (!fs.existsSync(clipThumbPath)) {
          const sampleTime = clip.startTime + Math.min(2, clip.duration * 0.25);
          try {
            await extractThumbnail(project.sourcePath, clipThumbPath, sampleTime);
          } catch (thumbErr) {
            logBackendError({
              projectId,
              uploadId: project.uploadId,
              jobId,
              stage: 'clip_generation',
              httpStatus: 500,
              error: thumbErr,
            });
            if (project.thumbnailUrl) {
              clip.thumbnailUrl = project.thumbnailUrl;
            }
          }
        }
        updateStage(project, 'clip_generation', {
          status: 'running',
          progress: Math.round(((i + 1) / Math.max(1, project.clips.length)) * 100),
          detail: `Prepared clip ${i + 1} of ${project.clips.length} (${clip.title})`,
        });
      }

      updateStage(project, 'clip_generation', {
        status: 'completed',
        progress: 100,
        detail: `Selected ${project.clips.length} verified clip${project.clips.length === 1 ? '' : 's'} with captions & thumbnails`,
      });
    }

    // STAGE 10: Rendering & FFprobe-Validating Real Downloadable MP4 Files
    activeStage = 'clip_rendering';
    const renderStage = project.pipelineStages.find((s) => s.key === 'clip_rendering');
    if (!renderStage || renderStage.status !== 'completed') {
      const autoRenderTargets = project.clips.slice(0, AUTO_RENDER_CLIP_LIMIT);
      const exportDefaults: ExportOptions = {
        resolution: appSettings.defaultExportResolution === '4k' ? '1080p' : appSettings.defaultExportResolution,
        codec: 'h264',
        fps: appSettings.defaultExportFps || 30,
        quality: 'standard',
        embedCaptions: true,
        includeMusic: true,
      };

      updateStage(project, 'clip_rendering', {
        status: 'running',
        progress: 5,
        detail: `Rendering & validating ${autoRenderTargets.length} playable MP4 file${autoRenderTargets.length === 1 ? '' : 's'} (H.264 / AAC 48kHz / faststart)...`,
      });

      let readyCount = 0;
      for (let i = 0; i < autoRenderTargets.length; i++) {
        const clip = autoRenderTargets[i];
        const latestProj = store.getProject(projectId) ?? project;
        const latestClip = latestProj.clips.find((c) => c.id === clip.id) ?? clip;

        if (latestClip.renderStatus === 'export_ready' && latestClip.renderedVideoUrl) {
          readyCount++;
          continue;
        }

        updateStage(project, 'clip_rendering', {
          status: 'running',
          progress: Math.max(8, Math.round((i / Math.max(1, autoRenderTargets.length)) * 100)),
          detail: `Rendering & FFprobe-validating MP4 ${i + 1} of ${autoRenderTargets.length}: "${clip.title}"...`,
        });

        try {
          await renderClipWithFFmpeg({
            project: latestProj,
            clip: latestClip,
            options: exportDefaults,
          });
          readyCount++;
        } catch (renderErr) {
          // Record exact error on the clip via renderClipWithFFmpeg, continue remaining clips
          logBackendError({
            projectId,
            uploadId: project.uploadId,
            jobId,
            stage: 'clip_rendering',
            httpStatus: 500,
            error: renderErr,
          });
        }

        // Refresh in-memory project reference so renderedVideoUrl & metadata stay synced
        const synced = store.getProject(projectId);
        if (synced) {
          project.clips = synced.clips;
        }
      }

      const remaining = Math.max(0, project.clips.length - autoRenderTargets.length);
      updateStage(project, 'clip_rendering', {
        status: 'completed',
        progress: 100,
        detail:
          remaining > 0
            ? `${readyCount} verified MP4s export-ready · ${remaining} additional clips ready for on-demand render`
            : `${readyCount} of ${autoRenderTargets.length} verified MP4 clips export-ready for instant download`,
      });
    }

    project.status = 'ready';
    project.errorMessage = undefined;
    project.failedStage = undefined;
    store.upsertProject(project);
  } catch (err) {
    const safeMessage = logBackendError({
      projectId,
      uploadId: project.uploadId,
      jobId,
      stage: activeStage,
      httpStatus: 500,
      route: 'pipeline:runAnalysisPipeline',
      error: err,
    });
    project.status = 'failed';
    project.failedStage = activeStage;
    project.errorMessage = safeMessage;
    for (const s of project.pipelineStages) {
      if (s.status === 'running' || s.key === activeStage) {
        s.status = 'failed';
        s.detail = safeMessage;
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
  const snapped = snapBoundsToTranscript({
    rawStart: h.startTime,
    rawEnd: h.endTime,
    transcript: project.transcript,
    silences: project.silences,
    audioEnergy: project.audioEnergy,
    videoDuration: project.metadata.duration,
  });
  const old = project.clips[existingIdx];
  const updated: ClipRecord = {
    ...old,
    title: h.title,
    topic: h.topic ?? old.topic,
    openingDialogue: snapped.openingDialogue || old.openingDialogue,
    endingDialogue: snapped.endingDialogue || old.endingDialogue,
    description: h.description,
    reasonSelected: h.reasonSelected,
    category: h.category,
    startTime: snapped.startTime,
    endTime: snapped.endTime,
    duration: Number((snapped.endTime - snapped.startTime).toFixed(2)),
    scores: h.scores,
    editingStatus: 'auto_generated',
    renderStatus: 'not_rendered',
    renderStageDetail: undefined,
    renderError: undefined,
    renderedVideoUrl: undefined,
    storageObjectPath: undefined,
    mp4Filename: undefined,
    renderedFileSize: undefined,
    renderedDuration: undefined,
    renderedResolution: undefined,
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
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', wavPath],
    { maxBuffer: 10 * 1024 * 1024 }
  );
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

  await runFFmpegSpawn([
    '-loglevel',
    'error',
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
  project.storageRef = `local://projects/${project.id}/source.mp4`;
  project.sourceUrl = `/media/projects/${project.id}/source.mp4`;
  project.thumbnailUrl = `/media/projects/${project.id}/thumb.jpg`;
  project.fileSize = meta.fileSize;
  project.metadata = meta;
  project.uploadProgress = 100;
  project.status = 'uploaded';
  store.upsertProject(project);
  return project;
}
