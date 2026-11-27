import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  RotateCcw,
  Move,
  Maximize2,
  Eye,
  Film,
  Sparkles,
} from 'lucide-react';
import type {
  AspectRatio,
  ClipRecord,
  MusicTrack,
  ProjectRecord,
  TranscriptSegment,
  WordTiming,
} from '../../shared/types.ts';
import {
  buildCssFilterFromGrading,
  formatTimecode,
  getAspectRatioNumeric,
  isRtlText,
} from '../lib/format.ts';

interface ClipPreviewPlayerProps {
  project: ProjectRecord;
  clip: ClipRecord;
  musicTracks?: MusicTrack[];
  currentTime?: number; // clip-relative seconds (controlled optional)
  onTimeUpdate?: (clipRelativeSeconds: number) => void;
  onManualFocalChange?: (x: number, y: number) => void;
  onAspectRatioChange?: (nextAspectRatio: AspectRatio, fitMode?: 'contain' | 'cover') => void;
  maxHeightClass?: string;
  showControls?: boolean;
  showAspectRatioToolbar?: boolean;
  previewRendered?: boolean;
  chromaPreviewColor?: string | null;
}

const REVIEW_ASPECT_OPTIONS: Array<{ id: AspectRatio; label: string; short: string }> = [
  { id: 'original', label: 'Original Source Size', short: 'Original' },
  { id: '9:16', label: '9:16 Vertical (Reels / Shorts)', short: '9:16' },
  { id: '16:9', label: '16:9 Horizontal (YouTube)', short: '16:9' },
  { id: '1:1', label: '1:1 Square', short: '1:1' },
  { id: '4:5', label: '4:5 Portrait', short: '4:5' },
];

