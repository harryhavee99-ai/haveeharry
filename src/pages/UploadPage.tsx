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
  Captions,
  Scissors,
  ShieldCheck,
  FileText,
  Download,
  Zap,
  Globe,
  Waves,
} from 'lucide-react';
import type {
  AnalysisConfig,
  AppSettings,
  AspectRatio,
  CaptionAnimation,
  ClipRecord,
  FramingMode,
  MotionIntensity,
  ProcessingMode,
  ProjectRecord,
} from '../../shared/types.ts';
import { CAPTION_PRESETS, SUPPORTED_LANGUAGES, VISUAL_STYLE_PRESETS } from '../../shared/presets.ts';
import { api } from '../lib/api.ts';
import { uploadManager, useUploadManager } from '../lib/uploadManager.ts';
import { formatBytes, formatDurationHuman } from '../lib/format.ts';

interface UploadPageProps {
  settings: AppSettings;
  onStartAnalysis: (projectId: string, config: AnalysisConfig) => Promise<void>;
  onCreateTranscriptProject?: (payload: {
    name?: string;
    content: string;
    filename?: string;
    language?: string;
    aspectRatio?: '9:16' | '16:9' | '1:1' | '4:5';
    captionPresetId?: string;
    animation?: CaptionAnimation;
    targetDurationSeconds?: number;
  }) => Promise<{ project: ProjectRecord; clip: ClipRecord }>;
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
  '.3g2',
  '.wmv',
  '.asf',
  '.mpeg',
  '.mpg',
  '.mts',
  '.m2ts',
  '.ogv',
  '.ogg',
  '.vob',
  '.f4v',
  '.divx',
  '.mxf',
  '.rm',
  '.rmvb',
];

