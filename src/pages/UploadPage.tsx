import React, { useEffect, useRef, useState } from 'react';
import {
  UploadCloud,
  Pause,
  Play,
  X,
  Cpu,
  AlertCircle,
  CheckCircle2,
  Film,
  Sparkles,
  Loader2,
} from 'lucide-react';
import type {
  AnalysisConfig,
  AppSettings,
  AspectRatio,
  FramingMode,
  MotionIntensity,
} from '../../shared/types.ts';
import { CAPTION_PRESETS, SUPPORTED_LANGUAGES, VISUAL_STYLE_PRESETS } from '../../shared/presets.ts';
import { api } from '../lib/api.ts';
import { uploadManager, useUploadManager } from '../lib/uploadManager.ts';
import { formatBytes, formatDurationHuman } from '../lib/format.ts';

interface UploadPageProps {
  settings: AppSettings;
  onStartAnalysis: (projectId: string, config: AnalysisConfig) => Promise<void>;
}

const VALID_EXTS = [
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
];

export function UploadPage({ settings, onStartAnalysis }: UploadPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadState = useUploadManager();

  const [dragActive, setDragActive] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [generatingSample, setGeneratingSample] = useState(false);

  const [durationPreset, setDurationPreset] = useState<string>(
    () => uploadState.savedDurationPreset ?? String(settings.defaultClipDuration)
  );
  const [customDurationSec, setCustomDurationSec] = useState<number>(
    () => uploadState.savedCustomDurationSec ?? 90
  );
  const [config, setConfig] = useState<AnalysisConfig>(
    () =>
      uploadState.savedConfig ?? {
        targetClipDuration: settings.defaultClipDuration,
        clipCount: settings.defaultClipCount,
        language: settings.defaultLanguage,
        aspectRatio: settings.defaultAspectRatio,
        framingMode: settings.defaultFramingMode,
        captionPresetId: settings.defaultCaptionPresetId,
        stylePresetId: settings.defaultStylePresetId,
        motionIntensity: settings.defaultMotionIntensity,
      }
  );

  // Preserve configuration choices if the user explores other pages during an upload
  useEffect(() => {
    uploadManager.saveFormDraft({ config, durationPreset, customDurationSec });
  }, [config, durationPreset, customDurationSec]);

  const effectiveClipDuration =
    durationPreset === 'custom' ? Math.max(10, Math.min(600, customDurationSec)) : Number(durationPreset);

  const uploadInfo = uploadState.info;
  const uploadedProject = uploadState.completedProject;
  const displayError = localError || uploadState.error;
  const hasActiveUploadCard = Boolean(uploadState.fileName && uploadInfo && !uploadedProject);

  const validateAndStartUpload = (file: File) => {
    setLocalError(null);
    uploadManager.clearError();

    const lower = file.name.toLowerCase();
    const valid = VALID_EXTS.some((ext) => lower.endsWith(ext));
    if (!valid) {
      setLocalError('Unsupported file format. Please upload MP4, MOV, MKV, WebM, M4V, AVI, 3GP, WMV, or MPEG video files.');
      return;
    }
    if (file.size <= 0) {
      setLocalError('The selected file appears to be empty.');
      return;
    }

    uploadManager.startUpload(file, {
      ...config,
      targetClipDuration: effectiveClipDuration,
    });
  };

  const handlePauseResume = async () => {
    if (!uploadInfo) return;
    setLocalError(null);
    if (uploadInfo.state === 'uploading') {
      uploadManager.pauseUpload();
    } else if (uploadInfo.state === 'paused' || uploadInfo.state === 'error') {
      await uploadManager.resumeUpload();
    }
  };

  const handleCancelUpload = async () => {
    setLocalError(null);
    await uploadManager.cancelUpload();
  };

  const handleGenerateSample = async () => {
    setLocalError(null);
    uploadManager.clearError();
    setGeneratingSample(true);
    try {
      const project = await api.createSampleProject({
        ...config,
        targetClipDuration: 18,
        clipCount: 3,
      });
      setConfig((c) => ({ ...c, targetClipDuration: 18, clipCount: 3, language: 'en' }));
      setDurationPreset('custom');
      setCustomDurationSec(18);
      uploadManager.setCompletedProject(project);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not create spoken sample video.');
    } finally {
      setGeneratingSample(false);
    }
  };

  const handleAnalyze = async () => {
    if (!uploadedProject) return;
    setLocalError(null);
    setStartingAnalysis(true);
    try {
      uploadManager.dismissBanner();
      await onStartAnalysis(uploadedProject.id, {
        ...config,
        targetClipDuration: effectiveClipDuration,
      });
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Failed to launch AI analysis.');
    } finally {
      setStartingAnalysis(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Upload Video</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Upload videos of any duration and any file size (MP4, MOV, MKV, WebM, AVI, and more). Uploads keep running in the background while you explore any other page.
          </p>
        </div>

        {!hasActiveUploadCard && !uploadedProject && (
          <button
            onClick={() => void handleGenerateSample()}
            disabled={generatingSample}
            className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/25 text-xs font-medium text-zinc-100 transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
          >
            {generatingSample ? (
              <Loader2 className="w-4 h-4 animate-spin text-[#F5C451]" />
            ) : (
              <Sparkles className="w-4 h-4 text-[#F5C451]" />
            )}
            {generatingSample ? 'Synthesizing Spoken Test Video...' : 'Generate Spoken Test Video'}
          </button>
        )}
      </div>

      {displayError && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/30 text-sm text-red-200">
          <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <span>{displayError}</span>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Dropzone / Progress / Video Preview */}
        <div className="xl:col-span-7 space-y-5">
          {!hasActiveUploadCard && !uploadedProject && (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragActive(true);
              }}
              onDragLeave={() => setDragActive(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragActive(false);
                const file = e.dataTransfer.files?.[0];
                if (file) validateAndStartUpload(file);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`group relative overflow-hidden cursor-pointer rounded-2xl border-2 border-dashed p-12 text-center transition-all duration-200 ${
                dragActive
                  ? 'border-[#D4AF37] bg-[#059669]/15 shadow-[0_0_40px_-10px_rgba(212,175,55,0.4)]'
                  : 'border-[#D4AF37]/25 studio-panel hover:border-[#D4AF37]/65'
              }`}
            >
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(16,185,129,0.14),transparent_65%)] opacity-60 group-hover:opacity-100 transition-opacity"
              />
              <input
                ref={fileInputRef}
                type="file"
                accept=".mp4,.mkv,.mov,.webm,.m4v,.avi,.flv,.ts,.3gp,.wmv,.mpeg,.mpg,.mts,.m2ts,.ogv,.vob,video/mp4,video/x-matroska,video/quicktime,video/webm,video/x-msvideo,video/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) validateAndStartUpload(file);
                  e.target.value = '';
                }}
              />
              <div className="relative">
                <div className="mx-auto w-14 h-14 rounded-2xl bg-gradient-to-br from-[#059669]/25 to-[#D4AF37]/20 border border-[#D4AF37]/35 flex items-center justify-center text-[#F5C451] mb-5 group-hover:scale-105 transition-transform">
                  <UploadCloud className="w-7 h-7" />
                </div>
                <h2 className="font-display text-lg font-semibold text-white">
                  Drag and drop your video file here
                </h2>
                <p className="mt-2 text-sm text-zinc-400 max-w-md mx-auto">
                  Or click to browse local files · Any length &amp; any file size · Uninterrupted background 2 MB chunked streaming
                </p>
                <div className="mt-5 pt-4 border-t border-[#D4AF37]/15 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs font-mono text-[#F5C451]">
                  <span>MP4</span>
                  <span className="text-zinc-600" aria-hidden="true">·</span>
                  <span>MKV</span>
                  <span className="text-zinc-600" aria-hidden="true">·</span>
                  <span>MOV</span>
                  <span className="text-zinc-600" aria-hidden="true">·</span>
                  <span>WebM</span>
                  <span className="text-zinc-600" aria-hidden="true">·</span>
                  <span>M4V</span>
                  <span className="text-zinc-600" aria-hidden="true">·</span>
                  <span>AVI</span>
                </div>
                <p className="mt-2 text-[11px] text-zinc-500">
                  MKV and MOV files are automatically prepared for instant browser preview while preserving the original master for HD/4K rendering.
                </p>
              </div>
            </div>
          )}

          {/* Active Chunked Upload Progress Card */}
          {hasActiveUploadCard && uploadInfo && (
            <div className="p-6 rounded-xl studio-panel space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-[#0E1913] border border-[#D4AF37]/20 flex items-center justify-center text-[#F5C451] shrink-0">
                    <Film className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white truncate">
                      {uploadState.fileName}
                    </div>
                    <div className="text-xs text-zinc-400 tabular-nums mt-0.5">
                      {formatBytes(uploadInfo.uploadedBytes)} / {formatBytes(uploadInfo.totalBytes)} · Chunk{' '}
                      {Math.min(uploadInfo.chunkIndex + 1, uploadInfo.totalChunks)} of {uploadInfo.totalChunks}
                    </div>
                  </div>
                </div>
                <span className="font-mono text-lg font-bold text-[#F5C451] tabular-nums">
                  {uploadInfo.percentage}%
                </span>
              </div>

              <div className="h-2.5 rounded-full bg-[#132219] overflow-hidden">
                <div
                  style={{ width: `${uploadInfo.percentage}%` }}
                  className="h-full bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37] transition-[width] duration-150"
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
                <span className="tabular-nums">
                  {uploadInfo.retryNotice
                    ? uploadInfo.retryNotice
                    : uploadInfo.state === 'assembling'
                      ? 'Assembling video chunks and probing media streams with FFprobe...'
                      : uploadInfo.state === 'paused'
                        ? 'Upload paused — ready to resume from last chunk'
                        : uploadInfo.state === 'error'
                          ? `Upload interrupted: ${uploadInfo.error}`
                          : `Streaming at ${formatBytes(uploadInfo.speedBytesPerSec)}/s`}
                </span>
                <div className="flex items-center gap-2">
                  {uploadInfo.state !== 'assembling' && (
                    <button
                      onClick={() => void handlePauseResume()}
                      className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-white"
                    >
                      {uploadInfo.state === 'uploading' ? (
                        <>
                          <Pause className="w-3.5 h-3.5" /> Pause
                        </>
                      ) : (
                        <>
                          <Play className="w-3.5 h-3.5" /> Resume
                        </>
                      )}
                    </button>
                  )}
                  <button
                    onClick={() => void handleCancelUpload()}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-xs font-medium text-red-300"
                  >
                    <X className="w-3.5 h-3.5" /> Cancel
                  </button>
                </div>
              </div>

              <div className="pt-3 border-t border-[#D4AF37]/12 text-[11px] text-[#94A89C]">
                Background upload is active — you can explore Dashboard, Clips, Editor, Captions, Motion &amp; Style, or any other section without stopping this upload.
              </div>
            </div>
          )}

          {/* Uploaded Video Preview & Probed Metadata */}
          {uploadedProject && (
            <div className="rounded-xl studio-panel overflow-hidden">
              <div className="aspect-video bg-black relative">
                {uploadedProject.sourceUrl && (
                  <video
                    src={uploadedProject.sourceUrl}
                    poster={uploadedProject.thumbnailUrl}
                    controls
                    className="w-full h-full object-contain"
                  />
                )}
              </div>
              <div className="p-5 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-xs font-medium text-emerald-400">
                      <CheckCircle2 className="w-4 h-4" />
                      Upload verified and probed by FFprobe
                    </div>
                    <h3 className="mt-1 font-display text-base font-semibold text-white truncate">
                      {uploadedProject.originalFilename}
                    </h3>
                  </div>
                  <button
                    onClick={() => {
                      setLocalError(null);
                      uploadManager.resetForNewUpload();
                    }}
                    className="text-xs text-zinc-400 hover:text-white whitespace-nowrap"
                  >
                    Upload different file
                  </button>
                </div>

                {uploadedProject.metadata && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-white/[0.07] text-xs">
                    <div>
                      <div className="text-zinc-500">Duration</div>
                      <div className="mt-0.5 font-mono font-semibold text-white tabular-nums">
                        {formatDurationHuman(uploadedProject.metadata.duration)}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500">Resolution</div>
                      <div className="mt-0.5 font-mono font-semibold text-white tabular-nums">
                        {uploadedProject.metadata.width}×{uploadedProject.metadata.height}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500">Frame Rate / Codec</div>
                      <div className="mt-0.5 font-mono font-semibold text-white tabular-nums">
                        {uploadedProject.metadata.fps} FPS · {uploadedProject.metadata.codec.toUpperCase()}
                      </div>
                    </div>
                    <div>
                      <div className="text-zinc-500">File Size</div>
                      <div className="mt-0.5 font-mono font-semibold text-white tabular-nums">
                        {formatBytes(uploadedProject.metadata.fileSize)}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right: Clipping & AI Intelligence Configuration */}
        <div className="xl:col-span-5 p-6 rounded-xl studio-panel space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              AI Clipping Configuration
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Customize target duration, clip count, spoken language, framing, and visual defaults before analysis.
            </p>
          </div>

          {/* Target Clip Duration */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">
              Target Clip Duration
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { val: '60', label: '1 min' },
                { val: '120', label: '2 min' },
                { val: '180', label: '3 min' },
                { val: '240', label: '4 min' },
                { val: '300', label: '5 min' },
                { val: 'custom', label: 'Custom' },
              ].map((opt) => (
                <button
                  key={opt.val}
                  type="button"
                  onClick={() => setDurationPreset(opt.val)}
                  className={`h-9 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    durationPreset === opt.val
                      ? 'bg-[#059669] text-white border border-[#D4AF37]/40'
                      : 'bg-[#0C1510] text-zinc-300 hover:bg-[#132219] border border-[#D4AF37]/12'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {durationPreset === 'custom' && (
              <div className="mt-2.5 flex items-center gap-3">
                <input
                  type="number"
                  min={10}
                  max={600}
                  value={customDurationSec}
                  onChange={(e) => setCustomDurationSec(Number(e.target.value) || 30)}
                  className="w-28 h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 font-mono text-xs text-white tabular-nums focus:outline-none focus:border-[#D4AF37]"
                />
                <span className="text-xs text-zinc-400">seconds per clip (10–600s)</span>
              </div>
            )}
          </div>

          {/* Number of Clips */}
          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">
              Number of Clips to Generate
            </label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { val: 5, label: '5 clips' },
                { val: 10, label: '10 clips' },
                { val: 15, label: '15 clips' },
                { val: 20, label: '20 clips' },
                { val: 30, label: '30 clips' },
                { val: 0, label: 'Maximum' },
              ].map((opt) => (
                <button
                  key={opt.val}
                  type="button"
                  onClick={() => setConfig((c) => ({ ...c, clipCount: opt.val }))}
                  className={`h-9 rounded-lg text-xs font-medium transition-colors whitespace-nowrap ${
                    config.clipCount === opt.val
                      ? 'bg-[#059669] text-white border border-[#D4AF37]/40'
                      : 'bg-[#0C1510] text-zinc-300 hover:bg-[#132219] border border-[#D4AF37]/12'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Language & Aspect Ratio */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Spoken Language
              </label>
              <select
                value={config.language}
                onChange={(e) => setConfig((c) => ({ ...c, language: e.target.value }))}
                className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
              >
                {SUPPORTED_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code} className="bg-[#0C1510]">
                    {l.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Output Aspect Ratio
              </label>
              <select
                value={config.aspectRatio}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, aspectRatio: e.target.value as AspectRatio }))
                }
                className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
              >
                <option value="9:16" className="bg-[#0C1510]">9:16 — Shorts / Reels / TikTok</option>
                <option value="16:9" className="bg-[#0C1510]">16:9 — YouTube Landscape</option>
                <option value="1:1" className="bg-[#0C1510]">1:1 — Square Social</option>
                <option value="4:5" className="bg-[#0C1510]">4:5 — Instagram Portrait</option>
                <option value="4:3" className="bg-[#0C1510]">4:3 — Traditional</option>
              </select>
            </div>
          </div>

          {/* Framing, Caption Preset, Visual Style, Motion Intensity */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Reframing Mode
              </label>
              <select
                value={config.framingMode}
                onChange={(e) =>
                  setConfig((c) => ({ ...c, framingMode: e.target.value as FramingMode }))
                }
                className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
              >
                <option value="ai_auto" className="bg-[#0C1510]">AI Auto Reframe</option>
                <option value="face_track" className="bg-[#0C1510]">Face Tracking</option>
                <option value="manual" className="bg-[#0C1510]">Manual Crop</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Caption Preset
              </label>
              <select
                value={config.captionPresetId}
                onChange={(e) => setConfig((c) => ({ ...c, captionPresetId: e.target.value }))}
                className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
              >
                {CAPTION_PRESETS.map((p) => (
                  <option key={p.id} value={p.id} className="bg-[#0C1510]">
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Visual Style
              </label>
              <select
                value={config.stylePresetId}
                onChange={(e) => setConfig((c) => ({ ...c, stylePresetId: e.target.value }))}
                className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
              >
                {VISUAL_STYLE_PRESETS.map((s) => (
                  <option key={s.id} value={s.id} className="bg-[#0C1510]">
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-zinc-300 mb-1.5">
                Motion Graphics Intensity
              </label>
              <select
                value={config.motionIntensity}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    motionIntensity: e.target.value as MotionIntensity,
                  }))
                }
                className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
              >
                <option value="minimal" className="bg-[#0C1510]">Minimal</option>
                <option value="balanced" className="bg-[#0C1510]">Balanced</option>
                <option value="dynamic" className="bg-[#0C1510]">Dynamic</option>
              </select>
            </div>
          </div>

          <div className="pt-2">
            <button
              onClick={() => void handleAnalyze()}
              disabled={!uploadedProject || startingAnalysis}
              className="w-full studio-btn-primary h-11 px-5 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold text-white inline-flex items-center justify-center gap-2"
            >
              {startingAnalysis ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Cpu className="w-4 h-4 text-[#FEF3C7]" />
              )}
              {startingAnalysis ? 'Starting AI Pipeline...' : 'Analyze Video & Generate Clips'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
