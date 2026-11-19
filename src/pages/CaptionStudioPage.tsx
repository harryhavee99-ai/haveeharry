import React, { useEffect, useMemo, useState } from 'react';
import { Save, Layers, CheckCircle2, Loader2, UploadCloud } from 'lucide-react';
import type {
  CaptionAlignment,
  CaptionAnimation,
  CaptionPosition,
  CaptionStyleConfig,
  ClipRecord,
  NavPage,
  ProjectRecord,
} from '../../shared/types.ts';
import { CAPTION_FONTS, CAPTION_PRESETS, SUPPORTED_LANGUAGES } from '../../shared/presets.ts';
import { ClipPreviewPlayer } from '../components/ClipPreviewPlayer.tsx';

interface CaptionStudioPageProps {
  project: ProjectRecord | null;
  clipId: string | null;
  onSelectClip: (clipId: string) => void;
  onSaveClip: (projectId: string, clip: ClipRecord) => Promise<ClipRecord>;
  onApplyToAll: (
    projectId: string,
    clipId: string,
    style: CaptionStyleConfig
  ) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

export function CaptionStudioPage({
  project,
  clipId,
  onSelectClip,
  onSaveClip,
  onApplyToAll,
  onNavigate,
}: CaptionStudioPageProps) {
  const sourceClip = useMemo(() => {
    if (!project || project.clips.length === 0) return null;
    return project.clips.find((c) => c.id === clipId) ?? project.clips[0];
  }, [project, clipId]);

  const [style, setStyle] = useState<CaptionStyleConfig>(
    sourceClip ? { ...sourceClip.captionStyle } : { ...CAPTION_PRESETS[0].config }
  );
  const [saving, setSaving] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (sourceClip) setStyle({ ...sourceClip.captionStyle });
  }, [sourceClip?.id]);

  if (!project || !sourceClip) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">Caption Studio</h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Generate clips from an uploaded video to customize word-level captions and preview all 12 styles live.
        </p>
        <button
          onClick={() => onNavigate('upload')}
          className="mt-5 studio-btn-primary inline-flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-medium text-white"
        >
          <UploadCloud className="w-4 h-4" /> Upload Video
        </button>
      </div>
    );
  }

  const previewClip: ClipRecord = {
    ...sourceClip,
    captionStyle: style,
  };

  const handleSaveCurrent = async () => {
    setSaving(true);
    try {
      await onSaveClip(project.id, previewClip);
      setFeedback('Caption style saved to clip.');
      setTimeout(() => setFeedback(null), 2200);
    } finally {
      setSaving(false);
    }
  };

  const handleApplyAll = async () => {
    setApplyingAll(true);
    try {
      await onApplyToAll(project.id, sourceClip.id, style);
      setFeedback(`Applied style to all ${project.clips.length} clips.`);
      setTimeout(() => setFeedback(null), 2600);
    } finally {
      setApplyingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Caption Studio</h1>
          <p className="mt-1 text-xs text-zinc-400">
            12 synchronized word-level caption presets · Multilingual support (English, Urdu, Roman Urdu, Hindi, Arabic) · Rendered verbatim via ASS subtitles.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={sourceClip.id}
            onChange={(e) => onSelectClip(e.target.value)}
            className="h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 text-xs text-white max-w-[220px] truncate"
          >
            {project.clips.map((c, idx) => (
              <option key={c.id} value={c.id} className="bg-[#0C1510]">
                Clip {idx + 1}: {c.title}
              </option>
            ))}
          </select>

          <button
            onClick={() => void handleSaveCurrent()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/25 text-xs font-semibold text-white whitespace-nowrap"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5 text-[#F5C451]" />}
            Save to Clip
          </button>

          <button
            onClick={() => void handleApplyAll()}
            disabled={applyingAll}
            className="studio-btn-primary inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-semibold text-white whitespace-nowrap"
          >
            {applyingAll ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Layers className="w-3.5 h-3.5 text-[#FEF3C7]" />
            )}
            Apply to All Clips
          </button>
        </div>
      </div>

      {feedback && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {feedback}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Live Video Caption Preview */}
        <div className="xl:col-span-5 p-5 rounded-xl studio-panel flex flex-col items-center">
          <div className="w-full max-w-[320px]">
            <ClipPreviewPlayer project={project} clip={previewClip} />
          </div>
          <div className="mt-4 w-full pt-3 border-t border-[#D4AF37]/12 flex items-center justify-between text-xs text-zinc-400">
            <span>Detected Language: {project.detectedLanguage || 'Auto'}</span>
            <span>
              Supported: {SUPPORTED_LANGUAGES.slice(1, 6).map((l) => l.label.split(' ')[0]).join(', ')} +
            </span>
          </div>
        </div>

        {/* Right: 12 Presets + Full Granular Controls */}
        <div className="xl:col-span-7 space-y-5">
          {/* 12 Professional Presets Grid */}
          <div className="p-5 rounded-xl studio-panel">
            <h2 className="font-display text-sm font-semibold text-white mb-3">
              12 Professional Caption Presets
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {CAPTION_PRESETS.map((preset) => {
                const active = style.presetId === preset.id;
                const c = preset.config;
                return (
                  <button
                    key={preset.id}
                    onClick={() => setStyle({ ...preset.config })}
                    className={`p-3 rounded-lg border text-left transition-colors ${
                      active
                        ? 'bg-[#059669]/20 border-[#D4AF37]/70'
                        : 'bg-[#0C1510] border-[#D4AF37]/12 hover:border-[#D4AF37]/35'
                    }`}
                  >
                    <div
                      style={{
                        backgroundColor:
                          c.backgroundOpacity > 0.2 ? c.backgroundColor : '#09090D',
                      }}
                      className="h-11 rounded-md flex items-center justify-center px-2 mb-2 overflow-hidden"
                    >
                      <span
                        style={{
                          fontFamily: c.fontFamily,
                          fontWeight: c.fontWeight,
                          color: c.textColor,
                          textShadow: c.shadow ? '0 1px 4px rgba(0,0,0,0.9)' : 'none',
                        }}
                        className="text-xs tracking-tight truncate"
                      >
                        {c.uppercase ? 'MAKE IT ' : 'Make it '}
                        <span style={{ color: c.highlightColor }}>
                          {c.uppercase ? 'POP' : 'pop'}
                        </span>
                      </span>
                    </div>
                    <div className="text-xs font-semibold text-white truncate">{preset.name}</div>
                    <div className="text-[11px] text-zinc-400 line-clamp-1 mt-0.5">
                      {preset.description}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Full Customization Controls */}
          <div className="p-5 rounded-xl studio-panel space-y-5">
            <h2 className="font-display text-sm font-semibold text-white">
              Typography, Colors, Layout & Timing
            </h2>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Font Family</label>
                <select
                  value={style.fontFamily}
                  onChange={(e) => setStyle((s) => ({ ...s, fontFamily: e.target.value }))}
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                >
                  {CAPTION_FONTS.map((f) => (
                    <option key={f} value={f} className="bg-[#0C1510]">
                      {f}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Font Weight</label>
                <select
                  value={style.fontWeight}
                  onChange={(e) =>
                    setStyle((s) => ({
                      ...s,
                      fontWeight: Number(e.target.value) as CaptionStyleConfig['fontWeight'],
                    }))
                  }
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                >
                  <option value={500} className="bg-[#0C1510]">Medium (500)</option>
                  <option value={600} className="bg-[#0C1510]">SemiBold (600)</option>
                  <option value={700} className="bg-[#0C1510]">Bold (700)</option>
                  <option value={800} className="bg-[#0C1510]">ExtraBold (800)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Animation Style</label>
                <select
                  value={style.animation}
                  onChange={(e) =>
                    setStyle((s) => ({ ...s, animation: e.target.value as CaptionAnimation }))
                  }
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                >
                  <option value="pop" className="bg-[#0C1510]">Pop Scale</option>
                  <option value="karaoke" className="bg-[#0C1510]">Karaoke Sweep</option>
                  <option value="fade" className="bg-[#0C1510]">Smooth Fade</option>
                  <option value="slide" className="bg-[#0C1510]">Slide Up</option>
                  <option value="glow" className="bg-[#0C1510]">Neon Glow</option>
                  <option value="none" className="bg-[#0C1510]">Static</option>
                </select>
              </div>
            </div>

            {/* Color Pickers */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {(
                [
                  ['textColor', 'Text Color'],
                  ['highlightColor', 'Highlight Color'],
                  ['backgroundColor', 'Background'],
                  ['strokeColor', 'Outline Stroke'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="block text-xs text-zinc-400">
                  {label}
                  <div className="mt-1 flex items-center gap-2 h-9 px-2 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18">
                    <input
                      type="color"
                      value={style[key]}
                      onChange={(e) => setStyle((s) => ({ ...s, [key]: e.target.value }))}
                      className="w-6 h-6 rounded bg-transparent border-0 cursor-pointer"
                    />
                    <span className="font-mono text-[11px] text-zinc-200 uppercase">
                      {style[key]}
                    </span>
                  </div>
                </label>
              ))}
            </div>

            {/* Sliders */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>Font Size</span>
                  <span className="font-mono tabular-nums text-zinc-200">{style.fontSize}px</span>
                </div>
                <input
                  type="range"
                  min={18}
                  max={60}
                  value={style.fontSize}
                  onChange={(e) => setStyle((s) => ({ ...s, fontSize: Number(e.target.value) }))}
                  className="w-full accent-[#10B981]"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>Background Opacity</span>
                  <span className="font-mono tabular-nums text-zinc-200">
                    {Math.round(style.backgroundOpacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={style.backgroundOpacity}
                  onChange={(e) =>
                    setStyle((s) => ({ ...s, backgroundOpacity: Number(e.target.value) }))
                  }
                  className="w-full accent-[#10B981]"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>Outline Stroke Width</span>
                  <span className="font-mono tabular-nums text-zinc-200">{style.strokeWidth}px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={6}
                  step={0.5}
                  value={style.strokeWidth}
                  onChange={(e) => setStyle((s) => ({ ...s, strokeWidth: Number(e.target.value) }))}
                  className="w-full accent-[#10B981]"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>Line Spacing</span>
                  <span className="font-mono tabular-nums text-zinc-200">
                    {style.lineSpacing.toFixed(2)}
                  </span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={1.7}
                  step={0.05}
                  value={style.lineSpacing}
                  onChange={(e) => setStyle((s) => ({ ...s, lineSpacing: Number(e.target.value) }))}
                  className="w-full accent-[#10B981]"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>Words Per Line</span>
                  <span className="font-mono tabular-nums text-zinc-200">{style.wordsPerLine}</span>
                </div>
                <input
                  type="range"
                  min={2}
                  max={8}
                  value={style.wordsPerLine}
                  onChange={(e) => setStyle((s) => ({ ...s, wordsPerLine: Number(e.target.value) }))}
                  className="w-full accent-[#10B981]"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1">
                  <span>Caption Timing Sync Offset</span>
                  <span className="font-mono tabular-nums text-zinc-200">
                    {style.timingOffsetMs > 0 ? `+${style.timingOffsetMs}` : style.timingOffsetMs} ms
                  </span>
                </div>
                <input
                  type="range"
                  min={-500}
                  max={500}
                  step={25}
                  value={style.timingOffsetMs}
                  onChange={(e) =>
                    setStyle((s) => ({ ...s, timingOffsetMs: Number(e.target.value) }))
                  }
                  className="w-full accent-[#10B981]"
                />
              </div>
            </div>

            {/* Position, Alignment, Max Lines, Toggles */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2 border-t border-[#D4AF37]/12">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Vertical Zone</label>
                <select
                  value={style.position}
                  onChange={(e) => {
                    const pos = e.target.value as CaptionPosition;
                    setStyle((s) => ({
                      ...s,
                      position: pos,
                      verticalOffset: pos === 'top' ? 18 : pos === 'middle' ? 50 : 76,
                    }));
                  }}
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                >
                  <option value="top" className="bg-[#0C1510]">Top</option>
                  <option value="middle" className="bg-[#0C1510]">Middle</option>
                  <option value="bottom" className="bg-[#0C1510]">Bottom</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Alignment</label>
                <select
                  value={style.alignment}
                  onChange={(e) =>
                    setStyle((s) => ({ ...s, alignment: e.target.value as CaptionAlignment }))
                  }
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                >
                  <option value="left" className="bg-[#0C1510]">Left</option>
                  <option value="center" className="bg-[#0C1510]">Center</option>
                  <option value="right" className="bg-[#0C1510]">Right</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Max Lines</label>
                <select
                  value={style.maxLines}
                  onChange={(e) =>
                    setStyle((s) => ({ ...s, maxLines: Number(e.target.value) as 1 | 2 | 3 }))
                  }
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                >
                  <option value={1} className="bg-[#0C1510]">1 Line</option>
                  <option value={2} className="bg-[#0C1510]">2 Lines</option>
                  <option value={3} className="bg-[#0C1510]">3 Lines</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-6 pt-1 text-xs text-zinc-200">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={style.wordLevelHighlight}
                  onChange={(e) =>
                    setStyle((s) => ({ ...s, wordLevelHighlight: e.target.checked }))
                  }
                  className="accent-[#10B981]"
                />
                Word-Level Highlighting
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={style.uppercase}
                  onChange={(e) => setStyle((s) => ({ ...s, uppercase: e.target.checked }))}
                  className="accent-[#10B981]"
                />
                ALL CAPS
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={style.shadow}
                  onChange={(e) => setStyle((s) => ({ ...s, shadow: e.target.checked }))}
                  className="accent-[#10B981]"
                />
                Drop Shadow
              </label>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