export function UploadPage({ settings, onStartAnalysis, onCreateTranscriptProject }: UploadPageProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const transcriptFileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadState = useUploadManager();

  const [dragActive, setDragActive] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [startingAnalysis, setStartingAnalysis] = useState(false);
  const [generatingSample, setGeneratingSample] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | undefined>(undefined);
  const [repairingPreview, setRepairingPreview] = useState(false);

  // Transcript-to-Animated-Captions Studio state
  const [transcriptTitle, setTranscriptTitle] = useState('SkaDoosh Animated Captions');
  const [transcriptFilename, setTranscriptFilename] = useState<string | undefined>(undefined);
  const [transcriptContent, setTranscriptContent] = useState('');
  const [transcriptLanguage, setTranscriptLanguage] = useState<string>('hinglish');
  const [transcriptAspectRatio, setTranscriptAspectRatio] = useState<'9:16' | '16:9' | '1:1' | '4:5'>('9:16');
  const [transcriptPresetId, setTranscriptPresetId] = useState<string>('ocean-wave-flow');
  const [transcriptAnimation, setTranscriptAnimation] = useState<CaptionAnimation>('wave');
  const [creatingTranscriptStudio, setCreatingTranscriptStudio] = useState(false);
  const [downloadingDirectChroma, setDownloadingDirectChroma] = useState(false);

  const [durationPreset, setDurationPreset] = useState<string>(
    () => uploadState.savedDurationPreset ?? String(settings.defaultClipDuration)
  );
  const [customDurationSec, setCustomDurationSec] = useState<number>(
    () => uploadState.savedCustomDurationSec ?? 90
  );
  const [config, setConfig] = useState<AnalysisConfig>(
    () =>
      uploadState.savedConfig ?? {
        mode: 'auto_clips',
        targetClipDuration: settings.defaultClipDuration,
        clipCount: settings.defaultClipCount,
        language: settings.defaultLanguage,
        aspectRatio: 'original',
        framingMode: settings.defaultFramingMode,
        captionPresetId: settings.defaultCaptionPresetId,
        stylePresetId: settings.defaultStylePresetId,
        motionIntensity: settings.defaultMotionIntensity,
      }
  );
  const processingMode: ProcessingMode = config.mode === 'captions_only' ? 'captions_only' : 'auto_clips';

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

  useEffect(() => {
    setPreviewError(false);
    setLocalPreviewUrl(undefined);
  }, [uploadedProject?.id, uploadedProject?.sourceUrl]);

  const handleEnsureUploadH264Preview = async (force = true) => {
    if (!uploadedProject || repairingPreview) return;
    setRepairingPreview(true);
    try {
      const res = await api.ensureBrowserPreview(uploadedProject.id, force);
      if (res.sourceUrl) {
        setLocalPreviewUrl(res.sourceUrl);
        setPreviewError(false);
      }
    } catch {
      // ignore
    } finally {
      setRepairingPreview(false);
    }
  };

  useEffect(() => {
    if (!uploadedProject) return;
    const effectiveUrl = localPreviewUrl || uploadedProject.sourceUrl;
    if (!effectiveUrl || uploadedProject.browserProxyStatus === 'transcoding') {
      const timer = setInterval(async () => {
        try {
          const res = await api.ensureBrowserPreview(uploadedProject.id, false);
          if (res.sourceUrl && res.browserProxyStatus === 'ready') {
            setLocalPreviewUrl(res.sourceUrl);
            setPreviewError(false);
          }
        } catch {
          // ignore
        }
      }, 2500);
      return () => clearInterval(timer);
    }
  }, [uploadedProject, localPreviewUrl]);

  const validateAndStartUpload = (file: File) => {
    setLocalError(null);
    uploadManager.clearError();

    const lower = file.name.toLowerCase();
    const valid = VALID_EXTS.some((ext) => lower.endsWith(ext));
    if (!valid) {
      setLocalError('Unsupported file format. Please upload MP4, MOV, MKV, WebM, M4V, AVI, FLV, TS, 3GP, WMV, MPEG, MTS, VOB, or MXF video files.');
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

  const handleLoadTranscriptFile = async (file: File) => {
    setLocalError(null);
    try {
      const text = await file.text();
      if (!text.trim()) {
        setLocalError('Selected transcript file is empty.');
        return;
      }
      setTranscriptFilename(file.name);
      setTranscriptTitle(file.name.replace(/\.(srt|vtt|txt|ass|ssa|json)$/i, '') || 'Transcript Captions');
      setTranscriptContent(text);
    } catch {
      setLocalError('Could not read transcript file.');
    }
  };

  const handleOpenTranscriptInCaptionStudio = async (andDownloadChroma = false) => {
    if (!transcriptContent.trim()) {
      setLocalError('Please upload a transcript file (.SRT, .VTT, .TXT, .ASS, .JSON) or paste transcript text first.');
      return;
    }
    setLocalError(null);
    if (andDownloadChroma) {
      setDownloadingDirectChroma(true);
    } else {
      setCreatingTranscriptStudio(true);
    }
    try {
      const payload = {
        name: transcriptTitle.trim() || 'Animated Captions',
        content: transcriptContent,
        filename: transcriptFilename,
        language: transcriptLanguage,
        aspectRatio: transcriptAspectRatio,
        captionPresetId: transcriptPresetId,
        animation: transcriptAnimation,
      };
      const res = onCreateTranscriptProject
        ? await onCreateTranscriptProject(payload)
        : await api.createProjectFromTranscript(payload);

      if (andDownloadChroma) {
        await api.downloadClipChromaCaptionsMp4(res.project.id, res.clip.id, res.clip.title, {
          chromaColor: '#00FF00',
          includeAudio: false,
          resolution: '1080p',
        });
      }
    } catch (err) {
      setLocalError(
        err instanceof Error ? err.message : 'Failed to generate animated captions from transcript.'
      );
    } finally {
      setCreatingTranscriptStudio(false);
      setDownloadingDirectChroma(false);
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
                  Or click to browse local files · Any length &amp; any file size · High-Speed 3x Parallel 4 MB Multi-Stream Engine
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-1.5">
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-[#059669]/20 border border-[#10B981]/35 text-[11px] font-medium text-emerald-300">
                    <Zap className="w-3 h-3 text-[#F5C451]" /> 3× Parallel Streams (4 MB Chunks)
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-[#0E1913] border border-[#D4AF37]/25 text-[11px] font-medium text-zinc-200">
                    <Globe className="w-3 h-3 text-[#F5C451]" /> Hinglish · Roman Urdu · اردو · English
                  </span>
                </div>
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

          {/* Active High-Speed Multi-Stream Upload Telemetry Card */}
          {hasActiveUploadCard && uploadInfo && (
            <div className="p-6 rounded-xl studio-panel space-y-4 border border-[#10B981]/35">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-[#0E1913] border border-[#D4AF37]/25 flex items-center justify-center text-[#F5C451] shrink-0">
                    <Film className="w-5 h-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white truncate">
                        {uploadState.fileName}
                      </span>
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#059669]/25 border border-[#10B981]/40 font-mono text-[10px] font-semibold text-emerald-300 shrink-0">
                        <Zap className="w-2.5 h-2.5 text-[#F5C451]" />
                        {uploadInfo.parallelStreams ?? 3}× TURBO
                      </span>
                    </div>
                    <div className="text-xs text-zinc-400 tabular-nums mt-0.5">
                      {formatBytes(uploadInfo.uploadedBytes)} / {formatBytes(uploadInfo.totalBytes)} ·{' '}
                      {uploadInfo.completedChunks ?? uploadInfo.chunkIndex} of {uploadInfo.totalChunks} chunks verified (4 MB/chunk)
                    </div>
                  </div>
                </div>
                <span className="font-mono text-xl font-bold text-[#F5C451] tabular-nums">
                  {uploadInfo.percentage}%
                </span>
              </div>

              <div className="h-2.5 rounded-full bg-[#132219] overflow-hidden">
                <div
                  style={{ width: `${uploadInfo.percentage}%` }}
                  className="h-full bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37] transition-[width] duration-100"
                />
              </div>

              {/* High-End Live Upload Telemetry Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
                <div className="p-2.5 rounded-lg bg-[#09130E] border border-[#D4AF37]/15">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Live Speed</div>
                  <div className="mt-0.5 font-mono text-xs font-semibold text-emerald-300 tabular-nums">
                    {formatBytes(uploadInfo.speedBytesPerSec)}/s
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#09130E] border border-[#D4AF37]/15">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Peak Speed</div>
                  <div className="mt-0.5 font-mono text-xs font-semibold text-[#F5C451] tabular-nums">
                    {formatBytes(uploadInfo.peakSpeedBytesPerSec || uploadInfo.speedBytesPerSec)}/s
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#09130E] border border-[#D4AF37]/15">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Est. Remaining</div>
                  <div className="mt-0.5 font-mono text-xs font-semibold text-white tabular-nums">
                    {uploadInfo.etaSeconds !== undefined && uploadInfo.etaSeconds > 0
                      ? formatDurationHuman(uploadInfo.etaSeconds)
                      : uploadInfo.state === 'assembling' || uploadInfo.state === 'verifying'
                        ? 'Finalizing...'
                        : 'Calculating...'}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-[#09130E] border border-[#D4AF37]/15">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500">Parallel Streams</div>
                  <div className="mt-0.5 font-mono text-xs font-semibold text-zinc-200 tabular-nums">
                    {uploadInfo.activeWorkers ?? 1} active / {uploadInfo.parallelStreams ?? 3} max
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-400">
                <span className="tabular-nums">
                  {uploadInfo.retryNotice
                    ? uploadInfo.retryNotice
                    : uploadInfo.state === 'verifying'
                      ? 'Verifying all uploaded chunks on server disk...'
                      : uploadInfo.state === 'assembling'
                        ? 'Stream-assembling video & probing media streams with FFprobe...'
                        : uploadInfo.state === 'paused'
                          ? 'Upload paused — click Resume Upload to continue from last verified chunk'
                          : uploadInfo.state === 'error'
                            ? `Upload interrupted: ${uploadInfo.error}`
                            : `Streaming via ${uploadInfo.parallelStreams ?? 3} concurrent workers · Elapsed ${uploadInfo.elapsedSeconds ?? 0}s`}
                </span>
                <div className="flex items-center gap-2">
                  {uploadInfo.state !== 'assembling' && uploadInfo.state !== 'verifying' && (
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
                          <Play className="w-3.5 h-3.5 text-[#10B981]" /> Resume Upload
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

          {/* Uploaded Video Preview & Probed Metadata — Displays in Original Source Size & Aspect Ratio with Multi-Aspect Review Switcher */}
          {uploadedProject && (() => {
            const natW = uploadedProject.metadata?.width && uploadedProject.metadata.width >= 64 ? uploadedProject.metadata.width : 1920;
            const natH = uploadedProject.metadata?.height && uploadedProject.metadata.height >= 64 ? uploadedProject.metadata.height : 1080;
            const natRatio = natW / natH;
            const activeUploadPreviewRatio =
              config.aspectRatio === 'original'
                ? natRatio
                : config.aspectRatio === '9:16'
                  ? 9 / 16
                  : config.aspectRatio === '16:9'
                    ? 16 / 9
                    : config.aspectRatio === '1:1'
                      ? 1
                      : config.aspectRatio === '4:5'
                        ? 4 / 5
                        : 4 / 3;
            const isVerticalView = activeUploadPreviewRatio < 0.9;
            return (
            <div className="rounded-xl studio-panel overflow-hidden">
              <div className="px-4 py-2.5 bg-[#09140E] border-b border-[#D4AF37]/20 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#F5C451]" />
                  Original Source View ({natW}×{natH})
                </span>
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[11px] text-zinc-400 mr-1">Review Frame:</span>
                  {(
                    [
                      { id: 'original', label: `Original (${natW}×${natH})` },
                      { id: '9:16', label: '9:16 Vertical' },
                      { id: '16:9', label: '16:9 Horizontal' },
                      { id: '1:1', label: '1:1 Square' },
                      { id: '4:5', label: '4:5 Portrait' },
                    ] as Array<{ id: AspectRatio; label: string }>
                  ).map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, aspectRatio: opt.id }))}
                      className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold transition-colors ${
                        config.aspectRatio === opt.id
                          ? 'bg-[#059669] text-white border border-[#F5C451]/60'
                          : 'bg-[#0E1913] text-zinc-300 hover:bg-[#15261D] border border-[#D4AF37]/15'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bg-[#050A07] p-3 flex justify-center">
                <div
                  style={{ aspectRatio: String(activeUploadPreviewRatio) }}
                  className={`relative w-full ${
                    isVerticalView ? 'max-w-[330px] max-h-[520px]' : 'max-w-full max-h-[480px]'
                  } bg-black rounded-lg overflow-hidden border border-white/[0.12] shadow-xl`}
                >
                  {(localPreviewUrl || uploadedProject.sourceUrl) && !previewError ? (
                    <video
                      src={localPreviewUrl || uploadedProject.sourceUrl}
                      poster={uploadedProject.thumbnailUrl}
                      controls
                      playsInline
                      preload="metadata"
                      onError={() => {
                        setPreviewError(true);
                        void handleEnsureUploadH264Preview(true);
                      }}
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center relative text-center p-4">
                      {uploadedProject.thumbnailUrl && (
                        <img
                          src={uploadedProject.thumbnailUrl}
                          alt={uploadedProject.originalFilename}
                          className="absolute inset-0 w-full h-full object-contain opacity-45"
                        />
                      )}
                      <div className="relative z-10 px-4 py-3 rounded-lg bg-black/80 border border-[#D4AF37]/30 text-xs text-zinc-200 max-w-md space-y-2">
                        <div className="flex items-center justify-center gap-1.5 font-semibold text-emerald-300">
                          {uploadedProject.browserProxyStatus === 'transcoding' || repairingPreview ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#F5C451]" />
                              <span>Rendering Universal H.264 MP4 Preview...</span>
                            </>
                          ) : (
                            <>
                              <Film className="w-3.5 h-3.5 text-[#F5C451]" />
                              <span>
                                {uploadedProject.originalContainer || 'Source'} ({uploadedProject.metadata?.codec?.toUpperCase() || 'Video'}) Format
                              </span>
                            </>
                          )}
                        </div>
                        <p className="text-[11px] text-zinc-300">
                          {uploadedProject.browserProxyStatus === 'transcoding' || repairingPreview
                            ? 'Converting this video format into a universal browser-playable H.264/AAC MP4 preview — you can start AI analysis immediately.'
                            : 'Click below to render a universal H.264 MP4 browser preview for this format.'}
                        </p>
                        {!repairingPreview && uploadedProject.browserProxyStatus !== 'transcoding' && (
                          <button
                            type="button"
                            onClick={() => void handleEnsureUploadH264Preview(true)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#10B981] text-white font-semibold text-[11px]"
                          >
                            <Film className="w-3 h-3" />
                            Render Universal H.264 Preview Now
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
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
            );
          })()}
        </div>

        {/* Right: Workflow Mode & AI Configuration */}
        <div className="xl:col-span-5 p-6 rounded-xl studio-panel space-y-5">
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              Workflow Mode &amp; Configuration
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Choose whether to auto-generate viral short clips or keep your entire original video unchanged with high-end captions.
            </p>
          </div>

          {/* 2-Card Mode Selector */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() =>
                setConfig((c) => ({
                  ...c,
                  mode: 'auto_clips',
                  aspectRatio: c.aspectRatio === 'original' ? settings.defaultAspectRatio : c.aspectRatio,
                }))
              }
              className={`p-3.5 rounded-xl border text-left transition-colors ${
                processingMode === 'auto_clips'
                  ? 'bg-[#059669]/20 border-[#D4AF37]/70'
                  : 'bg-[#0C1510] border-[#D4AF37]/15 hover:border-[#D4AF37]/35'
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <Scissors className="w-4 h-4 text-[#F5C451] shrink-0" />
                AI Auto-Clipping
              </div>
              <p className="mt-1 text-[11px] text-zinc-400 leading-relaxed">
                Detect top hooks, reframe, color grade &amp; cut viral clips.
              </p>
            </button>

            <button
              type="button"
              onClick={() =>
                setConfig((c) => ({
                  ...c,
                  mode: 'captions_only',
                  aspectRatio: 'original',
                  captionPresetId:
                    c.captionPresetId === settings.defaultCaptionPresetId
                      ? 'loki-emerald-gold'
                      : c.captionPresetId,
                }))
              }
              className={`p-3.5 rounded-xl border text-left transition-colors ${
                processingMode === 'captions_only'
                  ? 'bg-[#059669]/20 border-[#D4AF37]/70'
                  : 'bg-[#0C1510] border-[#D4AF37]/15 hover:border-[#D4AF37]/35'
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-white">
                <Captions className="w-4 h-4 text-[#10B981] shrink-0" />
                Captions Only (Full Video)
              </div>
              <p className="mt-1 text-[11px] text-zinc-400 leading-relaxed">
                Zero video changes · Same original quality · High-end captions.
              </p>
            </button>
          </div>

          {processingMode === 'captions_only' ? (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-[#071811] border border-[#10B981]/30 space-y-1.5">
                <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
                  <ShieldCheck className="w-4 h-4 text-[#F5C451] shrink-0" />
                  100% Original Video Preserved — Zero Alterations
                </div>
                <p className="text-[11px] text-zinc-300 leading-relaxed">
                  No cutting, no cropping, no zoom/pan, and no color grading. Exports in your video&apos;s exact original resolution, FPS &amp; audio quality — plus instant 0%-re-encode soft-sub MP4, SRT, VTT &amp; ASS files.
                </p>
              </div>

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
                <label className="block text-xs font-medium text-zinc-300 mb-2">
                  High-End Caption Style ({CAPTION_PRESETS.length} Studio Presets)
                </label>
                <div className="grid grid-cols-2 gap-2 max-h-[260px] overflow-y-auto pr-1">
                  {CAPTION_PRESETS.map((preset) => {
                    const active = config.captionPresetId === preset.id;
                    const c = preset.config;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => setConfig((cfg) => ({ ...cfg, captionPresetId: preset.id }))}
                        className={`p-2.5 rounded-lg border text-left transition-colors ${
                          active
                            ? 'bg-[#059669]/20 border-[#D4AF37]/70'
                            : 'bg-[#0C1510] border-[#D4AF37]/12 hover:border-[#D4AF37]/35'
                        }`}
                      >
                        <div
                          style={{
                            backgroundColor: c.backgroundOpacity > 0.2 ? c.backgroundColor : '#09090D',
                          }}
                          className="h-8 rounded flex items-center justify-center px-1.5 mb-1.5 overflow-hidden"
                        >
                          <span
                            style={{
                              fontFamily: c.fontFamily,
                              fontWeight: c.fontWeight,
                              color: c.textColor,
                              textShadow: c.shadow ? '0 1px 4px rgba(0,0,0,0.9)' : 'none',
                            }}
                            className="text-[11px] tracking-tight truncate"
                          >
                            {c.uppercase ? 'HIGH END ' : 'High end '}
                            <span style={{ color: c.highlightColor }}>
                              {c.uppercase ? 'STYLE' : 'style'}
                            </span>
                          </span>
                        </div>
                        <div className="text-[11px] font-semibold text-white truncate">{preset.name}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <>
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
                    <option value="original" className="bg-[#0C1510]">Original Source Aspect Ratio</option>
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
            </>
          )}

          <div className="pt-2 space-y-3">
            <label className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/15 cursor-pointer">
              <span className="text-xs text-zinc-300">
                {processingMode === 'captions_only'
                  ? 'Auto-start high-end caption generation when upload finishes'
                  : 'Auto-start AI analysis & clip generation when upload finishes'}
              </span>
              <input
                type="checkbox"
                checked={uploadState.autoAnalyze}
                onChange={(e) => uploadManager.setAutoAnalyze(e.target.checked)}
                className="w-4 h-4 accent-[#10B981] rounded cursor-pointer shrink-0"
              />
            </label>

            <button
              onClick={() => void handleAnalyze()}
              disabled={!uploadedProject || startingAnalysis}
              className="w-full studio-btn-primary h-11 px-5 rounded-xl disabled:opacity-40 disabled:cursor-not-allowed text-sm font-semibold text-white inline-flex items-center justify-center gap-2"
            >
              {startingAnalysis ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : processingMode === 'captions_only' ? (
                <Captions className="w-4 h-4 text-[#FEF3C7]" />
              ) : (
                <Cpu className="w-4 h-4 text-[#FEF3C7]" />
              )}
              {startingAnalysis
                ? processingMode === 'captions_only'
                  ? 'Starting Caption Engine...'
                  : 'Starting AI Pipeline...'
                : uploadedProject?.status === 'analyzing'
                  ? 'View Live Processing'
                  : processingMode === 'captions_only'
                    ? 'Generate High-End Captions (Original Quality)'
                    : 'Analyze Video & Generate Clips'}
            </button>
          </div>
        </div>
      </div>

      {/* Direct Transcript File (.SRT / .VTT / .TXT) -> Animated Chroma Green Screen Captions Generator */}
      <div className="p-6 rounded-2xl studio-panel border border-[#22C55E]/35 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-md bg-[#22C55E]/15 border border-[#22C55E]/40 text-[11px] font-semibold text-[#4ADE80]">
              <Waves className="w-3.5 h-3.5 text-[#F5C451]" />
              NO VIDEO UPLOAD REQUIRED · TRANSCRIPT TO ANIMATED CAPTIONS MP4
            </div>
            <h2 className="font-display text-lg font-bold text-white">
              Transcript File to Animated Captions Generator (.SRT / .VTT / .TXT → Chroma Green Screen MP4)
            </h2>
            <p className="text-xs text-zinc-400">
              Upload any transcript file (<span className="text-zinc-200 font-mono">.srt, .vtt, .txt, .ass, .json</span>) or paste your script in{' '}
              <span className="text-[#F5C451] font-medium">Hinglish, Roman Urdu, Urdu (اردو), or English</span> to generate animated captions (Waving Flow, Bounce, Karaoke, Pop) and download as a Chroma Green Screen MP4.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <input
              ref={transcriptFileInputRef}
              type="file"
              accept=".srt,.vtt,.txt,.ass,.ssa,.json,text/plain,text/vtt,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleLoadTranscriptFile(file);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              onClick={() => transcriptFileInputRef.current?.click()}
              className="inline-flex items-center gap-2 h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/30 text-xs font-semibold text-white"
            >
              <FileText className="w-3.5 h-3.5 text-[#F5C451]" />
              {transcriptFilename ? `Loaded: ${transcriptFilename}` : 'Upload Transcript File (.SRT / .VTT / .TXT)'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-7 space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-300">
              <span className="font-medium">
                Transcript Text (Supports SRT timestamps, <code className="text-[#F5C451]">[00:01 - 00:04]</code>, or plain lines in Hinglish / Roman Urdu / اردو)
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setTranscriptLanguage('hinglish');
                    setTranscriptTitle('Hinglish Creator Captions');
                    setTranscriptContent(
                      [
                        '[0.0 - 2.6] Aaj hum baat karenge kaise aap apne videos ke liye',
                        '[2.6 - 5.4] high-end animated captions generate kar sakte hain!',
                        '[5.4 - 8.2] Sirf transcript file upload karo aur green screen MP4 download karo.',
                      ].join('\n')
                    );
                  }}
                  className="px-2 py-0.5 rounded bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/20 text-[10px] text-emerald-300"
                >
                  Sample Hinglish
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTranscriptLanguage('roman_ur');
                    setTranscriptTitle('Roman Urdu Studio Captions');
                    setTranscriptContent(
                      [
                        '[0.0 - 2.8] Agar aap ne sirf transcript se animated captions banani hain,',
                        '[2.8 - 5.6] toh SkaDoosh mein apni file upload karein ya text paste karein',
                        '[5.6 - 8.5] aur chroma green screen MP4 kisi bhi editor mein use karein!',
                      ].join('\n')
                    );
                  }}
                  className="px-2 py-0.5 rounded bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/20 text-[10px] text-[#F5C451]"
                >
                  Sample Roman Urdu
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTranscriptLanguage('ur');
                    setTranscriptTitle('Urdu Nastaliq Captions');
                    setTranscriptContent(
                      [
                        '[0.0 - 3.0] اب آپ صرف ٹرانسکرپٹ فائل دے کر شاندار اینیمیٹڈ کیپشنز بنا سکتے ہیں',
                        '[3.0 - 6.2] اور کروما گرین اسکرین ایم پی فور ڈاؤن لوڈ کر کے کسی بھی سافٹ ویئر میں استعمال کریں۔',
                      ].join('\n')
                    );
                  }}
                  className="px-2 py-0.5 rounded bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/20 text-[10px] text-zinc-200"
                >
                  Sample اردو
                </button>
              </div>
            </div>
            <textarea
              rows={5}
              value={transcriptContent}
              onChange={(e) => setTranscriptContent(e.target.value)}
              placeholder={`Paste your .SRT, .VTT, timestamped lines, or plain script here...\nExample (Roman Urdu / Hinglish):\n[0.0 - 2.8] Aaj ki video mein hum dekhenge high-end waving captions\n[2.8 - 5.6] jo aap ke voiceover ke saath bilkul sync kaam karti hain!`}
              className="w-full p-3 rounded-xl bg-[#08100C] border border-[#D4AF37]/20 text-xs text-white font-mono leading-relaxed focus:outline-none focus:border-[#10B981]"
            />
          </div>

          <div className="lg:col-span-5 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-300 mb-1">Language / Script</label>
                <select
                  value={transcriptLanguage}
                  onChange={(e) => setTranscriptLanguage(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 text-xs text-white"
                >
                  {SUPPORTED_LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code} className="bg-[#0C1510]">
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-300 mb-1">Caption Animation</label>
                <select
                  value={transcriptAnimation}
                  onChange={(e) => setTranscriptAnimation(e.target.value as CaptionAnimation)}
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 text-xs text-white"
                >
                  <option value="wave" className="bg-[#0C1510]">Waving Flow (Sinusoidal Wave)</option>
                  <option value="bounce" className="bg-[#0C1510]">Elastic Bounce</option>
                  <option value="pop" className="bg-[#0C1510]">Creator Pop Spring</option>
                  <option value="karaoke" className="bg-[#0C1510]">Karaoke Word Sweep</option>
                  <option value="typewriter" className="bg-[#0C1510]">Typewriter Reveal</option>
                  <option value="neon_pulse" className="bg-[#0C1510]">Neon Pulse Halo</option>
                  <option value="glow" className="bg-[#0C1510]">Radiant Glow</option>
                  <option value="shake" className="bg-[#0C1510]">Hype Shake</option>
                  <option value="flip" className="bg-[#0C1510]">3D Flip In</option>
                  <option value="slide" className="bg-[#0C1510]">Slide Up</option>
                  <option value="fade" className="bg-[#0C1510]">Smooth Fade</option>
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-300 mb-1">Studio Style Preset</label>
                <select
                  value={transcriptPresetId}
                  onChange={(e) => setTranscriptPresetId(e.target.value)}
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 text-xs text-white"
                >
                  {CAPTION_PRESETS.map((p) => (
                    <option key={p.id} value={p.id} className="bg-[#0C1510]">
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs text-zinc-300 mb-1">Canvas Aspect Ratio</label>
                <select
                  value={transcriptAspectRatio}
                  onChange={(e) =>
                    setTranscriptAspectRatio(e.target.value as '9:16' | '16:9' | '1:1' | '4:5')
                  }
                  className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 text-xs text-white"
                >
                  <option value="9:16" className="bg-[#0C1510]">9:16 Vertical (1080×1920)</option>
                  <option value="16:9" className="bg-[#0C1510]">16:9 Landscape (1920×1080)</option>
                  <option value="1:1" className="bg-[#0C1510]">1:1 Square (1080×1080)</option>
                  <option value="4:5" className="bg-[#0C1510]">4:5 Portrait (1080×1350)</option>
                </select>
              </div>
            </div>

            <div className="pt-1 flex flex-col sm:flex-row gap-2.5">
              <button
                type="button"
                disabled={creatingTranscriptStudio || downloadingDirectChroma}
                onClick={() => void handleOpenTranscriptInCaptionStudio(false)}
                className="flex-1 studio-btn-primary h-10 px-4 rounded-xl text-xs font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {creatingTranscriptStudio ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4 text-[#FEF3C7]" />
                )}
                {creatingTranscriptStudio ? 'Building Animated Captions...' : 'Preview & Customize in Caption Studio'}
              </button>

              <button
                type="button"
                disabled={creatingTranscriptStudio || downloadingDirectChroma}
                onClick={() => void handleOpenTranscriptInCaptionStudio(true)}
                className="flex-1 h-10 px-4 rounded-xl bg-gradient-to-r from-[#15803D] via-[#16A34A] to-[#059669] hover:brightness-110 border border-[#4ADE80]/50 text-xs font-semibold text-white inline-flex items-center justify-center gap-2 shadow-md disabled:opacity-50"
              >
                {downloadingDirectChroma ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4 text-[#FEF3C7]" />
                )}
                {downloadingDirectChroma ? 'Rendering Chroma MP4...' : 'Generate & Download Chroma MP4'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
