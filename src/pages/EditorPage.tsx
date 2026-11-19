import React, { useEffect, useMemo, useState } from 'react';
import {
  Undo2,
  Redo2,
  RotateCcw,
  Save,
  Download,
  Plus,
  Trash2,
  Loader2,
  CheckCircle2,
  Sliders,
  Captions,
  Palette,
  Wand2,
  Music,
  Volume2,
  UploadCloud,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type {
  AspectRatio,
  ClipRecord,
  FramingMode,
  MotionIntensity,
  MusicTrack,
  NavPage,
  ProjectRecord,
  TextOverlayItem,
  TranscriptSegment,
} from '../../shared/types.ts';
import {
  CAPTION_PRESETS,
  VISUAL_STYLE_PRESETS,
  createDefaultMotionGraphics,
  getCaptionPreset,
  getVisualStylePreset,
} from '../../shared/presets.ts';
import { ClipPreviewPlayer } from '../components/ClipPreviewPlayer.tsx';
import { formatDurationHuman, formatTimecode } from '../lib/format.ts';

interface EditorPageProps {
  project: ProjectRecord | null;
  clipId: string | null;
  musicTracks: MusicTrack[];
  onSelectClip: (clipId: string) => void;
  onSaveClip: (projectId: string, clip: ClipRecord) => Promise<ClipRecord>;
  onExportClip: (projectId: string, clipId: string) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

type InspectorTab = 'framing' | 'captions' | 'color' | 'motion' | 'audio';

export function EditorPage({
  project,
  clipId,
  musicTracks,
  onSelectClip,
  onSaveClip,
  onExportClip,
  onNavigate,
}: EditorPageProps) {
  const sourceClip = useMemo(() => {
    if (!project || project.clips.length === 0) return null;
    return project.clips.find((c) => c.id === clipId) ?? project.clips[0];
  }, [project, clipId]);

  const [draft, setDraft] = useState<ClipRecord | null>(sourceClip);
  const [past, setPast] = useState<ClipRecord[]>([]);
  const [future, setFuture] = useState<ClipRecord[]>([]);
  const [activeTab, setActiveTab] = useState<InspectorTab>('framing');
  const [playhead, setPlayhead] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [previewRendered, setPreviewRendered] = useState(false);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);

  useEffect(() => {
    setDraft(sourceClip ? structuredClone(sourceClip) : null);
    setPast([]);
    setFuture([]);
    setPlayhead(0);
    setPreviewRendered(false);
  }, [sourceClip?.id]);

  if (!project || !draft) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">No Clip Loaded in Editor</h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Upload and analyze a video first, then open any generated clip here to trim, caption, grade, and render.
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

  const maxVideoDur = project.metadata?.duration ?? Math.max(draft.endTime, 60);

  const commitChange = (updater: (prev: ClipRecord) => ClipRecord) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = updater(structuredClone(prev));
      next.duration = Number(Math.max(1, next.endTime - next.startTime).toFixed(2));
      setPast((p) => [...p.slice(-24), prev]);
      setFuture([]);
      return next;
    });
  };

  const handleUndo = () => {
    if (past.length === 0 || !draft) return;
    const previous = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [draft, ...f]);
    setDraft(previous);
  };

  const handleRedo = () => {
    if (future.length === 0 || !draft) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, draft]);
    setDraft(next);
  };

  const handleReset = () => {
    if (!sourceClip) return;
    commitChange(() => structuredClone(sourceClip));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const saved = await onSaveClip(project.id, draft);
      setDraft(saved);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleRenderNow = async () => {
    setRendering(true);
    try {
      await onSaveClip(project.id, draft);
      await onExportClip(project.id, draft.id);
      onNavigate('export');
    } finally {
      setRendering(false);
    }
  };

  // Clip transcript segments for manual inline correction
  const editableSegments: TranscriptSegment[] =
    draft.customSegments && draft.customSegments.length > 0
      ? draft.customSegments
      : project.transcript.filter((s) => s.end > draft.startTime && s.start < draft.endTime);

  const updateSegmentText = (segId: string, newText: string) => {
    commitChange((d) => {
      const base =
        d.customSegments && d.customSegments.length > 0
          ? d.customSegments
          : structuredClone(
              project.transcript.filter((s) => s.end > d.startTime && s.start < d.endTime)
            );
      d.customSegments = base.map((seg) => {
        if (seg.id !== segId) return seg;
        const tokens = newText.trim().split(/\s+/).filter(Boolean);
        const dur = Math.max(0.2, seg.end - seg.start);
        const step = tokens.length > 0 ? dur / tokens.length : dur;
        return {
          ...seg,
          text: newText,
          words: tokens.map((word, idx) => ({
            id: seg.words[idx]?.id ?? uuidv4(),
            word,
            start: Number((seg.start + idx * step).toFixed(3)),
            end: Number((seg.start + (idx + 1) * step).toFixed(3)),
          })),
        };
      });
      return d;
    });
  };

  const addTextOverlay = () => {
    const newOv: TextOverlayItem = {
      id: uuidv4(),
      text: 'Key Takeaway',
      startOffset: Number(Math.min(draft.duration - 2, Math.max(0, playhead)).toFixed(1)),
      endOffset: Number(Math.min(draft.duration, Math.max(2, playhead + 3.5)).toFixed(1)),
      x: 50,
      y: 22,
      fontSize: 30,
      color: '#FEF3C7',
      bgColor: '#059669',
      style: 'callout',
    };
    commitChange((d) => {
      d.textOverlays.push(newOv);
      return d;
    });
  };

  return (
    <div className="space-y-5">
      {/* Top Studio Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b border-[#D4AF37]/15">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <select
            value={draft.id}
            onChange={(e) => onSelectClip(e.target.value)}
            className="h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 text-xs font-medium text-white max-w-[280px] truncate focus:outline-none focus:border-[#D4AF37]"
          >
            {project.clips.map((c, idx) => (
              <option key={c.id} value={c.id} className="bg-[#0C1510]">
                Clip {idx + 1}: {c.title}
              </option>
            ))}
          </select>

          <input
            type="text"
            value={draft.title}
            onChange={(e) =>
              commitChange((d) => {
                d.title = e.target.value;
                return d;
              })
            }
            aria-label="Clip title"
            className="h-9 px-3 rounded-lg bg-[#0B130F] border border-[#D4AF37]/18 text-sm font-semibold text-white w-56 sm:w-72 focus:outline-none focus:border-[#D4AF37]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={handleUndo}
            disabled={past.length === 0}
            title="Undo"
            className="h-9 w-9 flex items-center justify-center rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/18 text-zinc-300 disabled:opacity-35"
          >
            <Undo2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleRedo}
            disabled={future.length === 0}
            title="Redo"
            className="h-9 w-9 flex items-center justify-center rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/18 text-zinc-300 disabled:opacity-35"
          >
            <Redo2 className="w-4 h-4" />
          </button>
          <button
            onClick={handleReset}
            title="Reset edits to last saved state"
            className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/18 text-xs font-medium text-zinc-300 whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reset
          </button>

          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/25 text-xs font-semibold text-white whitespace-nowrap"
          >
            {saving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : savedNotice ? (
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Save className="w-3.5 h-3.5 text-[#F5C451]" />
            )}
            {savedNotice ? 'Saved' : 'Save Project'}
          </button>

          <button
            onClick={() => void handleRenderNow()}
            disabled={rendering}
            className="studio-btn-primary inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-semibold text-white whitespace-nowrap"
          >
            {rendering ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5 text-[#FEF3C7]" />}
            Render MP4
          </button>
        </div>
      </div>

      {/* Main Editor Grid: Preview + Timeline on Left, Inspector on Right */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Preview Canvas + Interactive Timeline */}
        <div className="xl:col-span-7 space-y-4">
          <div className="p-5 rounded-xl studio-panel">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs text-zinc-400 font-mono tabular-nums">
                {draft.framing.aspectRatio} · {draft.framing.mode.replace('_', ' ')} ·{' '}
                {formatDurationHuman(draft.duration)}
              </div>
              {draft.renderedVideoUrl && (
                <div className="flex items-center gap-1 p-0.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18">
                  <button
                    onClick={() => setPreviewRendered(false)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium ${
                      !previewRendered ? 'bg-[#059669] text-white' : 'text-zinc-400'
                    }`}
                  >
                    Live Preview
                  </button>
                  <button
                    onClick={() => setPreviewRendered(true)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium ${
                      previewRendered ? 'bg-[#059669] text-white' : 'text-zinc-400'
                    }`}
                  >
                    Rendered MP4
                  </button>
                </div>
              )}
            </div>

            <div className="flex justify-center">
              <div
                className={
                  draft.framing.aspectRatio === '9:16'
                    ? 'w-full max-w-[300px]'
                    : draft.framing.aspectRatio === '4:5'
                      ? 'w-full max-w-[360px]'
                      : draft.framing.aspectRatio === '1:1'
                        ? 'w-full max-w-[420px]'
                        : 'w-full'
                }
              >
                <ClipPreviewPlayer
                  project={project}
                  clip={draft}
                  musicTracks={musicTracks}
                  currentTime={playhead}
                  onTimeUpdate={setPlayhead}
                  previewRendered={previewRendered}
                  onManualFocalChange={(x, y) =>
                    commitChange((d) => {
                      d.framing.manualX = x;
                      d.framing.manualY = y;
                      return d;
                    })
                  }
                />
              </div>
            </div>
          </div>

          {/* Multi-Track Interactive Timeline */}
          <div className="p-4 rounded-xl studio-panel space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-xs font-semibold text-white">
                Clip Timeline & Precision Trim
              </h3>
              <span className="font-mono text-xs text-zinc-400 tabular-nums">
                In {formatTimecode(draft.startTime, true)} → Out {formatTimecode(draft.endTime, true)} (
                {formatDurationHuman(draft.duration)})
              </span>
            </div>

            {/* Source Video Range Visualizer */}
            <div className="space-y-2">
              <div className="relative h-8 rounded-lg bg-[#0C1510] border border-[#D4AF37]/14 overflow-hidden">
                <div
                  style={{
                    left: `${(draft.startTime / Math.max(1, maxVideoDur)) * 100}%`,
                    width: `${Math.max(2, ((draft.endTime - draft.startTime) / Math.max(1, maxVideoDur)) * 100)}%`,
                  }}
                  className="absolute top-0 bottom-0 bg-[#059669]/35 border-x-2 border-[#D4AF37]"
                />
                <div
                  style={{
                    left: `${((draft.startTime + playhead) / Math.max(1, maxVideoDur)) * 100}%`,
                  }}
                  className="absolute top-0 bottom-0 w-0.5 bg-[#FEF3C7]"
                />
                <div className="absolute inset-0 flex items-center px-3 text-[11px] text-zinc-400 pointer-events-none">
                  Video Track · Full Source ({formatTimecode(maxVideoDur)})
                </div>
              </div>

              {/* Caption Cue Track */}
              <div className="relative h-7 rounded-lg bg-[#080F0B] border border-[#D4AF37]/12 overflow-hidden">
                {editableSegments.map((seg) => {
                  const leftPct = Math.max(0, ((seg.start - draft.startTime) / draft.duration) * 100);
                  const widthPct = Math.max(
                    1.5,
                    ((Math.min(draft.endTime, seg.end) - Math.max(draft.startTime, seg.start)) /
                      draft.duration) *
                      100
                  );
                  return (
                    <button
                      key={seg.id}
                      onClick={() => setPlayhead(Math.max(0, seg.start - draft.startTime))}
                      title={seg.text}
                      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
                      className="absolute top-1 bottom-1 rounded bg-[#D4AF37]/25 hover:bg-[#D4AF37]/45 border border-[#D4AF37]/50 px-1 text-[10px] text-[#FEF3C7] truncate text-left"
                    >
                      {seg.text}
                    </button>
                  );
                })}
              </div>

              {/* Trim Sliders */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                    <span>Trim Start (In)</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {formatTimecode(draft.startTime, true)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0, draft.endTime - 3)}
                    step={0.1}
                    value={draft.startTime}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      commitChange((d) => {
                        d.startTime = val;
                        return d;
                      });
                    }}
                    className="w-full accent-[#10B981]"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-zinc-400 mb-1">
                    <span>Trim End (Out)</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {formatTimecode(draft.endTime, true)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={Math.min(maxVideoDur, draft.startTime + 3)}
                    max={maxVideoDur}
                    step={0.1}
                    value={draft.endTime}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      commitChange((d) => {
                        d.endTime = val;
                        return d;
                      });
                    }}
                    className="w-full accent-[#D4AF37]"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Tabbed Editing Inspector */}
        <div className="xl:col-span-5 rounded-xl studio-panel overflow-hidden">
          <div className="grid grid-cols-5 border-b border-[#D4AF37]/15 bg-[#070E0A]">
            {(
              [
                ['framing', 'Frame', Sliders],
                ['captions', 'Captions', Captions],
                ['color', 'Color', Palette],
                ['motion', 'Motion', Wand2],
                ['audio', 'Audio', Music],
              ] as Array<[InspectorTab, string, React.ComponentType<{ className?: string }>]>
            ).map(([tab, label, Icon]) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex flex-col items-center justify-center gap-1 py-3 text-[11px] font-medium transition-colors ${
                  activeTab === tab
                    ? 'text-[#FEF3C7] bg-[#0E1913] border-b-2 border-[#D4AF37]'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Icon className={`w-4 h-4 ${activeTab === tab ? 'text-[#F5C451]' : ''}`} />
                <span>{label}</span>
              </button>
            ))}
          </div>

          <div className="p-5 max-h-[640px] overflow-y-auto space-y-5">
            {/* TAB 1: Aspect Ratio & Smart Reframing */}
            {activeTab === 'framing' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-2">
                    Output Aspect Ratio
                  </label>
                  <div className="grid grid-cols-5 gap-1.5">
                    {(['9:16', '16:9', '1:1', '4:5', '4:3'] as AspectRatio[]).map((ar) => (
                      <button
                        key={ar}
                        onClick={() =>
                          commitChange((d) => {
                            d.framing.aspectRatio = ar;
                            return d;
                          })
                        }
                        className={`h-9 rounded-lg font-mono text-xs font-medium transition-colors ${
                          draft.framing.aspectRatio === ar
                            ? 'bg-[#059669] text-white border border-[#D4AF37]/40'
                            : 'bg-[#0C1510] text-zinc-300 hover:bg-[#132219] border border-[#D4AF37]/10'
                        }`}
                      >
                        {ar}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-2">
                    Smart Reframing Mode
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        ['ai_auto', 'AI Auto Reframe'],
                        ['face_track', 'Face Tracking'],
                        ['manual', 'Manual Crop'],
                      ] as Array<[FramingMode, string]>
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        onClick={() =>
                          commitChange((d) => {
                            d.framing.mode = mode;
                            return d;
                          })
                        }
                        className={`h-9 px-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                          draft.framing.mode === mode
                            ? 'bg-[#059669] text-white border border-[#D4AF37]/40'
                            : 'bg-[#0C1510] text-zinc-300 hover:bg-[#132219] border border-[#D4AF37]/10'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3 pt-1">
                  <div>
                    <div className="flex justify-between text-xs text-zinc-400 mb-1">
                      <span>Horizontal Position (X)</span>
                      <span className="font-mono tabular-nums text-zinc-200">
                        {Math.round(draft.framing.manualX * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.05}
                      max={0.95}
                      step={0.01}
                      value={draft.framing.manualX}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.framing.mode = 'manual';
                          d.framing.manualX = Number(e.target.value);
                          return d;
                        })
                      }
                      className="w-full accent-[#10B981]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-zinc-400 mb-1">
                      <span>Vertical Position (Y)</span>
                      <span className="font-mono tabular-nums text-zinc-200">
                        {Math.round(draft.framing.manualY * 100)}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={0.05}
                      max={0.95}
                      step={0.01}
                      value={draft.framing.manualY}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.framing.mode = 'manual';
                          d.framing.manualY = Number(e.target.value);
                          return d;
                        })
                      }
                      className="w-full accent-[#10B981]"
                    />
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-zinc-400 mb-1">
                      <span>Framing Zoom</span>
                      <span className="font-mono tabular-nums text-zinc-200">
                        {draft.framing.zoom.toFixed(2)}×
                      </span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={2}
                      step={0.02}
                      value={draft.framing.zoom}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.framing.zoom = Number(e.target.value);
                          return d;
                        })
                      }
                      className="w-full accent-[#10B981]"
                    />
                  </div>
                </div>

                <label className="flex items-center justify-between pt-2 border-t border-[#D4AF37]/12 cursor-pointer">
                  <span className="text-xs font-medium text-zinc-200">
                    Blurred Vertical Background Fill
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.motionGraphics.backgroundBlur}
                    onChange={(e) =>
                      commitChange((d) => {
                        d.motionGraphics.backgroundBlur = e.target.checked;
                        return d;
                      })
                    }
                    className="accent-[#10B981] w-4 h-4"
                  />
                </label>
              </>
            )}

            {/* TAB 2: Captions & Inline Transcript Corrections */}
            {activeTab === 'captions' && (
              <>
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-semibold text-white">Enable Synchronized Captions</span>
                  <input
                    type="checkbox"
                    checked={draft.captionStyle.enabled}
                    onChange={(e) =>
                      commitChange((d) => {
                        d.captionStyle.enabled = e.target.checked;
                        return d;
                      })
                    }
                    className="accent-[#10B981] w-4 h-4"
                  />
                </label>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Caption Preset (12 Professional Styles)
                  </label>
                  <select
                    value={draft.captionStyle.presetId}
                    onChange={(e) =>
                      commitChange((d) => {
                        d.captionStyle = getCaptionPreset(e.target.value);
                        return d;
                      })
                    }
                    className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                  >
                    {CAPTION_PRESETS.map((p) => (
                      <option key={p.id} value={p.id} className="bg-[#0C1510]">
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="pt-2 border-t border-[#D4AF37]/12">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-white">
                      Edit Spoken Captions Manually
                    </span>
                    <button
                      onClick={() => onNavigate('captions')}
                      className="text-[11px] text-[#F5C451] hover:text-[#FEF3C7]"
                    >
                      Open full Caption Studio
                    </button>
                  </div>
                  <div className="space-y-2.5">
                    {editableSegments.length === 0 ? (
                      <p className="text-xs text-zinc-500">
                        No spoken transcript lines fall inside this trimmed range.
                      </p>
                    ) : (
                      editableSegments.map((seg) => (
                        <div key={seg.id} className="space-y-1">
                          <div className="flex items-center justify-between font-mono text-[10px] text-zinc-400 tabular-nums">
                            <span>{seg.speaker}</span>
                            <span>
                              {formatTimecode(Math.max(0, seg.start - draft.startTime), true)}
                            </span>
                          </div>
                          <textarea
                            rows={2}
                            value={seg.text}
                            onChange={(e) => updateSegmentText(seg.id, e.target.value)}
                            className="w-full p-2 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-zinc-100 focus:outline-none focus:border-[#D4AF37]"
                          />
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}

            {/* TAB 3: Color Grading & Visual Styles */}
            {activeTab === 'color' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-2">
                    Visual Style Preset
                  </label>
                  <div className="grid grid-cols-2 gap-1.5">
                    {VISUAL_STYLE_PRESETS.map((preset) => (
                      <button
                        key={preset.id}
                        onClick={() =>
                          commitChange((d) => {
                            d.colorGrading = getVisualStylePreset(preset.id);
                            return d;
                          })
                        }
                        className={`px-2.5 py-2 rounded-lg text-left text-xs font-medium transition-colors truncate ${
                          draft.colorGrading.stylePresetId === preset.id
                            ? 'bg-[#059669] text-white border border-[#D4AF37]/40'
                            : 'bg-[#0C1510] text-zinc-300 hover:bg-[#132219] border border-[#D4AF37]/10'
                        }`}
                      >
                        {preset.name}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="flex items-center justify-between pt-2 border-t border-[#D4AF37]/12 cursor-pointer">
                  <div>
                    <div className="text-xs font-medium text-white">AI Visual Enhancement</div>
                    <div className="text-[11px] text-zinc-400">
                      Subtle clarity & exposure balance preserving natural faces
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    checked={draft.colorGrading.aiEnhance}
                    onChange={(e) =>
                      commitChange((d) => {
                        d.colorGrading.aiEnhance = e.target.checked;
                        return d;
                      })
                    }
                    className="accent-[#10B981] w-4 h-4"
                  />
                </label>

                <div className="space-y-3 pt-1">
                  {(
                    [
                      ['brightness', 'Brightness', -0.3, 0.3, 0.01],
                      ['contrast', 'Contrast', 0.6, 1.6, 0.02],
                      ['saturation', 'Saturation', 0, 2, 0.02],
                      ['temperature', 'Temperature', -0.4, 0.4, 0.01],
                      ['highlights', 'Highlights', -0.3, 0.3, 0.01],
                      ['shadows', 'Shadows', -0.3, 0.3, 0.01],
                      ['sharpness', 'Sharpness', 0, 2, 0.05],
                      ['exposure', 'Exposure', -0.3, 0.3, 0.01],
                    ] as const
                  ).map(([key, label, min, max, step]) => (
                    <div key={key}>
                      <div className="flex justify-between text-xs text-zinc-400 mb-1">
                        <span>{label}</span>
                        <span className="font-mono tabular-nums text-zinc-200">
                          {Number(draft.colorGrading[key]).toFixed(2)}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={draft.colorGrading[key]}
                        onChange={(e) =>
                          commitChange((d) => {
                            d.colorGrading[key] = Number(e.target.value);
                            return d;
                          })
                        }
                        className="w-full accent-[#10B981]"
                      />
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* TAB 4: Motion Graphics & Custom Text Overlays */}
            {activeTab === 'motion' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-2">
                    Motion Graphics Intensity
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['minimal', 'balanced', 'dynamic'] as MotionIntensity[]).map((lvl) => (
                      <button
                        key={lvl}
                        onClick={() =>
                          commitChange((d) => {
                            d.motionGraphics = {
                              ...createDefaultMotionGraphics(
                                lvl,
                                d.motionGraphics.hookTitleText,
                                d.motionGraphics.speakerLabel
                              ),
                              emphasizedKeywords: d.motionGraphics.emphasizedKeywords,
                            };
                            return d;
                          })
                        }
                        className={`h-9 rounded-lg text-xs font-medium capitalize ${
                          draft.motionGraphics.intensity === lvl
                            ? 'bg-[#059669] text-white border border-[#D4AF37]/40'
                            : 'bg-[#0C1510] text-zinc-300 hover:bg-[#132219] border border-[#D4AF37]/10'
                        }`}
                      >
                        {lvl}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-xs text-zinc-200">Animated Opening Hook Title</span>
                    <input
                      type="checkbox"
                      checked={draft.motionGraphics.hookTitleEnabled}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.motionGraphics.hookTitleEnabled = e.target.checked;
                          return d;
                        })
                      }
                      className="accent-[#10B981]"
                    />
                  </label>
                  {draft.motionGraphics.hookTitleEnabled && (
                    <input
                      type="text"
                      value={draft.motionGraphics.hookTitleText}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.motionGraphics.hookTitleText = e.target.value;
                          return d;
                        })
                      }
                      placeholder="Opening hook title..."
                      className="w-full h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
                    />
                  )}

                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-xs text-zinc-200">Speaker Name Lower Third</span>
                    <input
                      type="checkbox"
                      checked={draft.motionGraphics.lowerThirdEnabled}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.motionGraphics.lowerThirdEnabled = e.target.checked;
                          return d;
                        })
                      }
                      className="accent-[#10B981]"
                    />
                  </label>
                  {draft.motionGraphics.lowerThirdEnabled && (
                    <input
                      type="text"
                      value={draft.motionGraphics.speakerLabel}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.motionGraphics.speakerLabel = e.target.value;
                          return d;
                        })
                      }
                      placeholder="Speaker name"
                      className="w-full h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
                    />
                  )}

                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-xs text-zinc-200">Dynamic Zoom & Punch-In</span>
                    <input
                      type="checkbox"
                      checked={draft.motionGraphics.dynamicZoom}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.motionGraphics.dynamicZoom = e.target.checked;
                          return d;
                        })
                      }
                      className="accent-[#10B981]"
                    />
                  </label>

                  <div>
                    <label className="block text-xs text-zinc-300 mb-1.5">Progress Bar</label>
                    <select
                      value={draft.motionGraphics.progressBar}
                      onChange={(e) =>
                        commitChange((d) => {
                          d.motionGraphics.progressBar = e.target.value as 'none' | 'top' | 'bottom';
                          return d;
                        })
                      }
                      className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                    >
                      <option value="bottom" className="bg-[#0C1510]">Bottom Edge</option>
                      <option value="top" className="bg-[#0C1510]">Top Edge</option>
                      <option value="none" className="bg-[#0C1510]">Disabled</option>
                    </select>
                  </div>
                </div>

                {/* Custom Text Overlays */}
                <div className="pt-3 border-t border-[#D4AF37]/12 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">Custom Text Overlays</span>
                    <button
                      onClick={addTextOverlay}
                      className="studio-btn-primary inline-flex items-center gap-1 h-7 px-2.5 rounded-md text-[11px] font-medium text-white"
                    >
                      <Plus className="w-3 h-3" /> Add Overlay
                    </button>
                  </div>

                  {draft.textOverlays.map((ov) => (
                    <div
                      key={ov.id}
                      className="p-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/14 space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={ov.text}
                          onChange={(e) =>
                            commitChange((d) => {
                              const target = d.textOverlays.find((x) => x.id === ov.id);
                              if (target) target.text = e.target.value;
                              return d;
                            })
                          }
                          className="flex-1 h-8 px-2.5 rounded bg-[#070E0A] border border-[#D4AF37]/15 text-xs text-white"
                        />
                        <button
                          onClick={() =>
                            commitChange((d) => {
                              d.textOverlays = d.textOverlays.filter((x) => x.id !== ov.id);
                              return d;
                            })
                          }
                          className="p-1.5 text-zinc-500 hover:text-red-400"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <label className="text-zinc-400">
                          Start (s)
                          <input
                            type="number"
                            step={0.5}
                            min={0}
                            max={draft.duration}
                            value={ov.startOffset}
                            onChange={(e) =>
                              commitChange((d) => {
                                const target = d.textOverlays.find((x) => x.id === ov.id);
                                if (target) target.startOffset = Number(e.target.value) || 0;
                                return d;
                              })
                            }
                            className="mt-0.5 w-full h-7 px-2 rounded bg-[#070E0A] border border-[#D4AF37]/15 font-mono text-white"
                          />
                        </label>
                        <label className="text-zinc-400">
                          End (s)
                          <input
                            type="number"
                            step={0.5}
                            min={0}
                            max={draft.duration}
                            value={ov.endOffset}
                            onChange={(e) =>
                              commitChange((d) => {
                                const target = d.textOverlays.find((x) => x.id === ov.id);
                                if (target) target.endOffset = Number(e.target.value) || 3;
                                return d;
                              })
                            }
                            className="mt-0.5 w-full h-7 px-2 rounded bg-[#070E0A] border border-[#D4AF37]/15 font-mono text-white"
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {/* TAB 5: Background Music & Sound Effects */}
            {activeTab === 'audio' && (
              <>
                <div>
                  <div className="flex justify-between text-xs text-zinc-400 mb-1">
                    <span>Original Spoken Audio Volume</span>
                    <span className="font-mono tabular-nums text-zinc-200">
                      {Math.round(draft.audioMix.originalVolume * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1.5}
                    step={0.05}
                    value={draft.audioMix.originalVolume}
                    onChange={(e) =>
                      commitChange((d) => {
                        d.audioMix.originalVolume = Number(e.target.value);
                        return d;
                      })
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-300 mb-2">
                    Royalty-Free Background Music Library
                  </label>
                  <div className="space-y-1.5">
                    <button
                      onClick={() =>
                        commitChange((d) => {
                          d.audioMix.musicTrackId = null;
                          return d;
                        })
                      }
                      className={`w-full px-3 py-2 rounded-lg text-left text-xs font-medium ${
                        draft.audioMix.musicTrackId === null
                          ? 'bg-[#059669] text-white border border-[#D4AF37]/40'
                          : 'bg-[#0C1510] text-zinc-300 hover:bg-[#132219] border border-[#D4AF37]/10'
                      }`}
                    >
                      No Background Music (Original Speech Only)
                    </button>

                    {musicTracks.map((track) => (
                      <div
                        key={track.id}
                        className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg border ${
                          draft.audioMix.musicTrackId === track.id
                            ? 'bg-[#059669]/20 border-[#D4AF37]/60'
                            : 'bg-[#0C1510] border-[#D4AF37]/12'
                        }`}
                      >
                        <button
                          onClick={() =>
                            commitChange((d) => {
                              d.audioMix.musicTrackId = track.id;
                              return d;
                            })
                          }
                          className="text-left min-w-0 flex-1"
                        >
                          <div className="text-xs font-medium text-white truncate">
                            {track.name}
                          </div>
                          <div className="text-[11px] text-zinc-400">
                            {track.category} · {track.bpm} BPM
                          </div>
                        </button>
                        <button
                          onClick={() =>
                            setPreviewAudioUrl((curr) => (curr === track.url ? null : track.url))
                          }
                          title="Preview royalty-free track"
                          className="h-7 w-7 flex items-center justify-center rounded bg-[#14241B] text-[#F5C451] hover:text-white shrink-0"
                        >
                          <Volume2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                  {previewAudioUrl && (
                    <audio src={previewAudioUrl} controls autoPlay className="w-full mt-2 h-8" />
                  )}
                </div>

                {draft.audioMix.musicTrackId && (
                  <div className="space-y-3 pt-2 border-t border-[#D4AF37]/12">
                    <div>
                      <div className="flex justify-between text-xs text-zinc-400 mb-1">
                        <span>Background Music Volume</span>
                        <span className="font-mono tabular-nums text-zinc-200">
                          {Math.round(draft.audioMix.musicVolume * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.02}
                        max={0.6}
                        step={0.02}
                        value={draft.audioMix.musicVolume}
                        onChange={(e) =>
                          commitChange((d) => {
                            d.audioMix.musicVolume = Number(e.target.value);
                            return d;
                          })
                        }
                        className="w-full accent-[#10B981]"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <label className="text-xs text-zinc-400">
                        Fade In (s)
                        <input
                          type="number"
                          min={0}
                          max={5}
                          step={0.5}
                          value={draft.audioMix.fadeInSeconds}
                          onChange={(e) =>
                            commitChange((d) => {
                              d.audioMix.fadeInSeconds = Number(e.target.value) || 0;
                              return d;
                            })
                          }
                          className="mt-1 w-full h-8 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 font-mono text-white"
                        />
                      </label>
                      <label className="text-xs text-zinc-400">
                        Fade Out (s)
                        <input
                          type="number"
                          min={0}
                          max={5}
                          step={0.5}
                          value={draft.audioMix.fadeOutSeconds}
                          onChange={(e) =>
                            commitChange((d) => {
                              d.audioMix.fadeOutSeconds = Number(e.target.value) || 0;
                              return d;
                            })
                          }
                          className="mt-1 w-full h-8 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 font-mono text-white"
                        />
                      </label>
                    </div>

                    <label className="flex items-center justify-between cursor-pointer">
                      <div>
                        <div className="text-xs font-medium text-white">
                          Automatic Speech Ducking
                        </div>
                        <div className="text-[11px] text-zinc-400">
                          FFmpeg sidechain compressor lowers music while speakers talk
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={draft.audioMix.autoDucking}
                        onChange={(e) =>
                          commitChange((d) => {
                            d.audioMix.autoDucking = e.target.checked;
                            return d;
                          })
                        }
                        className="accent-[#10B981] w-4 h-4"
                      />
                    </label>
                  </div>
                )}

                <div className="pt-2 border-t border-[#D4AF37]/12">
                  <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                    Opening Hook Sound Effect
                  </label>
                  <select
                    value={draft.audioMix.sfxOnHook}
                    onChange={(e) =>
                      commitChange((d) => {
                        d.audioMix.sfxOnHook = e.target.value as ClipRecord['audioMix']['sfxOnHook'];
                        return d;
                      })
                    }
                    className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                  >
                    <option value="none" className="bg-[#0C1510]">None</option>
                    <option value="whoosh" className="bg-[#0C1510]">Subtle Whoosh</option>
                    <option value="pop" className="bg-[#0C1510]">Crisp Pop</option>
                    <option value="chime" className="bg-[#0C1510]">Soft Chime</option>
                    <option value="impact" className="bg-[#0C1510]">Low Impact</option>
                  </select>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
