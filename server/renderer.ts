import fs from 'fs';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { createRequire } from 'module';
import { v4 as uuidv4 } from 'uuid';

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const archiver = require('archiver') as (
  format: 'zip',
  options?: { zlib?: { level?: number } }
) => {
  pipe: (dest: NodeJS.WritableStream) => void;
  file: (filePath: string, data: { name: string }) => void;
  append: (source: string | Buffer, data: { name: string }) => void;
  finalize: () => Promise<void>;
};
import type {
  AspectRatio,
  CaptionStyleConfig,
  ClipRecord,
  ClipRenderStatus,
  ExportJob,
  ExportOptions,
  ExportResolution,
  Mp4ValidationMeta,
  ProjectRecord,
  TranscriptSegment,
  WordTiming,
} from '../shared/types.ts';
import { store } from './store.ts';
import { logBackendError } from './logger.ts';
import { getMusicTrackPath, getSfxPath } from './music.ts';

/**
 * Resolves the persistent on-disk path of a clip's rendered MP4 file safely.
 */
export function resolveClipMp4Path(project: ProjectRecord, clip: ClipRecord): string | null {
  const clipDir = path.join(store.getProjectDir(project.id), 'clips', clip.id);
  const candidateName =
    clip.mp4Filename ||
    (clip.renderedVideoUrl ? path.basename(clip.renderedVideoUrl.split('?')[0]) : '');
  if (!candidateName) return null;
  const fullPath = path.join(clipDir, path.basename(candidateName));
  return fullPath;
}

/**
 * Builds a clean, filesystem- and browser-safe MP4 download filename.
 */
export function buildClipDownloadFilename(clip: ClipRecord): string {
  const safeTitle =
    clip.title
      .replace(/[^a-zA-Z0-9-_ ]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'ClipGenius_Clip';
  const resTag = clip.lastExportConfig?.resolution ?? '1080p';
  return `${safeTitle}_${resTag}.mp4`;
}

/**
 * Strictly validates a rendered MP4 file with FFprobe before allowing it to be marked Export Ready.
 * Checks file existence, non-zero byte size, MP4 container, valid video stream, valid audio stream (when expected),
 * valid duration, and valid resolution.
 */
export async function validateRenderedMp4WithFFprobe(
  filePath: string,
  expectAudio: boolean
): Promise<Mp4ValidationMeta> {
  if (!fs.existsSync(filePath)) {
    throw new Error('Rendered MP4 validation failed: output file does not exist on disk.');
  }
  const stat = fs.statSync(filePath);
  if (stat.size <= 0) {
    throw new Error('Rendered MP4 validation failed: output file size is 0 bytes.');
  }

  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath],
    { maxBuffer: 10 * 1024 * 1024, timeout: 25000 }
  );

  const parsed = JSON.parse(stdout) as {
    format?: {
      format_name?: string;
      duration?: string;
      size?: string;
    };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      sample_rate?: string;
      duration?: string;
    }>;
  };

  const formatName = (parsed.format?.format_name || '').toLowerCase();
  if (!formatName.includes('mp4') && !formatName.includes('mov')) {
    throw new Error(`Rendered MP4 validation failed: invalid container format "${formatName || 'unknown'}".`);
  }

  const videoStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const audioStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  if (!videoStream) {
    throw new Error('Rendered MP4 validation failed: no playable video stream found.');
  }

  const width = Number(videoStream.width || 0);
  const height = Number(videoStream.height || 0);
  if (width < 64 || height < 64) {
    throw new Error(`Rendered MP4 validation failed: invalid resolution ${width}x${height}.`);
  }

  if (expectAudio && !audioStream) {
    throw new Error('Rendered MP4 validation failed: expected audio stream is missing.');
  }

  const duration = Number(parsed.format?.duration || videoStream.duration || 0);
  if (!Number.isFinite(duration) || duration <= 0.25) {
    throw new Error(`Rendered MP4 validation failed: invalid duration (${duration}s).`);
  }

  return {
    container: formatName,
    videoCodec: videoStream.codec_name || 'h264',
    audioCodec: audioStream?.codec_name || 'none',
    width,
    height,
    duration: Number(duration.toFixed(2)),
    fileSize: stat.size,
  };
}

function updateClipRenderState(
  projectId: string,
  clipId: string,
  patch: {
    renderStatus: ClipRenderStatus;
    renderStageDetail?: string;
    renderError?: string;
    renderedVideoUrl?: string;
    storageObjectPath?: string;
    mp4Filename?: string;
    renderedFileSize?: number;
    renderedDuration?: number;
    renderedResolution?: string;
    renderedAt?: string;
    lastExportConfig?: ExportOptions;
    editingStatus?: ClipRecord['editingStatus'];
    originalVideoId?: string;
  }
): void {
  const freshProject = store.getProject(projectId);
  if (!freshProject) return;
  const targetClip = freshProject.clips.find((c) => c.id === clipId);
  if (!targetClip) return;
  Object.assign(targetClip, patch, { updatedAt: new Date().toISOString() });
  store.upsertProject(freshProject);
}