export function ClipPreviewPlayer({
  project,
  clip,
  musicTracks = [],
  currentTime: externalTime,
  onTimeUpdate,
  onManualFocalChange,
  onAspectRatioChange,
  maxHeightClass = 'max-h-[540px]',
  showControls = true,
  showAspectRatioToolbar = true,
  previewRendered = false,
  chromaPreviewColor = null,
}: ClipPreviewPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const bgVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [relTime, setRelTime] = useState(0);
  const [isDraggingCrop, setIsDraggingCrop] = useState(false);
  const [mediaError, setMediaError] = useState(false);

  // Interactive Review Aspect Ratio override (defaults to clip's configured aspect ratio, or 'original' when preserving original video)
  const defaultClipAspect: AspectRatio = useMemo(() => {
    if (clip.preserveOriginalVideo || clip.isFullVideoCaption || clip.framing.aspectRatio === 'original') {
      return 'original';
    }
    return clip.framing.aspectRatio || 'original';
  }, [clip.preserveOriginalVideo, clip.isFullVideoCaption, clip.framing.aspectRatio]);

  const [reviewAspectRatio, setReviewAspectRatio] = useState<AspectRatio>(defaultClipAspect);
  // 'contain' = Full Frame (Fit with blurred/cinema backdrop so vertical 9:16 inside 16:9 shows full video without cutting heads),
  // 'cover' = Smart Crop / Fill frame
  const [reviewFitMode, setReviewFitMode] = useState<'contain' | 'cover'>(() =>
    clip.preserveOriginalVideo || clip.isFullVideoCaption || clip.framing.aspectRatio === 'original'
      ? 'contain'
      : clip.motionGraphics.backgroundBlur
        ? 'contain'
        : 'cover'
  );
  // Allow user to toggle between Live Interactive Caption Review and Rendered Exported MP4 Verification when an export exists
  const [verifyRenderedMp4, setVerifyRenderedMp4] = useState<boolean>(false);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: 340,
    height: 540,
  });

  useEffect(() => {
    setReviewAspectRatio(defaultClipAspect);
    setReviewFitMode(
      clip.preserveOriginalVideo || clip.isFullVideoCaption || clip.framing.aspectRatio === 'original'
        ? 'contain'
        : clip.motionGraphics.backgroundBlur
          ? 'contain'
          : 'cover'
    );
  }, [clip.id, defaultClipAspect, clip.preserveOriginalVideo, clip.isFullVideoCaption, clip.motionGraphics.backgroundBlur]);

  // Measure actual preview DOM canvas dimensions via ResizeObserver so caption font size, stroke, padding,
  // and vertical MarginV match the FFmpeg ASS renderer (server/renderer.ts -> generateAssSubtitles) 1:1!
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateSize = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 20 && rect.height > 20) {
        setCanvasSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateSize);
      ro.observe(el);
      return () => ro.disconnect();
    }
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, [reviewAspectRatio]);

  const clipDuration = Math.max(0.5, clip.endTime - clip.startTime);
  const isNativeOriginalView = reviewAspectRatio === 'original';
  const preserveOriginal = Boolean(
    isNativeOriginalView &&
      (clip.preserveOriginalVideo || clip.isFullVideoCaption || clip.framing.aspectRatio === 'original')
  );

  const srcWidth = project.metadata?.width && project.metadata.width >= 64 ? project.metadata.width : 1920;
  const srcHeight = project.metadata?.height && project.metadata.height >= 64 ? project.metadata.height : 1080;

  const ratio = getAspectRatioNumeric(reviewAspectRatio, srcWidth, srcHeight);
  const showingRendered = Boolean((previewRendered || verifyRenderedMp4) && clip.renderedVideoUrl);
  const videoSrc = showingRendered ? clip.renderedVideoUrl : project.sourceUrl;

  useEffect(() => {
    setMediaError(false);
  }, [videoSrc]);

  const activeMusicTrack = useMemo(
    () => musicTracks.find((t) => t.id === clip.audioMix.musicTrackId) ?? null,
    [musicTracks, clip.audioMix.musicTrackId]
  );

  // Sync external seeks into the HTML5 video element
  useEffect(() => {
    if (typeof externalTime !== 'number') return;
    const vid = videoRef.current;
    if (!vid) return;
    const target = showingRendered ? externalTime : clip.startTime + externalTime;
    if (Math.abs(vid.currentTime - target) > 0.22) {
      vid.currentTime = target;
      if (bgVideoRef.current) bgVideoRef.current.currentTime = target;
      setRelTime(Math.max(0, Math.min(clipDuration, externalTime)));
    }
  }, [externalTime, clip.startTime, clipDuration, showingRendered]);

  // Reset playhead to clip start when clip ID or trim start changes
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const initial = showingRendered ? 0 : clip.startTime;
    if (vid.readyState >= 1) {
      vid.currentTime = initial;
    }
    setRelTime(0);
    setIsPlaying(false);
    vid.pause();
    audioRef.current?.pause();
  }, [clip.id, clip.startTime, showingRendered]);

  // Keep audio volumes synced
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = isMuted;
      videoRef.current.volume = Math.max(0, Math.min(1, clip.audioMix.originalVolume));
    }
    if (audioRef.current) {
      audioRef.current.muted = isMuted;
      const duckFactor = clip.audioMix.autoDucking ? 0.65 : 1;
      audioRef.current.volume = Math.max(0, Math.min(1, clip.audioMix.musicVolume * duckFactor));
    }
  }, [isMuted, clip.audioMix.originalVolume, clip.audioMix.musicVolume, clip.audioMix.autoDucking]);

  const togglePlay = async () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      if (!showingRendered && (vid.currentTime < clip.startTime || vid.currentTime >= clip.endTime - 0.1)) {
        vid.currentTime = clip.startTime;
      }
      try {
        await vid.play();
        if (bgVideoRef.current) {
          bgVideoRef.current.currentTime = vid.currentTime;
          void bgVideoRef.current.play().catch(() => {});
        }
        if (audioRef.current && activeMusicTrack && !showingRendered) {
          audioRef.current.currentTime = relTime % Math.max(1, activeMusicTrack.duration);
          void audioRef.current.play().catch(() => {});
        }
        setIsPlaying(true);
      } catch {
        setIsPlaying(false);
      }
    } else {
      vid.pause();
      bgVideoRef.current?.pause();
      audioRef.current?.pause();
      setIsPlaying(false);
    }
  };

  const handleRestart = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const target = showingRendered ? 0 : clip.startTime;
    vid.currentTime = target;
    if (bgVideoRef.current) bgVideoRef.current.currentTime = target;
    if (audioRef.current) audioRef.current.currentTime = 0;
    setRelTime(0);
    onTimeUpdate?.(0);
  };

  const handleVideoTimeUpdate = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (showingRendered) {
      const t = vid.currentTime;
      setRelTime(t);
      onTimeUpdate?.(t);
      return;
    }
    if (vid.currentTime >= clip.endTime) {
      vid.currentTime = clip.startTime;
      if (bgVideoRef.current) bgVideoRef.current.currentTime = clip.startTime;
      if (audioRef.current) audioRef.current.currentTime = 0;
      setRelTime(0);
      onTimeUpdate?.(0);
      return;
    }
    const r = Math.max(0, vid.currentTime - clip.startTime);
    setRelTime(r);
    onTimeUpdate?.(r);
  };

  // High-precision 60fps requestAnimationFrame playhead tracker while playing
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;
    const tick = () => {
      const vid = videoRef.current;
      if (vid && !vid.paused) {
        if (showingRendered) {
          setRelTime(vid.currentTime);
        } else if (vid.currentTime >= clip.endTime) {
          vid.currentTime = clip.startTime;
          if (bgVideoRef.current) bgVideoRef.current.currentTime = clip.startTime;
          if (audioRef.current) audioRef.current.currentTime = 0;
          setRelTime(0);
        } else {
          setRelTime(Math.max(0, vid.currentTime - clip.startTime));
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, showingRendered, clip.startTime, clip.endTime]);

  // Compute active focal coordinates (AI Auto / Face Tracking / Manual)
  const focalPoint = useMemo(() => {
    if (clip.framing.mode === 'manual') {
      return { x: clip.framing.manualX, y: clip.framing.manualY };
    }
    const kfs = clip.framing.focalKeyframes;
    if (kfs.length === 0) {
      return { x: clip.framing.manualX ?? 0.5, y: clip.framing.manualY ?? 0.45 };
    }
    if (clip.framing.mode === 'ai_auto' || kfs.length === 1) {
      const avgX = kfs.reduce((a, b) => a + b.x, 0) / kfs.length;
      const avgY = kfs.reduce((a, b) => a + b.y, 0) / kfs.length;
      return { x: avgX, y: avgY };
    }
    const sorted = [...kfs].sort((a, b) => a.time - b.time);
    let prev = sorted[0];
    let next = sorted[sorted.length - 1];
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].time <= relTime) prev = sorted[i];
      if (sorted[i].time >= relTime) {
        next = sorted[i];
        break;
      }
    }
    if (prev.time === next.time) return { x: prev.x, y: prev.y };
    const ratioT = Math.max(0, Math.min(1, (relTime - prev.time) / (next.time - prev.time)));
    return {
      x: prev.x + (next.x - prev.x) * ratioT,
      y: prev.y + (next.y - prev.y) * ratioT,
    };
  }, [clip.framing, relTime]);

  // Segments belonging to this clip (identical to server/renderer.ts -> getClipSegments)
  const clipSegments: TranscriptSegment[] = useMemo(() => {
    if (clip.customSegments && clip.customSegments.length > 0) {
      return clip.customSegments;
    }
    const overlapping = (project.transcript || []).filter(
      (s) => s.end > clip.startTime && s.start < clip.endTime
    );
    if (overlapping.length > 0) return overlapping;
    if (project.transcript && project.transcript.length > 0) {
      const clipDur = Math.max(1, clip.endTime - clip.startTime);
      const firstSeg = project.transcript[0];
      const lastSeg = project.transcript[project.transcript.length - 1];
      const totalSpan = Math.max(1, lastSeg.end - firstSeg.start);
      return project.transcript.map((seg) => {
        const relStart = clip.startTime + ((seg.start - firstSeg.start) / totalSpan) * clipDur;
        const relEnd = clip.startTime + ((seg.end - firstSeg.start) / totalSpan) * clipDur;
        return {
          ...seg,
          start: Number(relStart.toFixed(3)),
          end: Number(Math.max(relStart + 0.25, relEnd).toFixed(3)),
        };
      });
    }
    return [];
  }, [clip.customSegments, project.transcript, clip.startTime, clip.endTime]);

  // Compute active caption chunk + active word for live synchronized preview (60fps audio-locked, 1:1 with ASS export)
  const activeCaptionGroup = useMemo(() => {
    const cs = clip.captionStyle;
    if (!cs.enabled) return null;
    const leadInSec = (cs.wordLeadInMs ?? 35) / 1000;
    const offsetSec = (cs.timingOffsetMs || 0) / 1000 - leadInSec;
    const absTime = clip.startTime + relTime - offsetSec;
    const wordsPerLine = Math.max(1, Math.min(12, cs.wordsPerLine || 4));
    const wordsPerGroup = Math.max(1, Math.min(18, wordsPerLine * cs.maxLines));

    for (const seg of clipSegments) {
      if (absTime < seg.start - 0.04 || absTime > seg.end + 0.06) continue;
      const words: WordTiming[] = seg.words.length
        ? seg.words
        : [{ id: seg.id, word: seg.text, start: seg.start, end: seg.end }];

      for (let i = 0; i < words.length; i += wordsPerGroup) {
        const group = words.slice(i, i + wordsPerGroup);
        if (group.length === 0) continue;
        const gStart = group[0].start;
        const gEnd = group[group.length - 1].end;
        const nextGroupStart = i + wordsPerGroup < words.length ? words[i + wordsPerGroup].start : gEnd + 0.06;
        if (absTime >= gStart - 0.04 && absTime <= Math.max(gEnd + 0.04, nextGroupStart)) {
          let activeIdx = 0;
          for (let wIdx = 0; wIdx < group.length; wIdx++) {
            if (absTime >= group[wIdx].start - 0.01) {
              activeIdx = wIdx;
            } else {
              break;
            }
          }
          return { group, activeIdx, speaker: seg.speaker };
        }
      }
    }
    return null;
  }, [clip.captionStyle, clip.startTime, clipSegments, relTime]);

  // Emphasized keyword callout check
  const activeKeyword = useMemo(() => {
    if (!clip.motionGraphics.keywordCallouts || !activeCaptionGroup) return null;
    const activeWord = activeCaptionGroup.group[activeCaptionGroup.activeIdx]?.word
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '');
    if (!activeWord) return null;
    const match = clip.motionGraphics.emphasizedKeywords.find((kw) => {
      const clean = kw.toLowerCase().replace(/[^a-z0-9]/g, '');
      return clean && (activeWord.includes(clean) || clean.includes(activeWord));
    });
    return match ?? null;
  }, [clip.motionGraphics.keywordCallouts, clip.motionGraphics.emphasizedKeywords, activeCaptionGroup]);

  // Dynamic zoom + punch-in scale factor
  const liveScale = useMemo(() => {
    if (showingRendered || preserveOriginal || reviewFitMode === 'contain') return 1;
    const base = clip.framing.zoom || 1;
    let extra = 1;
    if (clip.motionGraphics.dynamicZoom) {
      const progress = relTime / clipDuration;
      const targetExtra = Math.max(1, clip.motionGraphics.zoomAmount || 1.08);
      if (clip.motionGraphics.cameraMovement === 'ken_burns') {
        extra = 1 + (targetExtra - 1) * progress;
      } else {
        extra = 1 + (targetExtra - 1) * (0.5 + 0.5 * Math.sin(relTime * 0.7));
      }
    }
    if (clip.motionGraphics.punchInOnEmphasis && activeKeyword) {
      extra *= 1.05;
    }
    return base * extra;
  }, [
    clip.framing.zoom,
    clip.motionGraphics,
    relTime,
    clipDuration,
    activeKeyword,
    showingRendered,
    preserveOriginal,
    reviewFitMode,
  ]);

  // Pointer drag handler for Manual Crop mode
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (
      clip.framing.mode !== 'manual' ||
      !onManualFocalChange ||
      showingRendered ||
      preserveOriginal ||
      reviewFitMode === 'contain'
    )
      return;
    setIsDraggingCrop(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingCrop || !onManualFocalChange || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const dx = e.movementX / Math.max(100, rect.width);
    const dy = e.movementY / Math.max(100, rect.height);
    const nextX = Math.max(0.05, Math.min(0.95, Number((clip.framing.manualX - dx).toFixed(3))));
    const nextY = Math.max(0.05, Math.min(0.95, Number((clip.framing.manualY - dy).toFixed(3))));
    onManualFocalChange(nextX, nextY);
  };

  const handlePointerUp = () => {
    setIsDraggingCrop(false);
  };

  const cssFilter = showingRendered || preserveOriginal ? 'none' : buildCssFilterFromGrading(clip.colorGrading);
  const progressPct = Math.min(100, Math.max(0, (relTime / clipDuration) * 100));

  const cs = clip.captionStyle;
  const mg = clip.motionGraphics;

  // 1:1 WYSIWYG EXPORT-PARITY CAPTION GEOMETRY:
  // Mirrors server/renderer.ts -> generateAssSubtitles(project, clip, outWidth, outHeight)
  // In libass, PlayResX = outWidth, PlayResY = outHeight, and:
  //   scaleFactor = Math.min(outWidth, outHeight) / 720
  //   orientationMultiplier = isLandscape ? 1.02 : 1.18
  //   assFontSize = style.fontSize * scaleFactor * orientationMultiplier
  // Because libass font height is in PlayResY pixels (roughly 0.78 cap/em ratio compared to CSS px),
  // scaling directly by Math.min(canvasSize.width, canvasSize.height) / 720 * 0.82 produces pixel-identical
  // word wrapping, line breaks, stroke thickness, box padding, and vertical margins between Live Review and Exported MP4!
  const wysiwygMetrics = useMemo(() => {
    const cw = Math.max(180, canvasSize.width);
    const ch = Math.max(180, canvasSize.height);
    const isLandscape = cw > ch;
    const domScale = Math.min(cw, ch) / 720;
    const orientationMultiplier = isLandscape ? 1.02 : 1.18;
    const libassToCssFactor = 0.82;
    const fontSizePx = Math.max(
      11,
      Math.round(cs.fontSize * domScale * orientationMultiplier * libassToCssFactor)
    );
    const strokePx = cs.strokeWidth > 0 ? Number(Math.max(0.6, cs.strokeWidth * domScale * 0.75).toFixed(2)) : 0;
    const padY = Math.max(3, Math.round((cs.backgroundPadding ?? 10) * domScale * 0.72));
    const padX = Math.max(6, Math.round((cs.backgroundPadding ?? 12) * domScale * 1.15));
    const radiusPx = Math.max(4, Math.round((cs.backgroundRadius ?? 10) * domScale * 0.9));
    const wordGapPx = Math.max(2, Math.round((cs.wordSpacing ?? 4) * Math.max(0.65, domScale * 1.05)));
    const letterSpacingPx =
      cs.letterSpacing !== undefined
        ? Number((cs.letterSpacing * domScale).toFixed(2))
        : cs.uppercase
          ? Number((0.8 * domScale).toFixed(2))
          : 0;
    const marginHPercent = isLandscape ? 7.5 : 6;
    return {
      fontSizePx,
      strokePx,
      padY,
      padX,
      radiusPx,
      wordGapPx,
      letterSpacingPx,
      marginHPercent,
      domScale,
    };
  }, [
    canvasSize.width,
    canvasSize.height,
    cs.fontSize,
    cs.strokeWidth,
    cs.backgroundPadding,
    cs.backgroundRadius,
    cs.wordSpacing,
    cs.letterSpacing,
    cs.uppercase,
  ]);

  const showHook =
    !showingRendered &&
    !preserveOriginal &&
    mg.hookTitleEnabled &&
    mg.hookTitleText.trim() &&
    relTime >= 0.1 &&
    relTime <= mg.hookDuration;
  const showLowerThird =
    !showingRendered &&
    !preserveOriginal &&
    mg.lowerThirdEnabled &&
    mg.speakerLabel.trim() &&
    relTime >= (mg.hookTitleEnabled ? 2.2 : 0.5) &&
    relTime <= (mg.hookTitleEnabled ? 6.7 : 5.0);

  const sourceRatioNum = srcWidth / Math.max(1, srcHeight);
  const isAspectRatioDifferentFromSource = Math.abs(ratio - sourceRatioNum) > 0.08;
  const useContainView =
    preserveOriginal ||
    isNativeOriginalView ||
    reviewFitMode === 'contain' ||
    (!showingRendered && mg.backgroundBlur);

  const handleSelectReviewAspect = (nextRatio: AspectRatio) => {
    setReviewAspectRatio(nextRatio);
    // When switching a vertical 9:16 video to horizontal 16:9 (or vice versa), default to 'contain' (Full Video with blurred cinema backdrop)
    // so the user sees the entire video frame inside the new aspect ratio without cutting off the subject!
    const targetNum = getAspectRatioNumeric(nextRatio, srcWidth, srcHeight);
    const nextFit: 'contain' | 'cover' =
      nextRatio === 'original' || Math.abs(targetNum - sourceRatioNum) > 0.08 ? 'contain' : reviewFitMode;
    setReviewFitMode(nextFit);
    onAspectRatioChange?.(nextRatio, nextFit);
  };

  return (
    <div className="flex flex-col items-center w-full">
      {/* Multi-Aspect Video Review Switcher & Live vs Rendered Verification Bar */}
      {showAspectRatioToolbar && (
        <div className="w-full mb-2.5 flex flex-wrap items-center justify-between gap-1.5 px-2.5 py-1.5 rounded-lg bg-[#09140E] border border-[#D4AF37]/20 text-[11px]">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-zinc-400 font-medium mr-1 inline-flex items-center gap-1">
              <Maximize2 className="w-3 h-3 text-[#F5C451]" />
              Review View:
            </span>
            {REVIEW_ASPECT_OPTIONS.map((opt) => {
              const active = reviewAspectRatio === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSelectReviewAspect(opt.id)}
                  title={opt.label}
                  className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold transition-colors ${
                    active
                      ? 'bg-[#059669] text-white border border-[#F5C451]/60 shadow-sm'
                      : 'bg-[#0E1913] text-zinc-300 hover:bg-[#15261D] border border-[#D4AF37]/15'
                  }`}
                >
                  {opt.short === 'Original'
                    ? `Original (${srcWidth}×${srcHeight})`
                    : opt.short}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            {isAspectRatioDifferentFromSource && !showingRendered && (
              <div className="inline-flex rounded-md overflow-hidden border border-[#D4AF37]/25 bg-[#0C1510]">
                <button
                  type="button"
                  onClick={() => {
                    setReviewFitMode('contain');
                    onAspectRatioChange?.(reviewAspectRatio, 'contain');
                  }}
                  title="Fit full video inside frame with cinema blurred backdrop (zero cropping)"
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    reviewFitMode === 'contain'
                      ? 'bg-[#10B981]/25 text-emerald-200 font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Fit Full Frame
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReviewFitMode('cover');
                    onAspectRatioChange?.(reviewAspectRatio, 'cover');
                  }}
                  title="Fill aspect ratio frame via smart speaker crop"
                  className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                    reviewFitMode === 'cover'
                      ? 'bg-[#10B981]/25 text-emerald-200 font-semibold'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Fill / Crop
                </button>
              </div>
            )}

            {clip.renderedVideoUrl && !previewRendered && (
              <button
                type="button"
                onClick={() => setVerifyRenderedMp4((v) => !v)}
                title="Switch between Live Interactive 1:1 Caption Preview and the actual Rendered Export MP4"
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold border transition-colors ${
                  verifyRenderedMp4
                    ? 'bg-[#D4AF37]/25 border-[#F5C451] text-[#FEF3C7]'
                    : 'bg-[#0E1913] border-[#D4AF37]/25 text-zinc-300 hover:text-white'
                }`}
              >
                {verifyRenderedMp4 ? (
                  <>
                    <Film className="w-3 h-3 text-[#F5C451]" /> Viewing Exported MP4
                  </>
                ) : (
                  <>
                    <Eye className="w-3 h-3 text-emerald-400" /> Verify Export MP4
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Aspect-Ratio Preview Canvas */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ aspectRatio: String(ratio) }}
        className={`relative w-full ${
          ratio >= 1.25 ? 'max-w-full' : ratio >= 0.95 ? 'max-w-[440px]' : 'max-w-[330px]'
        } ${maxHeightClass} mx-auto bg-black rounded-xl overflow-hidden border border-white/[0.12] select-none shadow-2xl ${
          clip.framing.mode === 'manual' && !showingRendered && !useContainView
            ? 'cursor-grab active:cursor-grabbing'
            : ''
        }`}
      >
        {/* Blurred Cinema Backdrop when viewing a 9:16 vertical video inside 16:9 horizontal (or 16:9 inside 9:16) in Fit Full Frame mode */}
        {!showingRendered &&
          (mg.backgroundBlur || (useContainView && isAspectRatioDifferentFromSource)) &&
          videoSrc &&
          !mediaError && (
            <video
              ref={bgVideoRef}
              src={videoSrc}
              muted
              playsInline
              preload="metadata"
              onError={() => {}}
              className="absolute inset-0 w-full h-full object-cover scale-125 blur-2xl opacity-50 pointer-events-none"
            />
          )}

        {/* Primary Video Stream */}
        {videoSrc && !mediaError ? (
          <video
            ref={videoRef}
            src={videoSrc}
            poster={clip.thumbnailUrl || project.thumbnailUrl}
            playsInline
            preload="metadata"
            onLoadedMetadata={() => {
              setMediaError(false);
              if (videoRef.current && !showingRendered) {
                videoRef.current.currentTime = clip.startTime;
              }
            }}
            onTimeUpdate={handleVideoTimeUpdate}
            onEnded={() => setIsPlaying(false)}
            onError={() => {
              setIsPlaying(false);
              setMediaError(true);
            }}
            style={{
              filter: cssFilter,
              opacity: chromaPreviewColor ? 0 : 1,
              objectPosition:
                showingRendered || useContainView
                  ? '50% 50%'
                  : `${(focalPoint.x * 100).toFixed(1)}% ${(focalPoint.y * 100).toFixed(1)}%`,
              transform: showingRendered || useContainView ? 'none' : `scale(${liveScale.toFixed(3)})`,
              transition: isDraggingCrop ? 'none' : 'transform 160ms ease-out',
            }}
            className={`w-full h-full ${
              useContainView ? 'object-contain relative z-10' : 'object-cover'
            }`}
          />
        ) : (
          <div className="relative w-full h-full flex flex-col items-center justify-center text-center p-4 text-xs text-zinc-300 bg-[#07100B]">
            {(clip.thumbnailUrl || project.thumbnailUrl) && !chromaPreviewColor && (
              <img
                src={clip.thumbnailUrl || project.thumbnailUrl}
                alt={clip.title}
                className="absolute inset-0 w-full h-full object-contain opacity-45"
              />
            )}
            {!chromaPreviewColor && (
              <div className="relative z-10 max-w-xs px-3 py-2 rounded-lg bg-black/70 border border-[#D4AF37]/25">
                {project.browserProxyStatus === 'transcoding' && !showingRendered
                  ? 'Preparing browser-compatible H.264 preview in background...'
                  : 'Preview stream unavailable in this browser codec — rendered H.264 MP4 exports will play cleanly.'}
              </div>
            )}
          </div>
        )}

        {/* Live Chroma Key Green/Blue/Black Screen Preview Layer */}
        {chromaPreviewColor && (
          <div
            style={{ backgroundColor: chromaPreviewColor }}
            className="absolute inset-0 z-20 pointer-events-none flex items-start justify-between p-2.5"
          >
            <span className="px-2 py-0.5 rounded bg-black/75 border border-white/20 font-mono text-[10px] font-semibold text-white">
              CHROMA KEY PREVIEW ({chromaPreviewColor.toUpperCase()})
            </span>
          </div>
        )}

        {/* 1:1 Export-Matched WYSIWYG Badge */}
        <div className="absolute top-2.5 left-2.5 z-30 pointer-events-none flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-black/70 backdrop-blur-sm border border-[#10B981]/35 font-mono text-[10px] text-emerald-300">
            <Sparkles className="w-2.5 h-2.5 text-[#F5C451]" />
            {showingRendered
              ? 'Rendered Export MP4'
              : `1:1 Export-Matched Preview · ${
                  reviewAspectRatio === 'original' ? `${srcWidth}×${srcHeight}` : reviewAspectRatio
                }`}
          </span>
        </div>

        {/* Background Music Sync Audio */}
        {activeMusicTrack && !showingRendered && !preserveOriginal && (
          <audio ref={audioRef} src={activeMusicTrack.url} loop preload="none" />
        )}

        {/* Manual Crop Guidance Indicator */}
        {clip.framing.mode === 'manual' && !showingRendered && !useContainView && (
          <div className="absolute top-2.5 right-2.5 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#050A07]/85 border border-[#D4AF37]/25 text-[11px] font-medium text-zinc-200 pointer-events-none">
            <Move className="w-3 h-3 text-[#F5C451]" />
            Drag to crop
          </div>
        )}

        {/* Progress Bar Motion Graphic */}
        {!showingRendered && !preserveOriginal && mg.progressBar !== 'none' && (
          <div
            className={`absolute left-0 right-0 h-1.5 bg-black/45 z-30 ${
              mg.progressBar === 'top' ? 'top-0' : 'bottom-0'
            }`}
          >
            <div
              style={{
                width: `${progressPct}%`,
                backgroundColor: mg.progressBarColor || '#D4AF37',
              }}
              className="h-full transition-[width] duration-100"
            />
          </div>
        )}

        {/* Animated Hook Title Overlay */}
        {showHook && (
          <div className="absolute top-[8%] left-4 right-4 z-30 flex justify-center pointer-events-none animate-caption-slide">
            <div className="px-4 py-2 rounded-lg bg-[#050A07]/88 border border-[#D4AF37]/30 text-center shadow-lg max-w-[92%]">
              <p className="font-display text-sm sm:text-base font-bold text-white leading-snug">
                {mg.hookTitleText}
              </p>
            </div>
          </div>
        )}

        {/* Speaker Lower Third */}
        {showLowerThird && (
          <div className="absolute top-[18%] left-4 z-30 pointer-events-none animate-caption-slide">
            <div className="px-3 py-1.5 rounded-md bg-[#08120C]/90 border border-[#D4AF37]/30">
              <div className="text-xs font-semibold text-white">{mg.speakerLabel}</div>
              {mg.speakerRole && (
                <div className="text-[11px] text-[#F5C451]">{mg.speakerRole}</div>
              )}
            </div>
          </div>
        )}

        {/* Keyword Emphasis Callout */}
        {!showingRendered && !preserveOriginal && activeKeyword && (
          <div className="absolute top-[30%] right-4 z-30 pointer-events-none animate-caption-pop">
            <div className="px-3 py-1 rounded-md bg-[#059669]/95 border border-[#D4AF37]/50 text-[#FEF3C7] text-xs font-bold shadow-lg">
              {activeKeyword.toUpperCase()}
            </div>
          </div>
        )}

        {/* Custom User Text Overlays */}
        {!showingRendered &&
          clip.textOverlays
            .filter((ov) => relTime >= ov.startOffset && relTime <= ov.endOffset)
            .map((ov) => (
              <div
                key={ov.id}
                style={{
                  left: `${ov.x}%`,
                  top: `${ov.y}%`,
                  color: ov.color,
                  backgroundColor: `${ov.bgColor}CC`,
                  fontSize: `${Math.max(11, Math.round((ov.fontSize || 28) * wysiwygMetrics.domScale * 0.82))}px`,
                }}
                className="absolute z-30 -translate-x-1/2 -translate-y-1/2 px-3 py-1 rounded-md font-display font-bold pointer-events-none shadow-md max-w-[85%] text-center"
              >
                {ov.text}
              </div>
            ))}

        {/* Synchronized Word-Level Captions Overlay — 1:1 WYSIWYG match with FFmpeg ASS Subtitle Burn-In */}
        {!showingRendered && cs.enabled && activeCaptionGroup && (() => {
          const hexToRgba = (hex: string, alpha = 1) => {
            const clean = (hex || '#FFFFFF').replace('#', '').trim();
            const full =
              clean.length === 3
                ? clean
                    .split('')
                    .map((c) => c + c)
                    .join('')
                : clean.padEnd(6, 'F').slice(0, 6);
            const r = parseInt(full.slice(0, 2), 16) || 0;
            const g = parseInt(full.slice(2, 4), 16) || 0;
            const b = parseInt(full.slice(4, 6), 16) || 0;
            return `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`;
          };

          const textAlpha = Math.max(0, Math.min(1, cs.textOpacity ?? 1));
          const highlightAlpha = Math.max(0, Math.min(1, cs.highlightOpacity ?? 1));
          const strokeAlpha = Math.max(0, Math.min(1, cs.strokeOpacity ?? 1));
          const shadowAlpha = Math.max(0, Math.min(1, cs.shadowOpacity ?? 0.85));
          const glowAlpha = Math.max(0, Math.min(1, cs.glowOpacity ?? 0.9));

          return (
          <div
            style={{
              // Match libass Alignment (1-3 bottom anchor, 4-6 middle anchor, 7-9 top anchor) & MarginV exactly:
              ...(cs.position === 'top'
                ? {
                    top: `${Math.max(3, Math.min(48, cs.verticalOffset))}%`,
                    transform: 'translate(-50%, 0%)',
                  }
                : cs.position === 'middle'
                  ? {
                      top: `${Math.max(25, Math.min(75, cs.verticalOffset))}%`,
                      transform: 'translate(-50%, -50%)',
                    }
                  : {
                      bottom: `${Math.max(4, Math.min(48, 100 - cs.verticalOffset))}%`,
                      transform: 'translate(-50%, 0%)',
                    }),
              left: `${Math.max(8, Math.min(92, cs.horizontalOffset ?? 50))}%`,
              width: `${100 - wysiwygMetrics.marginHPercent * 2}%`,
              textAlign: cs.alignment,
            }}
            className={`absolute z-30 pointer-events-none flex ${
              cs.alignment === 'left'
                ? 'justify-start'
                : cs.alignment === 'right'
                  ? 'justify-end'
                  : 'justify-center'
            }`}
          >
            <div
              dir={
                isRtlText(activeCaptionGroup.group.map((w) => w.word).join(' ')) ? 'rtl' : 'ltr'
              }
              style={{
                fontFamily: cs.fontFamily,
                fontSize: `${wysiwygMetrics.fontSizePx}px`,
                fontWeight: cs.fontWeight,
                fontStyle: cs.italic ? 'italic' : 'normal',
                letterSpacing: `${wysiwygMetrics.letterSpacingPx}px`,
                lineHeight: cs.lineSpacing || 1.22,
                borderRadius: `${wysiwygMetrics.radiusPx}px`,
                padding: `${wysiwygMetrics.padY}px ${wysiwygMetrics.padX}px`,
                backgroundColor:
                  cs.backgroundOpacity > 0.02
                    ? hexToRgba(cs.backgroundColor, cs.backgroundOpacity)
                    : 'transparent',
                paintOrder: 'stroke fill',
                textShadow:
                  cs.shadow && shadowAlpha > 0.01
                    ? `0 ${Math.max(1, Math.round(2 * wysiwygMetrics.domScale))}px ${Math.max(
                        2,
                        Math.round((cs.shadowBlur ?? 10) * wysiwygMetrics.domScale)
                      )}px ${hexToRgba(cs.shadowColor || '#000000', shadowAlpha)}, 0 1px 2px ${hexToRgba(
                        cs.shadowColor || '#000000',
                        Math.min(1, shadowAlpha * 1.1)
                      )}`
                    : 'none',
                WebkitTextStroke:
                  wysiwygMetrics.strokePx > 0 && strokeAlpha > 0.01 && cs.backgroundOpacity <= 0.05
                    ? `${wysiwygMetrics.strokePx}px ${hexToRgba(cs.strokeColor, strokeAlpha)}`
                    : undefined,
              }}
              className={`inline-block max-w-full ${
                cs.animation === 'pop'
                  ? 'animate-caption-pop'
                  : cs.animation === 'slide'
                    ? 'animate-caption-slide'
                    : cs.animation === 'fade'
                      ? 'animate-caption-fade'
                      : ''
              }`}
            >
              {activeCaptionGroup.group.map((w, idx) => {
                const isActive = cs.wordLevelHighlight && idx === activeCaptionGroup.activeIdx;
                const isKaraokeLit =
                  cs.wordLevelHighlight &&
                  (cs.animation === 'karaoke' || cs.animation === 'typewriter') &&
                  idx <= activeCaptionGroup.activeIdx;
                const isTypewriterHidden =
                  cs.wordLevelHighlight &&
                  cs.animation === 'typewriter' &&
                  idx > activeCaptionGroup.activeIdx;

                const transformMode = cs.textTransform || (cs.uppercase ? 'uppercase' : 'none');
                const displayWord =
                  transformMode === 'uppercase' || cs.uppercase
                    ? w.word.toUpperCase()
                    : transformMode === 'lowercase'
                      ? w.word.toLowerCase()
                      : transformMode === 'capitalize'
                        ? w.word.charAt(0).toUpperCase() + w.word.slice(1).toLowerCase()
                        : w.word;

                const needBreak = idx > 0 && idx % Math.max(1, cs.wordsPerLine) === 0;
                const speed = cs.animationSpeed ?? 1.0;
                const waveAmp = (cs.waveAmplitude ?? 7) * Math.max(0.55, wysiwygMetrics.domScale);
                const activeScale = cs.activeWordScale ?? 1.1;
                const glowRadius = Math.max(
                  2,
                  Math.round((cs.glowIntensity ?? 14) * Math.max(0.55, wysiwygMetrics.domScale))
                );

                // Continuous 60fps sinusoidal wave displacement when Waving Animation is enabled
                const waveY =
                  cs.animation === 'wave'
                    ? Math.sin(relTime * 6.2 * speed + idx * 0.9) *
                      (isActive ? waveAmp * 0.85 : waveAmp * 0.45)
                    : 0;
                const waveRot =
                  cs.animation === 'wave'
                    ? Math.cos(relTime * 6.2 * speed + idx * 0.9) * (isActive ? 2.8 : 1.2)
                    : 0;

                let wordTransform = 'none';
                if (cs.animation === 'wave') {
                  const sc = isActive ? activeScale : 1;
                  wordTransform = `translateY(${waveY.toFixed(1)}px) rotate(${waveRot.toFixed(1)}deg) scale(${sc})`;
                } else if (isActive) {
                  if (cs.animation === 'bounce') {
                    wordTransform = `translateY(-${Math.round(waveAmp * 0.65)}px) scale(${activeScale})`;
                  } else if (
                    cs.animation === 'pop' ||
                    cs.animation === 'karaoke' ||
                    cs.animation === 'typewriter'
                  ) {
                    wordTransform = `scale(${activeScale})`;
                  } else if (cs.animation === 'glow' || cs.animation === 'neon_pulse') {
                    wordTransform = `scale(${Math.max(1.04, activeScale)})`;
                  }
                }

                const hasActivePill =
                  isActive && (cs.activeWordBgOpacity ?? 0) > 0.02 && Boolean(cs.activeWordBgColor);
                const pillBg = hasActivePill
                  ? hexToRgba(cs.activeWordBgColor || '#10B981', cs.activeWordBgOpacity ?? 0.9)
                  : undefined;

                const wordColor =
                  isActive || isKaraokeLit
                    ? hexToRgba(cs.highlightColor, highlightAlpha)
                    : hexToRgba(cs.textColor, textAlpha);

                const showWordGlow =
                  isActive &&
                  glowAlpha > 0.02 &&
                  (cs.glowIntensity ?? 14) > 0 &&
                  (cs.animation === 'glow' ||
                    cs.animation === 'neon_pulse' ||
                    cs.animation === 'wave' ||
                    cs.glowOpacity !== undefined);

                return (
                  <React.Fragment key={w.id}>
                    {needBreak ? <br /> : null}
                    <span
                      key={isActive ? `${w.id}_active` : w.id}
                      style={{
                        color: wordColor,
                        opacity: isTypewriterHidden ? 0 : 1,
                        marginRight: `${wysiwygMetrics.wordGapPx}px`,
                        backgroundColor: pillBg,
                        padding: hasActivePill
                          ? `${Math.max(1, Math.round(2 * wysiwygMetrics.domScale))}px ${Math.max(
                              4,
                              Math.round(6 * wysiwygMetrics.domScale)
                            )}px`
                          : undefined,
                        borderRadius: hasActivePill
                          ? `${Math.max(3, Math.round(6 * wysiwygMetrics.domScale))}px`
                          : undefined,
                        transform: wordTransform,
                        textShadow: showWordGlow
                          ? `0 0 ${glowRadius}px ${hexToRgba(cs.highlightColor, glowAlpha)}, 0 0 ${Math.round(
                              glowRadius * 0.45
                            )}px ${hexToRgba(cs.highlightColor, glowAlpha)}, 0 2px 6px ${hexToRgba(
                              cs.shadowColor || '#000000',
                              shadowAlpha
                            )}`
                          : undefined,
                      }}
                      className={`inline-block ${
                        cs.animation === 'wave'
                          ? ''
                          : isActive && cs.animation === 'bounce'
                            ? 'animate-caption-bounce'
                            : isActive && cs.animation === 'shake'
                              ? 'animate-caption-shake'
                              : isActive && cs.animation === 'flip'
                                ? 'animate-caption-flip'
                                : 'transition-all duration-75'
                      }`}
                    >
                      {displayWord}
                    </span>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
          );
        })()}
      </div>

      {/* Transport Controls */}
      {showControls && (
        <div className="w-full mt-3 flex items-center gap-3 px-1">
          <button
            onClick={() => void togglePlay()}
            aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
            className="studio-btn-primary flex items-center justify-center h-9 w-9 rounded-lg text-white shrink-0"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>

          <button
            onClick={handleRestart}
            aria-label="Restart clip"
            className="flex items-center justify-center h-9 w-9 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-zinc-300 shrink-0 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <input
            type="range"
            min={0}
            max={clipDuration}
            step={0.05}
            value={Math.min(clipDuration, relTime)}
            onChange={(e) => {
              const val = Number(e.target.value);
              setRelTime(val);
              onTimeUpdate?.(val);
              if (videoRef.current) {
                videoRef.current.currentTime = showingRendered ? val : clip.startTime + val;
              }
              if (bgVideoRef.current && !showingRendered) {
                bgVideoRef.current.currentTime = clip.startTime + val;
              }
            }}
            className="flex-1 accent-[#10B981] h-1.5 bg-[#132219] rounded-lg cursor-pointer"
          />

          <span className="font-mono text-xs text-zinc-300 tabular-nums whitespace-nowrap shrink-0">
            {formatTimecode(relTime, true)} / {formatTimecode(clipDuration, true)}
          </span>

          <button
            onClick={() => setIsMuted((m) => !m)}
            aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
            className="flex items-center justify-center h-9 w-9 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-zinc-300 shrink-0 transition-colors"
          >
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      )}
    </div>
  );
}
