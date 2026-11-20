import React, { useEffect, useState } from 'react';
import { Save, CheckCircle2, Loader2, HardDrive, Cpu } from 'lucide-react';
import type {
  AppSettings,
  AspectRatio,
  ExportCodec,
  ExportFps,
  ExportResolution,
  FramingMode,
  HookScoringWeights,
  MotionIntensity,
  SystemCapabilities,
} from '../../shared/types.ts';
import {
  CAPTION_PRESETS,
  DEFAULT_HOOK_SCORING_WEIGHTS,
  SUPPORTED_LANGUAGES,
  VISUAL_STYLE_PRESETS,
} from '../../shared/presets.ts';
import { formatBytes } from '../lib/format.ts';

interface SettingsPageProps {
  settings: AppSettings;
  capabilities: SystemCapabilities | null;
  storage: { totalBytes: number; projectCount: number; clipCount: number } | null;
  onSaveSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

export function SettingsPage({
  settings,
  capabilities,
  storage,
  onSaveSettings,
}: SettingsPageProps) {
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSaveSettings(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Workspace Settings</h1>
          <p className="mt-1 text-xs text-zinc-400">
            Configure default clipping, captioning, framing, and FFmpeg export parameters applied to new projects.
          </p>
        </div>

        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="studio-btn-primary inline-flex items-center gap-2 h-10 px-4 rounded-lg text-xs font-semibold text-white whitespace-nowrap shrink-0"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : saved ? (
            <CheckCircle2 className="w-4 h-4 text-[#FEF3C7]" />
          ) : (
            <Save className="w-4 h-4 text-[#FEF3C7]" />
          )}
          {saved ? 'Defaults Saved' : 'Save Default Settings'}
        </button>
      </div>

      {/* Default Clipping & Styling Preferences */}
      <div className="p-6 rounded-xl studio-panel space-y-5">
        <h2 className="font-display text-sm font-semibold text-white">
          Default AI Analysis & Editing Preferences
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default Spoken Language</label>
            <select
              value={draft.defaultLanguage}
              onChange={(e) => setDraft((d) => ({ ...d, defaultLanguage: e.target.value }))}
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              {SUPPORTED_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code} className="bg-[#0C1510]">
                  {l.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default Clip Duration</label>
            <select
              value={draft.defaultClipDuration}
              onChange={(e) =>
                setDraft((d) => ({ ...d, defaultClipDuration: Number(e.target.value) }))
              }
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              <option value={60} className="bg-[#0C1510]">1 minute</option>
              <option value={120} className="bg-[#0C1510]">2 minutes</option>
              <option value={180} className="bg-[#0C1510]">3 minutes</option>
              <option value={240} className="bg-[#0C1510]">4 minutes</option>
              <option value={300} className="bg-[#0C1510]">5 minutes</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default Clip Count</label>
            <select
              value={draft.defaultClipCount}
              onChange={(e) =>
                setDraft((d) => ({ ...d, defaultClipCount: Number(e.target.value) }))
              }
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              <option value={5} className="bg-[#0C1510]">5 clips</option>
              <option value={10} className="bg-[#0C1510]">10 clips</option>
              <option value={15} className="bg-[#0C1510]">15 clips</option>
              <option value={20} className="bg-[#0C1510]">20 clips</option>
              <option value={30} className="bg-[#0C1510]">30 clips</option>
              <option value={0} className="bg-[#0C1510]">Maximum possible</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default Aspect Ratio</label>
            <select
              value={draft.defaultAspectRatio}
              onChange={(e) =>
                setDraft((d) => ({ ...d, defaultAspectRatio: e.target.value as AspectRatio }))
              }
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              <option value="9:16" className="bg-[#0C1510]">9:16 (Shorts / Reels / TikTok)</option>
              <option value="16:9" className="bg-[#0C1510]">16:9 (Landscape)</option>
              <option value="1:1" className="bg-[#0C1510]">1:1 (Square)</option>
              <option value="4:5" className="bg-[#0C1510]">4:5 (Instagram Portrait)</option>
              <option value="4:3" className="bg-[#0C1510]">4:3 (Traditional)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default Reframing Mode</label>
            <select
              value={draft.defaultFramingMode}
              onChange={(e) =>
                setDraft((d) => ({ ...d, defaultFramingMode: e.target.value as FramingMode }))
              }
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              <option value="ai_auto" className="bg-[#0C1510]">AI Auto Reframe</option>
              <option value="face_track" className="bg-[#0C1510]">Face Tracking</option>
              <option value="manual" className="bg-[#0C1510]">Manual Crop</option>
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default Caption Preset</label>
            <select
              value={draft.defaultCaptionPresetId}
              onChange={(e) => setDraft((d) => ({ ...d, defaultCaptionPresetId: e.target.value }))}
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              {CAPTION_PRESETS.map((p) => (
                <option key={p.id} value={p.id} className="bg-[#0C1510]">
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default Visual Style</label>
            <select
              value={draft.defaultStylePresetId}
              onChange={(e) => setDraft((d) => ({ ...d, defaultStylePresetId: e.target.value }))}
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              {VISUAL_STYLE_PRESETS.map((s) => (
                <option key={s.id} value={s.id} className="bg-[#0C1510]">
                  {s.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1">Default Motion Intensity</label>
            <select
              value={draft.defaultMotionIntensity}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  defaultMotionIntensity: e.target.value as MotionIntensity,
                }))
              }
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              <option value="minimal" className="bg-[#0C1510]">Minimal</option>
              <option value="balanced" className="bg-[#0C1510]">Balanced</option>
              <option value="dynamic" className="bg-[#0C1510]">Dynamic</option>
            </select>
          </div>
        </div>
      </div>

      {/* Default Export Preferences */}
      <div className="p-6 rounded-xl studio-panel space-y-4">
        <h2 className="font-display text-sm font-semibold text-white">Default Export Encoding</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Resolution</label>
            <select
              value={draft.defaultExportResolution}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  defaultExportResolution: e.target.value as ExportResolution,
                }))
              }
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              <option value="720p" className="bg-[#0C1510]">720p HD</option>
              <option value="1080p" className="bg-[#0C1510]">1080p Full HD</option>
              <option value="4k" className="bg-[#0C1510]">4K Ultra HD</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Codec</label>
            <select
              value={draft.defaultExportCodec}
              onChange={(e) =>
                setDraft((d) => ({ ...d, defaultExportCodec: e.target.value as ExportCodec }))
              }
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              <option value="h264" className="bg-[#0C1510]">H.264 (MP4)</option>
              <option value="h265" className="bg-[#0C1510]">H.265 / HEVC</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Frame Rate</label>
            <select
              value={draft.defaultExportFps}
              onChange={(e) =>
                setDraft((d) => ({ ...d, defaultExportFps: Number(e.target.value) as ExportFps }))
              }
              className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
            >
              <option value={24} className="bg-[#0C1510]">24 FPS</option>
              <option value={30} className="bg-[#0C1510]">30 FPS</option>
              <option value={60} className="bg-[#0C1510]">60 FPS</option>
            </select>
          </div>
        </div>
      </div>

      {/* Configurable AI Hook Scoring Weights */}
      <div className="p-6 rounded-xl studio-panel space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-sm font-semibold text-white">
              AI Hook Scoring Rubric Weights
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Customize how the two-pass AI Hook Engine weights each scoring factor (normalized to 0–100).
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                hookScoringWeights: { ...DEFAULT_HOOK_SCORING_WEIGHTS },
              }))
            }
            className="text-xs text-[#F5C451] hover:text-[#FEF3C7] whitespace-nowrap"
          >
            Reset Defaults (20/15/15/15/15/10/10)
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {(
            [
              ['openingHook', 'Opening Hook Strength'],
              ['curiosityInterest', 'Curiosity & Interest'],
              ['emotionalEngagement', 'Emotional Engagement'],
              ['infoEntertainment', 'Info / Entertainment'],
              ['storyCompleteness', 'Story Completeness'],
              ['standaloneContext', 'Standalone Context'],
              ['audioVisualQuality', 'Audio & Visual Quality'],
            ] as Array<[keyof HookScoringWeights, string]>
          ).map(([key, label]) => {
            const weights = draft.hookScoringWeights ?? DEFAULT_HOOK_SCORING_WEIGHTS;
            const val = weights[key];
            return (
              <div
                key={key}
                className="p-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/15 space-y-1.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-300">{label}</span>
                  <span className="font-mono font-semibold text-[#F5C451] tabular-nums">{val}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={40}
                  step={1}
                  value={val}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      hookScoringWeights: {
                        ...(d.hookScoringWeights ?? DEFAULT_HOOK_SCORING_WEIGHTS),
                        [key]: Number(e.target.value),
                      },
                    }))
                  }
                  className="w-full accent-[#10B981]"
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Processing Runtime & Storage Overview */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-5 rounded-xl studio-panel space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Cpu className="w-4 h-4 text-[#F5C451]" />
            Processing Runtime Capabilities
          </div>
          <div className="space-y-1.5 text-xs text-zinc-400">
            <div className="flex justify-between">
              <span>FFmpeg Rendering Engine</span>
              <span className={capabilities?.ffmpegAvailable ? 'text-emerald-400' : 'text-red-400'}>
                {capabilities?.ffmpegAvailable ? 'Available' : 'Missing'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>H.265 / HEVC Encoder</span>
              <span className={capabilities?.h265Supported ? 'text-emerald-400' : 'text-zinc-500'}>
                {capabilities?.h265Supported ? 'Supported' : 'H.264 Only'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Server-Side Gemini AI</span>
              <span className={capabilities?.geminiConfigured ? 'text-emerald-400' : 'text-[#F5C451]'}>
                {capabilities?.geminiConfigured ? 'Connected' : 'Configure in Secrets'}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Max Source Video Duration</span>
              <span className="font-mono text-zinc-200 tabular-nums">
                {capabilities?.maxUploadDurationHours ?? 5} hours
              </span>
            </div>
          </div>
        </div>

        <div className="p-5 rounded-xl studio-panel space-y-2.5">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <HardDrive className="w-4 h-4 text-[#34D399]" />
            Project Media Storage
          </div>
          <div className="space-y-1.5 text-xs text-zinc-400">
            <div className="flex justify-between">
              <span>Total Disk Space Used</span>
              <span className="font-mono text-zinc-200 tabular-nums">
                {formatBytes(storage?.totalBytes ?? 0)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Stored Projects</span>
              <span className="font-mono text-zinc-200 tabular-nums">
                {storage?.projectCount ?? 0}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Total Generated Clips</span>
              <span className="font-mono text-zinc-200 tabular-nums">
                {storage?.clipCount ?? 0}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