function getOutputDimensions(aspectRatio: AspectRatio, resolution: ExportResolution): { width: number; height: number } {
  const shortSide = resolution === '4k' ? 2160 : resolution === '1080p' ? 1080 : 720;
  const makeEven = (n: number) => Math.max(2, Math.round(n / 2) * 2);

  switch (aspectRatio) {
    case '9:16':
      return { width: makeEven(shortSide), height: makeEven((shortSide * 16) / 9) };
    case '16:9':
      return { width: makeEven((shortSide * 16) / 9), height: makeEven(shortSide) };
    case '1:1':
      return { width: makeEven(shortSide), height: makeEven(shortSide) };
    case '4:5':
      return { width: makeEven(shortSide), height: makeEven((shortSide * 5) / 4) };
    case '4:3':
      return { width: makeEven((shortSide * 4) / 3), height: makeEven(shortSide) };
    default:
      return { width: 1080, height: 1920 };
  }
}

/**
 * Converts #RRGGBB + opacity (0..1) into ASS format &HAABBGGRR (where 00 = opaque, FF = transparent)
 */
function hexToAssColor(hex: string, opacity = 1): string {
  const clean = (hex || '#FFFFFF').replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, 'F').slice(0, 6);
  const r = full.slice(0, 2).toUpperCase();
  const g = full.slice(2, 4).toUpperCase();
  const b = full.slice(4, 6).toUpperCase();
  const alphaByte = Math.round((1 - Math.max(0, Math.min(1, opacity))) * 255)
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
  return `&H${alphaByte}${b}${g}${r}`;
}

function formatAssTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.min(99, Math.floor((s - Math.floor(s)) * 100));
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function formatSrtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.min(999, Math.floor((s - Math.floor(s)) * 1000));
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

function mapFontForLinuxAss(fontFamily: string, sampleText: string): string {
  if (/[\u0600-\u06FF]/.test(sampleText)) {
    return fontFamily.includes('Urdu') ? 'Noto Nastaliq Urdu' : 'Noto Sans Arabic';
  }
  if (/[\u0900-\u097F]/.test(sampleText)) {
    return 'Noto Sans';
  }
  const map: Record<string, string> = {
    'Plus Jakarta Sans': 'DejaVu Sans',
    'DM Sans': 'Liberation Sans',
    'Liberation Serif': 'Liberation Serif',
    'JetBrains Mono': 'JetBrains Mono',
    'Liberation Sans Narrow': 'Liberation Sans Narrow',
    'DejaVu Sans': 'DejaVu Sans',
    'Liberation Sans': 'Liberation Sans',
    'Noto Sans': 'Noto Sans',
    'Noto Nastaliq Urdu': 'Noto Nastaliq Urdu',
    'Noto Sans Arabic': 'Noto Sans Arabic',
  };
  return map[fontFamily] || 'DejaVu Sans';
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r?\n/g, '\\N');
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function escapeFilterPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export function getClipSegments(project: ProjectRecord, clip: ClipRecord): TranscriptSegment[] {
  if (clip.customSegments && clip.customSegments.length > 0) {
    return clip.customSegments;
  }
  return project.transcript.filter((seg) => seg.end > clip.startTime && seg.start < clip.endTime);
}

/**
 * Generates an Advanced SubStation Alpha (.ass) subtitle file with synchronized word-level highlighting
 * matching the clip's caption preset and customizations.
 */
