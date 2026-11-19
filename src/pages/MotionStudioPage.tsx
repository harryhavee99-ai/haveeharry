import React, { useEffect, useMemo, useState } from 'react';
import { Save, Layers, CheckCircle2, Loader2, UploadCloud } from 'lucide-react';
import type {
  ClipRecord,
  ColorGradingConfig,
  MotionGraphicsConfig,
  MotionIntensity,
  NavPage,
  ProjectRecord,
} from '../../shared/types.ts';
import {
  VISUAL_STYLE_PRESETS,
  createDefaultMotionGraphics,
  getVisualStylePreset,
} from '../../shared/presets.ts';
import { ClipPreviewPlayer } from '../components/ClipPreviewPlayer.tsx';

interface MotionStudioPageProps {
  project: ProjectRecord | null;
  clipId: string | null;
  onSelectClip: (clipId: string) => void;
  onSaveClip: (projectId: string, clip: ClipRecord) => Promise<ClipRecord>;
  onApplyStyleToAll: (
    projectId: string,
    clipId: string,
    payload: { colorGrading: ColorGradingConfig; motionGraphics: MotionGraphicsConfig }
  ) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

export function MotionStudioPage({
  project,
  clipId,
  onSelectClip,
  onSaveClip,
  onApplyStyleToAll,
  onNavigate,
}: MotionStudioPageProps) {
  const sourceClip = useMemo(() => {
    if (!project || project.clips.length === 0) return null;
    return project.clips.find((c) => c.id === clipId) ?? project.clips[0];
  }, [project, clipId]);

  const [motion, setMotion] = useState<MotionGraphicsConfig>(
    sourceClip ? structuredClone(sourceClip.motionGraphics) : createDefaultMotionGraphics('balanced')
  );
  const [grading, setGrading] = useState<ColorGradingConfig>(
    sourceClip ? { ...sourceClip.colorGrading } : getVisualStylePreset('podcast')
  );
  const [keywordsText, setKeywordsText] = useState(
    sourceClip ? sourceClip.motionGraphics.emphasizedKeywords.join(', ') : ''
  );
  const [saving, setSaving] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (sourceClip) {
      setMotion(structuredClone(sourceClip.motionGraphics));
      setGrading({ ...sourceClip.colorGrading });
      setKeywordsText(sourceClip.motionGraphics.emphasizedKeywords.join(', '));
    }
  }, [sourceClip?.id]);

  if (!project || !sourceClip) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">
          Motion Graphics & Styling Studio
        </h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Upload and analyze a video first to configure context-aware motion graphics and color grading styles.
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

  const parsedMotion: MotionGraphicsConfig = {
    ...motion,
    emphasizedKeywords: keywordsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };

  const previewClip: ClipRecord = {
    ...sourceClip,
    motionGraphics: parsedMotion,
    colorGrading: grading,
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveClip(project.id, previewClip);
      setFeedback('Motion graphics and visual style saved.');
      setTimeout(() => setFeedback(null), 2200);
    } finally {
      setSaving(false);
    }
  };

  const handleApplyAll = async () => {
    setApplyingAll(true);
    try {
      await onApplyStyleToAll(project.id, sourceClip.id, {
        colorGrading: grading,
        motionGraphics: parsedMotion,
      });
      setFeedback(`Applied style & motion settings to all ${project.clips.length} clips.`);
      setTimeout(() => setFeedback(null), 2600);
    } finally {
      setApplyingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">
            Motion Graphics & Visual Styling Studio
          </h1>
          <p className="mt-1 text-xs text-zinc-400">
            Context-aware motion enhancements and 10 color grading looks. Preserves natural facial identity and proportions.
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
            onClick={() => void handleSave()}
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
        {/* Live Preview */}
        <div className="xl:col-span-5 p-5 rounded-xl studio-panel flex flex-col items-center">
          <div className="w-full max-w-[320px]">
            <ClipPreviewPlayer project={project} clip={previewClip} />
          </div>
        </div>

        {/* Motion + Styling Controls */}
        <div className="xl:col-span-7 space-y-5">
          {/* Motion Graphics Engine Panel */}
          <div className="p-5 rounded-xl studio-panel space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <h2 className="font-display text-sm font-semibold text-white">
                Context-Aware Motion Graphics
              </h2>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[#0C1510] border border-[#D4AF37]/15">
                {(['minimal', 'balanced', 'dynamic'] as MotionIntensity[]).map((lvl) => (
                  <button
                    key={lvl}
                    onClick={() =>
                      setMotion((prev) => ({
                        ...createDefaultMotionGraphics(lvl, prev.hookTitleText, prev.speakerLabel),
                        emphasizedKeywords: prev.emphasizedKeywords,
                      }))
                    }
                    className={`px-3 py-1 rounded-md text-xs font-medium capitalize ${
                      motion.intensity === lvl
                        ? 'bg-[#059669] text-white border border-[#D4AF37]/35'
                        : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="flex items-center justify-between text-xs text-zinc-200 cursor-pointer">
                  <span>Animated Hook Title Banner</span>
                  <input
                    type="checkbox"
                    checked={motion.hookTitleEnabled}
                    onChange={(e) =>
                      setMotion((m) => ({ ...m, hookTitleEnabled: e.target.checked }))
                    }
                    className="accent-[#10B981]"
                  />
                </label>
                <input
                  type="text"
                  value={motion.hookTitleText}
                  onChange={(e) => setMotion((m) => ({ ...m, hookTitleText: e.target.value }))}
                  placeholder="Opening title overlay..."
                  className="w-full h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <div className="space-y-2">
                <label className="flex items-center justify-between text-xs text-zinc-200 cursor-pointer">
                  <span>Speaker Name Lower Third</span>
                  <input
                    type="checkbox"
                    checked={motion.lowerThirdEnabled}
                    onChange={(e) =>
                      setMotion((m) => ({ ...m, lowerThirdEnabled: e.target.checked }))
                    }
                    className="accent-[#10B981]"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={motion.speakerLabel}
                    onChange={(e) => setMotion((m) => ({ ...m, speakerLabel: e.target.value }))}
                    placeholder="Speaker Name"
                    className="h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
                  />
                  <input
                    type="text"
                    value={motion.speakerRole}
                    onChange={(e) => setMotion((m) => ({ ...m, speakerRole: e.target.value }))}
                    placeholder="Role / Title"
                    className="h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  Emphasized Keywords (comma-separated)
                </label>
                <input
                  type="text"
                  value={keywordsText}
                  onChange={(e) => setKeywordsText(e.target.value)}
                  placeholder="hook, captions, story"
                  className="w-full h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
                />
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Camera Movement</label>
                <select
                  value={motion.cameraMovement}
                  onChange={(e) =>
                    setMotion((m) => ({
                      ...m,
                      cameraMovement: e.target.value as MotionGraphicsConfig['cameraMovement'],
                    }))
                  }
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                >
                  <option value="none" className="bg-[#0C1510]">Locked Frame</option>
                  <option value="subtle_pan" className="bg-[#0C1510]">Subtle Camera Pan</option>
                  <option value="ken_burns" className="bg-[#0C1510]">Smooth Ken Burns Zoom</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-[#D4AF37]/12 text-xs text-zinc-200">
              {(
                [
                  ['dynamicZoom', 'Dynamic Zoom'],
                  ['punchInOnEmphasis', 'Punch-In on Emphasis'],
                  ['keywordCallouts', 'Animated Callouts'],
                  ['subtleTransitions', 'Fade Transitions'],
                  ['backgroundBlur', 'Blurred Backdrop'],
                  ['animatedShapes', 'Accent Shapes'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(motion[key])}
                    onChange={(e) => setMotion((m) => ({ ...m, [key]: e.target.checked }))}
                    className="accent-[#10B981]"
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Progress Bar</label>
                <select
                  value={motion.progressBar}
                  onChange={(e) =>
                    setMotion((m) => ({
                      ...m,
                      progressBar: e.target.value as MotionGraphicsConfig['progressBar'],
                    }))
                  }
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
                >
                  <option value="bottom" className="bg-[#0C1510]">Bottom Edge</option>
                  <option value="top" className="bg-[#0C1510]">Top Edge</option>
                  <option value="none" className="bg-[#0C1510]">Disabled</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Progress Bar Color</label>
                <div className="flex items-center gap-2 h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18">
                  <input
                    type="color"
                    value={motion.progressBarColor}
                    onChange={(e) =>
                      setMotion((m) => ({ ...m, progressBarColor: e.target.value }))
                    }
                    className="w-6 h-6 bg-transparent border-0 cursor-pointer"
                  />
                  <span className="font-mono text-xs text-zinc-200 uppercase">
                    {motion.progressBarColor}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* AI Video Styling Studio Panel */}
          <div className="p-5 rounded-xl studio-panel space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-white">
                10 Visual Styles & Color Grading
              </h2>
              <label className="flex items-center gap-2 text-xs text-zinc-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={grading.aiEnhance}
                  onChange={(e) => setGrading((g) => ({ ...g, aiEnhance: e.target.checked }))}
                  className="accent-[#10B981]"
                />
                AI Visual Enhance
              </label>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {VISUAL_STYLE_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => setGrading(getVisualStylePreset(preset.id))}
                  className={`px-2.5 py-2 rounded-lg text-xs font-medium text-left transition-colors truncate ${
                    grading.stylePresetId === preset.id
                      ? 'bg-[#059669] text-white border border-[#D4AF37]/40'
                      : 'bg-[#0C1510] text-zinc-300 hover:bg-[#132219] border border-[#D4AF37]/10'
                  }`}
                >
                  {preset.name}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
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
                      {Number(grading[key]).toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={min}
                    max={max}
                    step={step}
                    value={grading[key]}
                    onChange={(e) =>
                      setGrading((g) => ({ ...g, [key]: Number(e.target.value) }))
                    }
                    className="w-full accent-[#10B981]"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
