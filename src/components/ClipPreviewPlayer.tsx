import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Volume2, VolumeX, RotateCcw, Move } from 'lucide-react';
import type {
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
  maxHeightClass?: string;
  showControls?: boolean;
  previewRendered?: boolean;
}

export function ClipPreviewPlayer({
  project,
  clip,
  musicTracks = [],
  currentTime: externalTime,
  onTimeUpdate,
  onManualFocalChange,
  maxHeightClass = 'max-h-[540px]',
  showControls = true,
  previewRendered = false,
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

  const clipDuration = Math.max(0.5, clip.endTime - clip.startTime);
  const ratio = getAspectRatioNumeric(clip.framing.aspectRatio);
  const showingRendered = Boolean(previewRendered && clip.renderedVideoUrl);
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
    // Face track linear interpolation between surrounding keyframes
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

  // Segments belonging to this clip
  const clipSegments: TranscriptSegment[] = useMemo(() => {
    if (clip.customSegments && clip.customSegments.length > 0) {
      return clip.customSegments;
    }
    return project.transcript.filter((s) => s.end > clip.startTime && s.start < clip.endTime);
  }, [clip.customSegments, project.transcript, clip.startTime, clip.endTime]);

  // Compute active caption chunk + active word for live synchronized preview
  const activeCaptionGroup = useMemo(() => {
    const cs = clip.captionStyle;
    if (!cs.enabled) return null;
    const absTime = clip.startTime + relTime - (cs.timingOffsetMs || 0) / 1000;
    const wordsPerGroup = Math.max(1, Math.min(12, cs.wordsPerLine * cs.maxLines));

    for (const seg of clipSegments) {
      if (absTime < seg.start - 0.08 || absTime > seg.end + 0.08) continue;
      const words: WordTiming[] = seg.words.length
        ? seg.words
        : [{ id: seg.id, word: seg.text, start: seg.start, end: seg.end }];

      for (let i = 0; i < words.length; i += wordsPerGroup) {
        const group = words.slice(i, i + wordsPerGroup);
        if (group.length === 0) continue;
        const gStart = group[0].start;
        const gEnd = group[group.length - 1].end;
        if (absTime >= gStart - 0.06 && absTime <= gEnd + 0.08) {
          let activeIdx = group.findIndex((w) => absTime >= w.start && absTime <= w.end);
          if (activeIdx < 0) {
            activeIdx = group.findIndex((w) => w.start >= absTime);
            if (activeIdx < 0) activeIdx = group.length - 1;
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
    const base = clip.framing.zoom || 1;
    if (showingRendered) return 1;
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
  }, [clip.framing.zoom, clip.motionGraphics, relTime, clipDuration, activeKeyword, showingRendered]);

  // Pointer drag handler for Manual Crop mode
  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (clip.framing.mode !== 'manual' || !onManualFocalChange || showingRendered) return;
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

  const cssFilter = showingRendered ? 'none' : buildCssFilterFromGrading(clip.colorGrading);
  const progressPct = Math.min(100, Math.max(0, (relTime / clipDuration) * 100));

  const cs = clip.captionStyle;
  const mg = clip.motionGraphics;

  const showHook = !showingRendered && mg.hookTitleEnabled && mg.hookTitleText.trim() && relTime >= 0.1 && relTime <= mg.hookDuration;
  const showLowerThird =
    !showingRendered &&
    mg.lowerThirdEnabled &&
    mg.speakerLabel.trim() &&
    relTime >= (mg.hookTitleEnabled ? 2.2 : 0.5) &&
    relTime <= (mg.hookTitleEnabled ? 6.7 : 5.0);

  return (
    <div className="flex flex-col items-center w-full">
      {/* Aspect-Ratio Preview Canvas */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        style={{ aspectRatio: String(ratio) }}
        className={`relative w-full ${maxHeightClass} bg-black rounded-xl overflow-hidden border border-white/[0.1] select-none ${
          clip.framing.mode === 'manual' && !showingRendered ? 'cursor-grab active:cursor-grabbing' : ''
        }`}
      >
        {/* Optional Blurred Background Layer */}
        {!showingRendered && mg.backgroundBlur && videoSrc && !mediaError && (
          <video
            ref={bgVideoRef}
            src={videoSrc}
            muted
            playsInline
            preload="metadata"
            onError={() => {}}
            className="absolute inset-0 w-full h-full object-cover scale-125 blur-2xl opacity-55 pointer-events-none"
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
              objectPosition: showingRendered
                ? '50% 50%'
                : `${(focalPoint.x * 100).toFixed(1)}% ${(focalPoint.y * 100).toFixed(1)}%`,
              transform: showingRendered ? 'none' : `scale(${liveScale.toFixed(3)})`,
              transition: isDraggingCrop ? 'none' : 'transform 160ms ease-out',
            }}
            className={`w-full h-full ${
              !showingRendered && mg.backgroundBlur ? 'object-contain relative z-10' : 'object-cover'
            }`}
          />
        ) : (
          <div className="relative w-full h-full flex flex-col items-center justify-center text-center p-4 text-xs text-zinc-300 bg-[#07100B]">
            {(clip.thumbnailUrl || project.thumbnailUrl) && (
              <img
                src={clip.thumbnailUrl || project.thumbnailUrl}
                alt={clip.title}
                className="absolute inset-0 w-full h-full object-cover opacity-35"
              />
            )}
            <div className="relative z-10 max-w-xs px-3 py-2 rounded-lg bg-black/70 border border-[#D4AF37]/25">
              {project.browserProxyStatus === 'transcoding' && !showingRendered
                ? 'Preparing browser-compatible H.264 preview in background...'
                : 'Preview stream unavailable in this browser codec — rendered H.264 MP4 exports will play cleanly.'}
            </div>
          </div>
        )}

        {/* Background Music Sync Audio */}
        {activeMusicTrack && !showingRendered && (
          <audio ref={audioRef} src={activeMusicTrack.url} loop preload="none" />
        )}

        {/* Manual Crop Guidance Indicator */}
        {clip.framing.mode === 'manual' && !showingRendered && (
          <div className="absolute top-3 right-3 z-30 flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#050A07]/85 border border-[#D4AF37]/25 text-[11px] font-medium text-zinc-200 pointer-events-none">
            <Move className="w-3 h-3 text-[#F5C451]" />
            Drag to crop
          </div>
        )}

        {/* Progress Bar Motion Graphic */}
        {!showingRendered && mg.progressBar !== 'none' && (
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
        {!showingRendered && activeKeyword && (
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
                  fontSize: `${Math.max(12, Math.round(ov.fontSize * 0.55))}px`,
                }}
                className="absolute z-30 -translate-x-1/2 -translate-y-1/2 px-3 py-1 rounded-md font-display font-bold pointer-events-none shadow-md max-w-[85%] text-center"
              >
                {ov.text}
              </div>
            ))}

        {/* Synchronized Word-Level Captions Overlay */}
        {!showingRendered && cs.enabled && activeCaptionGroup && (
          <div
            style={{
              top:
                cs.position === 'top'
                  ? `${Math.max(8, Math.min(40, cs.verticalOffset))}%`
                  : cs.position === 'middle'
                    ? `${Math.max(35, Math.min(68, cs.verticalOffset))}%`
                    : `${Math.max(60, Math.min(90, cs.verticalOffset))}%`,
              textAlign: cs.alignment,
            }}
            className="absolute left-3 right-3 -translate-y-1/2 z-30 pointer-events-none flex justify-center"
          >
            <div
              dir={
                isRtlText(activeCaptionGroup.group.map((w) => w.word).join(' ')) ? 'rtl' : 'ltr'
              }
              style={{
                fontFamily: cs.fontFamily,
                fontSize: `${Math.max(13, Math.round(cs.fontSize * 0.58))}px`,
                fontWeight: cs.fontWeight,
                lineHeight: cs.lineSpacing,
                backgroundColor:
                  cs.backgroundOpacity > 0.04
                    ? `${cs.backgroundColor}${Math.round(cs.backgroundOpacity * 255)
                        .toString(16)
                        .padStart(2, '0')}`
                    : 'transparent',
                textShadow: cs.shadow
                  ? '0 2px 10px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.95)'
                  : 'none',
                WebkitTextStroke:
                  cs.strokeWidth > 0
                    ? `${Math.max(0.5, cs.strokeWidth * 0.45)}px ${cs.strokeColor}`
                    : undefined,
              }}
              className={`inline-block px-3 py-1.5 rounded-lg max-w-[95%] ${
                cs.animation === 'pop'
                  ? 'animate-caption-pop'
                  : cs.animation === 'slide'
                    ? 'animate-caption-slide'
                    : ''
              }`}
            >
              {activeCaptionGroup.group.map((w, idx) => {
                const isActive = cs.wordLevelHighlight && idx === activeCaptionGroup.activeIdx;
                const displayWord = cs.uppercase ? w.word.toUpperCase() : w.word;
                const needBreak = idx > 0 && idx % cs.wordsPerLine === 0;
                return (
                  <React.Fragment key={w.id}>
                    {needBreak ? <br /> : idx > 0 ? ' ' : ''}
                    <span
                      style={{
                        color: isActive ? cs.highlightColor : cs.textColor,
                        transform: isActive && cs.animation === 'pop' ? 'scale(1.07)' : 'none',
                        textShadow:
                          isActive && cs.animation === 'glow'
                            ? `0 0 14px ${cs.highlightColor}, 0 2px 6px rgba(0,0,0,0.9)`
                            : undefined,
                      }}
                      className="inline-block transition-colors duration-75"
                    >
                      {displayWord}
                    </span>
                  </React.Fragment>
                );
              })}
            </div>
          </div>
        )}
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