export function generateAssSubtitles(
  project: ProjectRecord,
  clip: ClipRecord,
  outWidth: number,
  outHeight: number
): string {
  const style: CaptionStyleConfig = clip.captionStyle;
  const segments = getClipSegments(project, clip);
  const allText = segments.map((s) => s.text).join(' ');
  const assFont = mapFontForLinuxAss(style.fontFamily, allText);

  // Scale font size relative to 1080p playRes
  const scaleFactor = Math.min(outWidth, outHeight) / 720;
  const assFontSize = Math.max(20, Math.round(style.fontSize * scaleFactor * 1.18));

  // ASS alignment: 1-3 bottom, 4-6 middle, 7-9 top
  const rowBase = style.position === 'top' ? 7 : style.position === 'middle' ? 4 : 1;
  const colOffset = style.alignment === 'left' ? 0 : style.alignment === 'right' ? 2 : 1;
  const alignment = rowBase + colOffset;

  const primaryCol = hexToAssColor(style.textColor, 1);
  const highlightCol = hexToAssColor(style.highlightColor, 1);
  const outlineCol = hexToAssColor(style.strokeColor, 1);
  const backCol =
    style.backgroundOpacity > 0.05
      ? hexToAssColor(style.backgroundColor, style.backgroundOpacity)
      : hexToAssColor('#000000', style.shadow ? 0.55 : 0);

  const borderStyle = style.backgroundOpacity > 0.05 ? 3 : 1;
  const outlineWidth = style.backgroundOpacity > 0.05 ? Math.max(6, style.strokeWidth + 4) : style.strokeWidth;
  const shadowDepth = style.shadow ? 2.5 : 0;
  const boldFlag = style.fontWeight >= 700 ? -1 : 0;

  const marginV =
    style.position === 'top'
      ? Math.round((style.verticalOffset / 100) * outHeight)
      : style.position === 'bottom'
        ? Math.max(36, Math.round(((100 - style.verticalOffset) / 100) * outHeight))
        : 20;
  const marginH = Math.round(outWidth * 0.07);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${outWidth}`,
    `PlayResY: ${outHeight}`,
    'ScaledBorderAndShadow: yes',
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${assFont},${assFontSize},${primaryCol},${highlightCol},${outlineCol},${backCol},${boldFlag},0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadowDepth},${alignment},${marginH},${marginH},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const offsetSec = (style.timingOffsetMs || 0) / 1000;
  const wordsPerGroup = Math.max(1, Math.min(12, style.wordsPerLine * style.maxLines));
  const lines: string[] = [];

  for (const seg of segments) {
    const words: WordTiming[] = seg.words.length
      ? seg.words
      : [{ id: seg.id, word: seg.text, start: seg.start, end: seg.end }];

    // Group words into concise readable chunks
    for (let i = 0; i < words.length; i += wordsPerGroup) {
      const group = words.slice(i, i + wordsPerGroup);
      if (group.length === 0) continue;

      const grpStart = Math.max(0, group[0].start - clip.startTime + offsetSec);
      const grpEnd = Math.min(clip.duration, Math.max(grpStart + 0.12, group[group.length - 1].end - clip.startTime + offsetSec));
      if (grpEnd <= 0 || grpStart >= clip.duration) continue;

      if (style.wordLevelHighlight) {
        // Emit one dialogue line per active word inside this chunk for crisp, exact color highlight
        for (let activeIdx = 0; activeIdx < group.length; activeIdx++) {
          const w = group[activeIdx];
          const wStart = Math.max(0, w.start - clip.startTime + offsetSec);
          const wEnd = Math.min(
            clip.duration,
            Math.max(wStart + 0.06, (activeIdx === group.length - 1 ? group[activeIdx].end : group[activeIdx + 1].start) - clip.startTime + offsetSec)
          );
          if (wEnd <= 0 || wStart >= clip.duration) continue;

          const formattedTokens = group.map((token, idx) => {
            const rawWord = style.uppercase ? token.word.toUpperCase() : token.word;
            const safeWord = escapeAssText(rawWord);
            const lineBreak = idx > 0 && idx % style.wordsPerLine === 0 ? '\\N' : idx > 0 ? ' ' : '';
            if (idx === activeIdx) {
              const popTag = style.animation === 'pop' ? '\\fscx108\\fscy108' : '';
              return `${lineBreak}{\\c${highlightCol}${popTag}}${safeWord}{\\c${primaryCol}\\fscx100\\fscy100}`;
            }
            return `${lineBreak}${safeWord}`;
          });

          lines.push(
            `Dialogue: 0,${formatAssTime(wStart)},${formatAssTime(wEnd)},Default,,0,0,0,,${formattedTokens.join('')}`
          );
        }
      } else {
        const formattedTokens = group.map((token, idx) => {
          const rawWord = style.uppercase ? token.word.toUpperCase() : token.word;
          const safeWord = escapeAssText(rawWord);
          const lineBreak = idx > 0 && idx % style.wordsPerLine === 0 ? '\\N' : idx > 0 ? ' ' : '';
          return `${lineBreak}${safeWord}`;
        });
        const fadeTag = style.animation === 'fade' ? '{\\fad(120,120)}' : '';
        lines.push(
          `Dialogue: 0,${formatAssTime(grpStart)},${formatAssTime(grpEnd)},Default,,0,0,0,,${fadeTag}${formattedTokens.join('')}`
        );
      }
    }
  }

  return [...header, ...lines, ''].join('\n');
}

export function generateSrtSubtitles(project: ProjectRecord, clip: ClipRecord): string {
  const segments = getClipSegments(project, clip);
  const offsetSec = (clip.captionStyle.timingOffsetMs || 0) / 1000;
  const blocks: string[] = [];
  let index = 1;

  for (const seg of segments) {
    const start = Math.max(0, seg.start - clip.startTime + offsetSec);
    const end = Math.min(clip.duration, Math.max(start + 0.2, seg.end - clip.startTime + offsetSec));
    if (end <= 0 || start >= clip.duration) continue;
    blocks.push(`${index}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${seg.text.trim()}\n`);
    index++;
  }
  return blocks.join('\n');
}

/**
 * Renders a clip with real FFmpeg processing (trim, aspect ratio reframe, color grading,
 * motion graphics overlays, ASS caption burn-in, royalty-free music + auto speech ducking)
 * while streaming real progress percentage into the ExportJob store.
 */
export async function renderClipWithFFmpeg(params: {
  project: ProjectRecord;
  clip: ClipRecord;
  options: ExportOptions;
  existingJob?: ExportJob;
}): Promise<ExportJob> {
  const { project, clip, options } = params;
  if (!project.sourcePath || !fs.existsSync(project.sourcePath) || !project.metadata) {
    throw new Error('Source video file is missing.');
  }

  const clipDir = path.join(store.getProjectDir(project.id), 'clips', clip.id);
  fs.mkdirSync(clipDir, { recursive: true });

  const job: ExportJob = params.existingJob ?? {
    id: uuidv4(),
    projectId: project.id,
    clipId: clip.id,
    clipTitle: clip.title,
    status: 'rendering',
    stage: 'rendering_mp4',
    stageDetail: 'Rendering MP4 (H.264 / yuv420p / AAC 48kHz / faststart)...',
    progress: 2,
    options,
    createdAt: new Date().toISOString(),
  };
  job.status = 'rendering';
  job.stage = 'rendering_mp4';
  job.stageDetail = 'Rendering MP4 (H.264 / yuv420p / AAC 48kHz / faststart)...';
  job.progress = 3;
  job.error = undefined;
  store.upsertExportJob(job);

  updateClipRenderState(project.id, clip.id, {
    renderStatus: 'rendering',
    renderStageDetail: 'Rendering MP4...',
    renderError: undefined,
    originalVideoId: project.uploadId ?? project.id,
  });

  const { width: outW, height: outH } = getOutputDimensions(clip.framing.aspectRatio, options.resolution);
  const inW = project.metadata.width || 1920;
  const inH = project.metadata.height || 1080;
  const clipDur = Math.max(1, clip.endTime - clip.startTime);

  const assPath = path.join(clipDir, 'subtitles.ass');
  const outFilename = `export_${job.id.slice(0, 8)}.mp4`;
  const tmpOutPath = path.join(clipDir, `export_${job.id.slice(0, 8)}.tmp.mp4`);
  const outPath = path.join(clipDir, outFilename);

  // Build video filter chain
  const vfParts: string[] = [];

  // 1. Aspect Ratio & Smart Reframing
  const targetRatio = outW / outH;
  const sourceRatio = inW / inH;
  const baseZoom = Math.max(1.0, Math.min(2.0, clip.framing.zoom || 1.0));
  const motionExtraZoom = clip.motionGraphics.dynamicZoom
    ? Math.max(1.0, Math.min(1.28, clip.motionGraphics.zoomAmount || 1.08))
    : 1.0;

  let focalX = clip.framing.manualX ?? 0.5;
  let focalY = clip.framing.manualY ?? 0.45;
  if (clip.framing.mode !== 'manual' && clip.framing.focalKeyframes.length > 0) {
    focalX =
      clip.framing.focalKeyframes.reduce((acc, k) => acc + k.x, 0) / clip.framing.focalKeyframes.length;
    focalY =
      clip.framing.focalKeyframes.reduce((acc, k) => acc + k.y, 0) / clip.framing.focalKeyframes.length;
  }

  const useBlurredBackdrop = clip.motionGraphics.backgroundBlur && targetRatio < sourceRatio;
  let videoStreamLabel = '[0:v]';
  const complexFilters: string[] = [];

  if (useBlurredBackdrop) {
    // Blurred full-bleed background with centered sharp foreground
    complexFilters.push(
      `[0:v]split=2[bg_in][fg_in]`,
      `[bg_in]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=24:6,eq=brightness=-0.08[bg_blur]`,
      `[fg_in]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg_sharp]`,
      `[bg_blur][fg_sharp]overlay=(W-w)/2:(H-h)/2[reframed]`
    );
    videoStreamLabel = '[reframed]';
  } else {
    // Smart crop preserving target aspect ratio centered on active speaker focal point
    let cropW: number;
    let cropH: number;
    if (sourceRatio > targetRatio) {
      cropH = Math.floor(inH / baseZoom);
      cropW = Math.floor(cropH * targetRatio);
    } else {
      cropW = Math.floor(inW / baseZoom);
      cropH = Math.floor(cropW / targetRatio);
    }
    cropW = Math.max(64, Math.min(inW, cropW - (cropW % 2)));
    cropH = Math.max(64, Math.min(inH, cropH - (cropH % 2)));

    const maxOffsetX = Math.max(0, inW - cropW);
    const maxOffsetY = Math.max(0, inH - cropH);
    const baseCropX = Math.round(Math.max(0, Math.min(maxOffsetX, focalX * inW - cropW / 2)));
    const baseCropY = Math.round(Math.max(0, Math.min(maxOffsetY, focalY * inH - cropH / 2)));

    // Smooth camera drift or face-tracking pan if enabled
    let cropXExpr = String(baseCropX);
    if (clip.framing.mode === 'face_track' && clip.framing.focalKeyframes.length >= 2 && maxOffsetX > 8) {
      const firstX = clip.framing.focalKeyframes[0].x;
      const lastX = clip.framing.focalKeyframes[clip.framing.focalKeyframes.length - 1].x;
      const startPx = Math.round(Math.max(0, Math.min(maxOffsetX, firstX * inW - cropW / 2)));
      const endPx = Math.round(Math.max(0, Math.min(maxOffsetX, lastX * inW - cropW / 2)));
      cropXExpr = `${startPx}+(${endPx - startPx})*min(1\\,t/${clipDur.toFixed(2)})`;
    } else if (clip.motionGraphics.cameraMovement === 'subtle_pan' && maxOffsetX > 20) {
      const swing = Math.min(28, Math.floor(maxOffsetX / 3));
      cropXExpr = `max(0\\,min(${maxOffsetX}\\,${baseCropX}+${swing}*sin(t*0.45)))`;
    }

    vfParts.push(`crop=${cropW}:${cropH}:${cropXExpr}:${baseCropY}`);
    if (motionExtraZoom > 1.01) {
      const scaledW = Math.round((outW * motionExtraZoom) / 2) * 2;
      const scaledH = Math.round((outH * motionExtraZoom) / 2) * 2;
      vfParts.push(
        `scale=${scaledW}:${scaledH}:flags=lanczos`,
        `crop=${outW}:${outH}:(${scaledW}-${outW})/2:(${scaledH}-${outH})/2`
      );
    } else {
      vfParts.push(`scale=${outW}:${outH}:flags=lanczos`);
    }
  }

  // 2. Color Grading & Visual Style
  const cg = clip.colorGrading;
  const effBrightness = Math.max(-0.5, Math.min(0.5, (cg.brightness || 0) + (cg.exposure || 0) * 0.6 + (cg.aiEnhance ? 0.015 : 0)));
  const effContrast = Math.max(0.5, Math.min(1.8, (cg.contrast || 1) + (cg.aiEnhance ? 0.04 : 0)));
  const effSat = Math.max(0, Math.min(2.2, (cg.saturation || 1) + (cg.aiEnhance ? 0.03 : 0)));
  vfParts.push(`eq=brightness=${effBrightness.toFixed(3)}:contrast=${effContrast.toFixed(3)}:saturation=${effSat.toFixed(3)}`);

  const temp = Math.max(-0.4, Math.min(0.4, cg.temperature || 0));
  const hi = Math.max(-0.3, Math.min(0.3, cg.highlights || 0));
  const sh = Math.max(-0.3, Math.min(0.3, cg.shadows || 0));
  if (Math.abs(temp) > 0.01 || Math.abs(hi) > 0.01 || Math.abs(sh) > 0.01) {
    vfParts.push(
      `colorbalance=rs=${sh.toFixed(3)}:bs=${sh.toFixed(3)}:rm=${temp.toFixed(3)}:bm=${(-temp).toFixed(3)}:rh=${hi.toFixed(3)}:bh=${hi.toFixed(3)}`
    );
  }

  const sharp = (cg.sharpness || 0) + (cg.aiEnhance ? 0.25 : 0);
  if (sharp > 0.05) {
    vfParts.push(`unsharp=5:5:${Math.min(1.8, sharp).toFixed(2)}:5:5:0.0`);
  }

  // 3. Context-Aware Motion Graphics Overlays
  const mg = clip.motionGraphics;

  // Subtle fade in/out transitions
  if (mg.subtleTransitions && clipDur > 2) {
    vfParts.push(`fade=t=in:st=0:d=0.35`, `fade=t=out:st=${Math.max(0.5, clipDur - 0.35).toFixed(2)}:d=0.35`);
  }

  // Progress bar
  if (mg.progressBar !== 'none') {
    const barH = Math.max(6, Math.round(outH * 0.007));
    const barY = mg.progressBar === 'top' ? 0 : outH - barH;
    const barHex = (mg.progressBarColor || '#8B5CF6').replace('#', '0x');
    vfParts.push(`drawbox=x=0:y=${barY}:w=iw:h=${barH}:color=0x000000@0.45:t=fill`);
    vfParts.push(
      `drawbox=x=0:y=${barY}:w=iw*min(1\\,t/${clipDur.toFixed(2)}):h=${barH}:color=${barHex}@0.95:t=fill`
    );
  }

  // Animated Hook Title Card (opening few seconds)
  if (mg.hookTitleEnabled && mg.hookTitleText.trim()) {
    const hookDur = Math.min(clipDur * 0.5, Math.max(1.5, mg.hookDuration || 3));
    const hookFontSize = Math.max(24, Math.round(Math.min(outW, outH) * 0.044));
    const safeHook = escapeDrawtext(mg.hookTitleText.trim().slice(0, 44));
    const boxY = Math.round(outH * 0.08);
    vfParts.push(
      `drawtext=font='DejaVu Sans':text='${safeHook}':x=(w-text_w)/2:y=${boxY}:fontsize=${hookFontSize}:fontcolor=0xFFFFFF:box=1:boxcolor=0x09090D@0.78:boxborderw=18:enable='between(t,0.15,${hookDur.toFixed(2)})'`
    );
  }

  // Speaker Lower Third
  if (mg.lowerThirdEnabled && mg.speakerLabel.trim()) {
    const ltStart = mg.hookTitleEnabled ? 2.2 : 0.6;
    const ltEnd = Math.min(clipDur - 0.5, ltStart + 4.5);
    if (ltEnd > ltStart) {
      const safeName = escapeDrawtext(mg.speakerLabel.trim().slice(0, 32));
      const ltFontSize = Math.max(20, Math.round(Math.min(outW, outH) * 0.032));
      const ltX = Math.round(outW * 0.06);
      const ltY = Math.round(outH * 0.17);
      vfParts.push(
        `drawtext=font='DejaVu Sans':text='${safeName}':x=${ltX}:y=${ltY}:fontsize=${ltFontSize}:fontcolor=0xF4F5F8:box=1:boxcolor=0x141624@0.82:boxborderw=12:enable='between(t,${ltStart.toFixed(2)},${ltEnd.toFixed(2)})'`
      );
    }
  }

  // Custom Text Overlays
  for (const ov of clip.textOverlays) {
    if (!ov.text.trim()) continue;
    const safeText = escapeDrawtext(ov.text.trim());
    const ovColor = (ov.color || '#FFFFFF').replace('#', '0x');
    const ovBg = (ov.bgColor || '#09090D').replace('#', '0x');
    const ovX = Math.round((Math.max(5, Math.min(85, ov.x)) / 100) * outW);
    const ovY = Math.round((Math.max(5, Math.min(90, ov.y)) / 100) * outH);
    const ovFont = Math.max(18, Math.round((ov.fontSize || 28) * (Math.min(outW, outH) / 720)));
    vfParts.push(
      `drawtext=font='DejaVu Sans':text='${safeText}':x=${ovX}:y=${ovY}:fontsize=${ovFont}:fontcolor=${ovColor}:box=1:boxcolor=${ovBg}@0.75:boxborderw=10:enable='between(t,${Math.max(0, ov.startOffset).toFixed(2)},${Math.min(clipDur, ov.endOffset).toFixed(2)})'`
    );
  }

  // 4. Synchronized ASS Captions Burn-in
  if (options.embedCaptions && clip.captionStyle.enabled) {
    const assContent = generateAssSubtitles(project, clip, outW, outH);
    fs.writeFileSync(assPath, assContent, 'utf-8');
    vfParts.push(`ass='${escapeFilterPath(assPath)}'`);
  }

  // Combine video filtergraph
  const vChain = `${videoStreamLabel}${vfParts.join(',')}[vout]`;
  complexFilters.push(vChain);

  // 5. Audio inputs & Mixing (Original voice + Royalty-Free Music + Automatic Speech Ducking + Optional Hook SFX)
  const inputs: string[] = [
    '-ss',
    clip.startTime.toFixed(3),
    '-t',
    clipDur.toFixed(3),
    '-i',
    project.sourcePath,
  ];

  const hasSourceAudio = project.metadata.audioCodec !== 'none';
  const musicPath = options.includeMusic ? await getMusicTrackPath(clip.audioMix.musicTrackId) : null;
  const sfxPath =
    options.includeMusic && clip.audioMix.sfxOnHook !== 'none'
      ? await getSfxPath(clip.audioMix.sfxOnHook)
      : null;

  let musicInputIdx = -1;
  let sfxInputIdx = -1;

  if (musicPath) {
    musicInputIdx = 1;
    inputs.push('-stream_loop', '-1', '-t', clipDur.toFixed(3), '-i', musicPath);
  }
  if (sfxPath) {
    sfxInputIdx = musicInputIdx >= 0 ? 2 : 1;
    inputs.push('-i', sfxPath);
  }

  let audioMapLabel: string | null = null;
  const origVol = Math.max(0, Math.min(2, clip.audioMix.originalVolume ?? 1));
  const musVol = Math.max(0, Math.min(1, clip.audioMix.musicVolume ?? 0.18));
  const fadeIn = Math.max(0, Math.min(clipDur / 3, clip.audioMix.fadeInSeconds ?? 1));
  const fadeOut = Math.max(0, Math.min(clipDur / 3, clip.audioMix.fadeOutSeconds ?? 1.5));
  const fadeOutStart = Math.max(0, clipDur - fadeOut);

  if (hasSourceAudio && musicInputIdx >= 0) {
    const fadeExpr = [
      fadeIn > 0.05 ? `afade=t=in:st=0:d=${fadeIn.toFixed(2)}` : '',
      fadeOut > 0.05 ? `afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOut.toFixed(2)}` : '',
    ]
      .filter(Boolean)
      .join(',');

    const musicPrep = `[${musicInputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${musVol.toFixed(3)}${fadeExpr ? `,${fadeExpr}` : ''}[mus_raw]`;
    const voicePrep = `[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${origVol.toFixed(3)}[v_base]`;

    if (clip.audioMix.autoDucking) {
      complexFilters.push(
        voicePrep,
        `[v_base]asplit=2[v_mix][v_sc]`,
        musicPrep,
        `[mus_raw][v_sc]sidechaincompress=threshold=0.03:ratio=5:attack=25:release=300[mus_ducked]`,
        `[v_mix][mus_ducked]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[a_mixed]`
      );
    } else {
      complexFilters.push(
        voicePrep,
        musicPrep,
        `[v_base][mus_raw]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[a_mixed]`
      );
    }
    audioMapLabel = '[a_mixed]';
  } else if (hasSourceAudio) {
    complexFilters.push(`[0:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${origVol.toFixed(3)}[a_mixed]`);
    audioMapLabel = '[a_mixed]';
  } else if (musicInputIdx >= 0) {
    complexFilters.push(
      `[${musicInputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${musVol.toFixed(3)}[a_mixed]`
    );
    audioMapLabel = '[a_mixed]';
  }

  // Layer optional hook SFX at 0.15s
  if (sfxInputIdx >= 0 && audioMapLabel) {
    complexFilters.push(
      `[${sfxInputIdx}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=150|150,volume=0.55[sfx_ready]`,
      `${audioMapLabel}[sfx_ready]amix=inputs=2:duration=first:normalize=0[a_final]`
    );
    audioMapLabel = '[a_final]';
  }

  const videoCodec = options.codec === 'h265' ? 'libx265' : 'libx264';
  const qualityTier = options.quality ?? 'excellent';
  const crfValue =
    qualityTier === 'master'
      ? options.codec === 'h265'
        ? '18'
        : '16'
      : qualityTier === 'excellent'
        ? options.codec === 'h265'
          ? '20'
          : '18'
        : options.resolution === '4k'
          ? '21'
          : '22';
  const encodePreset = qualityTier === 'master' ? 'slow' : qualityTier === 'excellent' ? 'medium' : 'fast';

  const codecExtraFlags: string[] =
    options.codec === 'h265'
      ? ['-tag:v', 'hvc1']
      : ['-profile:v', 'high', '-level:v', '4.2'];

  const ffmpegArgs: string[] = [
    '-y',
    ...inputs,
    '-filter_complex',
    complexFilters.join(';'),
    '-map',
    '[vout]',
    ...(audioMapLabel ? ['-map', audioMapLabel] : ['-an']),
    '-r',
    String(options.fps || 30),
    '-c:v',
    videoCodec,
    '-preset',
    encodePreset,
    '-crf',
    crfValue,
    ...codecExtraFlags,
    '-pix_fmt',
    'yuv420p',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-colorspace',
    'bt709',
    ...(audioMapLabel ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : []),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-progress',
    'pipe:1',
    '-nostats',
    tmpOutPath,
  ];

  try {
    // Stage 1: Real FFmpeg MP4 encode into atomic temporary path
    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', ffmpegArgs);
      let stderrTail = '';

      proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        const match = text.match(/out_time_us=(\d+)/);
        if (match) {
          const outSeconds = Number(match[1]) / 1_000_000;
          const pct = Math.max(5, Math.min(88, Math.round((outSeconds / clipDur) * 88)));
          if (pct !== job.progress) {
            job.progress = pct;
            store.upsertExportJob(job);
          }
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2500);
      });

      proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(tmpOutPath)) {
          resolve();
        } else {
          reject(new Error(`FFmpeg render failed (code ${code}): ${stderrTail.slice(-400)}`));
        }
      });

      proc.on('error', (err) => reject(err));
    });

    // Stage 2: Mandatory FFprobe MP4 Verification
    job.stage = 'validating_mp4';
    job.stageDetail = 'Validating MP4 container, H.264 video stream, AAC audio & duration with FFprobe...';
    job.progress = 92;
    store.upsertExportJob(job);
    updateClipRenderState(project.id, clip.id, {
      renderStatus: 'validating',
      renderStageDetail: 'Validating MP4 with FFprobe...',
    });

    const expectAudio = Boolean(audioMapLabel);
    const validationMeta = await validateRenderedMp4WithFFprobe(tmpOutPath, expectAudio);

    // Stage 3: Atomic commit to persistent storage + remove older stale export files for this clip
    job.stage = 'saving_storage';
    job.stageDetail = 'Saving verified MP4 to persistent storage...';
    job.progress = 96;
    store.upsertExportJob(job);
    updateClipRenderState(project.id, clip.id, {
      renderStatus: 'saving',
      renderStageDetail: 'Saving verified MP4 to storage...',
    });

    fs.renameSync(tmpOutPath, outPath);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size <= 0) {
      throw new Error('Failed to verify persisted MP4 file after saving to storage.');
    }

    // Clean up older export_*.mp4 versions for this clip to keep storage clean
    try {
      for (const f of fs.readdirSync(clipDir)) {
        if (f.startsWith('export_') && f.endsWith('.mp4') && f !== outFilename) {
          fs.rmSync(path.join(clipDir, f), { force: true });
        }
      }
    } catch {
      // non-fatal cleanup
    }

    const storageObjectPath = `projects/${project.id}/clips/${clip.id}/${outFilename}`;
    const publicUrl = `/media/${storageObjectPath}`;
    const completedAt = new Date().toISOString();
    const resolutionLabel = `${validationMeta.width}x${validationMeta.height}`;

    // Stage 4: Mark Export Ready ONLY after FFprobe validation & persistent storage verification succeed
    job.status = 'completed';
    job.stage = 'export_ready';
    job.stageDetail = `Export ready · ${resolutionLabel} · ${validationMeta.videoCodec.toUpperCase()}/${validationMeta.audioCodec.toUpperCase()} · ${validationMeta.duration}s`;
    job.progress = 100;
    job.outputUrl = publicUrl;
    job.storageObjectPath = storageObjectPath;
    job.mp4Filename = outFilename;
    job.fileSize = validationMeta.fileSize;
    job.validationMeta = validationMeta;
    job.completedAt = completedAt;
    store.upsertExportJob(job);

    updateClipRenderState(project.id, clip.id, {
      renderStatus: 'export_ready',
      renderStageDetail: job.stageDetail,
      renderError: undefined,
      originalVideoId: project.uploadId ?? project.id,
      renderedVideoUrl: publicUrl,
      storageObjectPath,
      mp4Filename: outFilename,
      renderedFileSize: validationMeta.fileSize,
      renderedDuration: validationMeta.duration,
      renderedResolution: resolutionLabel,
      renderedAt: completedAt,
      lastExportConfig: options,
      editingStatus: 'rendered',
    });

    return job;
  } catch (err) {
    // Clean up any partial or corrupt temporary MP4
    if (fs.existsSync(tmpOutPath)) {
      fs.rmSync(tmpOutPath, { force: true });
    }
    const safeError = logBackendError({
      projectId: project.id,
      jobId: job.id,
      stage: job.stage || 'rendering_mp4',
      httpStatus: 500,
      route: 'renderer:renderClipWithFFmpeg',
      error: err,
    });
    job.status = 'failed';
    job.stage = 'failed';
    job.stageDetail = safeError;
    job.error = safeError;
    store.upsertExportJob(job);

    updateClipRenderState(project.id, clip.id, {
      renderStatus: 'failed',
      renderStageDetail: 'MP4 export failed',
      renderError: safeError,
    });

    throw new Error(safeError);
  }
}

/**
 * Bundles all verified, export-ready rendered MP4 clips for a project into a real downloadable ZIP archive.
 */
export async function streamProjectClipsZip(
  project: ProjectRecord,
  writableStream: NodeJS.WritableStream
): Promise<void> {
  const readyEntries: Array<{ clip: ClipRecord; fullPath: string; index: number }> = [];
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i];
    const fullPath = resolveClipMp4Path(project, clip);
    if (!fullPath || !fs.existsSync(fullPath)) continue;
    const stat = fs.statSync(fullPath);
    if (stat.size <= 0) continue;
    readyEntries.push({ clip, fullPath, index: i });
  }

  if (readyEntries.length === 0) {
    throw new Error('No verified MP4 clips are ready yet. Render at least one clip before downloading the ZIP bundle.');
  }

  const archive = archiver('zip', { zlib: { level: 1 } }); // MP4 is already compressed; fast level 1 avoids CPU overhead
  archive.pipe(writableStream);

  for (const entry of readyEntries) {
    const safeTitle =
      entry.clip.title
        .replace(/[^a-zA-Z0-9-_ ]/g, '')
        .trim()
        .replace(/\s+/g, '_')
        .slice(0, 48) || `clip_${entry.index + 1}`;
    const prefix = String(entry.index + 1).padStart(2, '0');
    archive.file(entry.fullPath, { name: `${prefix}_${safeTitle}.mp4` });
    const srtContent = generateSrtSubtitles(project, entry.clip);
    if (srtContent.trim()) {
      archive.append(srtContent, { name: `${prefix}_${safeTitle}.srt` });
    }
  }

  await archive.finalize();
}
