import React, { useEffect, useMemo, useState } from 'react';
import {
  Save,
  Layers,
  CheckCircle2,
  Loader2,
  UploadCloud,
  Download,
  FileText,
  Sparkles,
  ShieldCheck,
  Film,
  AlertCircle,
  Edit3,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import type {
  CaptionAlignment,
  CaptionAnimation,
  CaptionPosition,
  CaptionStyleConfig,
  ClipRecord,
  ExportJob,
  ExportOptions,
  NavPage,
  ProjectRecord,
  TranscriptSegment,
} from '../../shared/types.ts';
import { CAPTION_FONTS, CAPTION_PRESETS, SUPPORTED_LANGUAGES } from '../../shared/presets.ts';
import { ClipPreviewPlayer } from '../components/ClipPreviewPlayer.tsx';
import { api } from '../lib/api.ts';
import { formatBytes, formatTimecode, isRtlText } from '../lib/format.ts';

interface CaptionStudioPageProps {
  project: ProjectRecord | null;
  clipId: string | null;
  exportJobs: ExportJob[];
  onSelectClip: (clipId: string) => void;
  onSaveClip: (projectId: string, clip: ClipRecord) => Promise<ClipRecord>;
  onApplyToAll: (
    projectId: string,
    clipId: string,
    style: CaptionStyleConfig
  ) => Promise<void>;
  onCreateFullVideoCaptions: (
    projectId: string,
    payload?: { captionPresetId?: string; autoRender?: boolean }
  ) => Promise<void>;
  onExportClip: (
    projectId: string,
    clipId: string,
    options?: Partial<ExportOptions>
  ) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

function rebuildWordTimings(seg: TranscriptSegment, nextText: string): TranscriptSegment {
  const cleaned = nextText.replace(/\s+/g, ' ').trim();
  const tokens = cleaned ? cleaned.split(' ') : [];
  const totalDur = Math.max(0.2, seg.end - seg.start);
  const perWord = tokens.length > 0 ? totalDur / tokens.length : totalDur;
  return {
    ...seg,
    text: cleaned,
    words: tokens.map((word, idx) => ({
      id: `${seg.id}_w${idx}`,
      word,
      start: Number((seg.start + idx * perWord).toFixed(3)),
      end: Number((seg.start + (idx + 1) * perWord).toFixed(3)),
    })),
  };
}

export function CaptionStudioPage({
  project,
  clipId,
  exportJobs,
  onSelectClip,
  onSaveClip,
  onApplyToAll,
  onCreateFullVideoCaptions,
  onExportClip,
  onNavigate,
}: CaptionStudioPageProps) {
  const sourceClip = useMemo(() => {
    if (!project || project.clips.length === 0) return null;
    return (
      project.clips.find((c) => c.id === clipId) ??
      project.clips.find((c) => c.isFullVideoCaption) ??
      project.clips[0]
    );
  }, [project, clipId]);

  const hasFullVideoTrack = useMemo(
    () => Boolean(project?.clips.some((c) => c.isFullVideoCaption)),
    [project?.clips]
  );

  const [style, setStyle] = useState<CaptionStyleConfig>(
    sourceClip ? { ...sourceClip.captionStyle } : { ...CAPTION_PRESETS[0].config }
  );
  const [editedSegments, setEditedSegments] = useState<TranscriptSegment[] | null>(null);
  const [showTextEditor, setShowTextEditor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applyingAll, setApplyingAll] = useState(false);
  const [creatingFull, setCreatingFull] = useState(false);
  const [renderingMp4, setRenderingMp4] = useState(false);
  const [downloadingMp4, setDownloadingMp4] = useState(false);
  const [downloadingSoftSub, setDownloadingSoftSub] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (sourceClip) {
      setStyle({ ...sourceClip.captionStyle });
      setEditedSegments(sourceClip.customSegments ?? null);
    }
  }, [sourceClip?.id]);

  if (!project) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">Caption Studio</h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Upload a video to generate high-end synchronized captions on your full original video (zero video changes) or on individual clips.
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

  // Uploaded project with no clips yet -> allow 1-click Full Original Video Captioning directly here!
  if (!sourceClip) {
    return (
      <div className="p-10 rounded-2xl studio-panel max-w-2xl mx-auto text-center space-y-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-md bg-[#059669]/18 border border-[#10B981]/35 text-xs font-medium text-emerald-300">
          <ShieldCheck className="w-4 h-4 text-[#F5C451]" />
          Original Video Preserved · Zero Video Changes
        </div>
        <h2 className="font-display text-xl font-bold text-white">
          Generate High-End Captions for &ldquo;{project.name}&rdquo;
        </h2>
        <p className="text-sm text-zinc-400 leading-relaxed">
          Create studio-grade synchronized captions across your entire original video without cutting, cropping, or altering colors, and download in the exact same original quality.
        </p>
        {errorMsg && (
          <div className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/12 border border-red-500/30 text-xs text-red-200">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {errorMsg}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <button
            disabled={creatingFull}
            onClick={async () => {
              setErrorMsg(null);
              setCreatingFull(true);
              try {
                await onCreateFullVideoCaptions(project.id, {
                  captionPresetId: style.presetId || 'loki-emerald-gold',
                  autoRender: true,
                });
              } catch (err) {
                setErrorMsg(err instanceof Error ? err.message : 'Failed to start full-video captioning.');
              } finally {
                setCreatingFull(false);
              }
            }}
            className="studio-btn-primary inline-flex items-center gap-2 h-11 px-6 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
          >
            {creatingFull ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 text-[#FEF3C7]" />
            )}
            {creatingFull ? 'Generating High-End Captions...' : 'Caption Full Original Video (Same Quality)'}
          </button>
          <button
            onClick={() => onNavigate('upload')}
            className="inline-flex items-center gap-2 h-11 px-4 rounded-xl bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-zinc-200"
          >
            <UploadCloud className="w-4 h-4 text-[#F5C451]" /> Upload Different Video
          </button>
        </div>
      </div>
    );
  }

  const baseSegments = useMemo(() => {
    if (editedSegments && editedSegments.length > 0) return editedSegments;
    if (sourceClip.customSegments && sourceClip.customSegments.length > 0) {
      return sourceClip.customSegments;
    }
    return project.transcript.filter(
      (s) => s.end > sourceClip.startTime && s.start < sourceClip.endTime
    );
  }, [editedSegments, sourceClip.customSegments, sourceClip.startTime, sourceClip.endTime, project.transcript]);

  const previewClip: ClipRecord = {
    ...sourceClip,
    captionStyle: style,
    customSegments: editedSegments ?? sourceClip.customSegments,
  };

  const isFullOriginal = Boolean(sourceClip.isFullVideoCaption || sourceClip.preserveOriginalVideo);
  const isLandscapePreview =
    isFullOriginal &&
    Boolean(project.metadata && project.metadata.width >= project.metadata.height);

  const latestJob = useMemo(
    () => exportJobs.find((j) => j.projectId === project.id && j.clipId === sourceClip.id) ?? null,
    [exportJobs, project.id, sourceClip.id]
  );

  const isRenderingNow = Boolean(
    renderingMp4 ||
      (latestJob && (latestJob.status === 'queued' || latestJob.status === 'rendering')) ||
      sourceClip.renderStatus === 'queued' ||
      sourceClip.renderStatus === 'rendering' ||
      sourceClip.renderStatus === 'validating' ||
      sourceClip.renderStatus === 'saving'
  );

  const isMp4Ready = Boolean(
    !isRenderingNow && (sourceClip.renderStatus === 'export_ready' || sourceClip.renderedVideoUrl)
  );

  const handleSaveCurrent = async () => {
    setErrorMsg(null);
    setSaving(true);
    try {
      await onSaveClip(project.id, previewClip);
      setFeedback('High-end caption style & edits saved.');
      setTimeout(() => setFeedback(null), 2400);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save caption style.');
    } finally {
      setSaving(false);
    }
  };

  const handleApplyAll = async () => {
    setErrorMsg(null);
    setApplyingAll(true);
    try {
      await onApplyToAll(project.id, sourceClip.id, style);
      setFeedback(`Applied style to all ${project.clips.length} items in this project.`);
      setTimeout(() => setFeedback(null), 2600);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to apply style.');
    } finally {
      setApplyingAll(false);
    }
  };

  const handleSaveAndRenderSameQuality = async () => {
    setErrorMsg(null);
    setRenderingMp4(true);
    try {
      await onSaveClip(project.id, previewClip);
      await onExportClip(project.id, sourceClip.id, {
        resolution: isFullOriginal ? 'original' : '1080p',
        codec: 'h264',
        fps: isFullOriginal ? 'original' : 30,
        quality: isFullOriginal ? 'master' : 'excellent',
        embedCaptions: true,
        includeMusic: !isFullOriginal,
      });
      setFeedback(
        isFullOriginal
          ? 'Rendering full original video with high-end burned-in captions at original quality...'
          : 'Rendering clip with updated high-end captions...'
      );
      setTimeout(() => setFeedback(null), 3500);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not start captioned MP4 render.');
    } finally {
      setRenderingMp4(false);
    }
  };

  const handleDownloadBurnedMp4 = async () => {
    setErrorMsg(null);
    setDownloadingMp4(true);
    try {
      await api.downloadClipMp4(project.id, sourceClip.id);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'MP4 download failed.');
    } finally {
      setDownloadingMp4(false);
    }
  };

  const handleDownloadSoftSubMp4 = async () => {
    setErrorMsg(null);
    setDownloadingSoftSub(true);
    try {
      await onSaveClip(project.id, previewClip);
      await api.downloadClipSoftSubMp4(project.id, sourceClip.id, sourceClip.title);
      setFeedback('Downloaded lossless bit-exact MP4 with embedded selectable captions (0% video re-encode).');
      setTimeout(() => setFeedback(null), 3200);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Lossless soft-sub MP4 download failed.');
    } finally {
      setDownloadingSoftSub(false);
    }
  };

  const handleCreateFullVideoTrack = async () => {
    setErrorMsg(null);
    setCreatingFull(true);
    try {
      await onCreateFullVideoCaptions(project.id, {
        captionPresetId: style.presetId || 'loki-emerald-gold',
        autoRender: false,
      });
      setFeedback('Full original video caption track created — zero video changes applied.');
      setTimeout(() => setFeedback(null), 2800);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Could not create full-video caption track.');
    } finally {
      setCreatingFull(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Caption Studio</h1>
          <p className="mt-1 text-xs text-zinc-400">
            {CAPTION_PRESETS.length} high-end studio presets · Full original video captioning with zero video alterations · Same-quality MP4, lossless soft-sub MP4, SRT, VTT &amp; ASS.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!hasFullVideoTrack && (
            <button
              onClick={() => void handleCreateFullVideoTrack()}
              disabled={creatingFull}
              className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#059669]/20 hover:bg-[#059669]/30 border border-[#10B981]/45 text-xs font-semibold text-emerald-200 whitespace-nowrap"
            >
              {creatingFull ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Film className="w-3.5 h-3.5 text-[#F5C451]" />
              )}
              Caption Full Original Video
            </button>
          )}

          <select
            value={sourceClip.id}
            onChange={(e) => onSelectClip(e.target.value)}
            className="h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/20 text-xs text-white max-w-[240px] truncate"
          >
            {project.clips.map((c, idx) => (
              <option key={c.id} value={c.id} className="bg-[#0C1510]">
                {c.isFullVideoCaption ? `★ Full Original: ${project.name}` : `Clip ${idx + 1}: ${c.title}`}
              </option>
            ))}
          </select>

          <button
            onClick={() => void handleSaveCurrent()}
            disabled={saving}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/25 text-xs font-semibold text-white whitespace-nowrap"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5 text-[#F5C451]" />}
            Save
          </button>

          {project.clips.length > 1 && (
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
              Apply to All
            </button>
          )}
        </div>
      </div>

      {feedback && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-xs text-emerald-300">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {feedback}
        </div>
      )}

      {errorMsg && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/12 border border-red-500/30 text-xs text-red-200">
          <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
          {errorMsg}
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Left: Live Video Caption Preview + Direct Same-Quality Export & Download Panel */}
        <div className="xl:col-span-5 space-y-4">
          <div className="p-5 rounded-xl studio-panel flex flex-col items-center">
            {isFullOriginal && (
              <div className="w-full mb-3 flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#071811] border border-[#10B981]/30 text-[11px]">
                <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-300">
                  <ShieldCheck className="w-3.5 h-3.5 text-[#F5C451]" />
                  Original Video Unchanged
                </span>
                <span className="font-mono text-zinc-300 tabular-nums">
                  {project.metadata
                    ? `${project.metadata.width}×${project.metadata.height} · ${project.metadata.fps} FPS`
                    : 'Original Resolution'}
                </span>
              </div>
            )}

            <div className={isLandscapePreview ? 'w-full' : 'w-full max-w-[320px]'}>
              <ClipPreviewPlayer project={project} clip={previewClip} />
            </div>

            <div className="mt-4 w-full pt-3 border-t border-[#D4AF37]/12 flex items-center justify-between text-xs text-zinc-400">
              <span>Language: {project.detectedLanguage || 'Auto'}</span>
              <span>
                {SUPPORTED_LANGUAGES.slice(1, 5)
                  .map((l) => l.label.split(' ')[0])
                  .join(', ')}{' '}
                +
              </span>
            </div>
          </div>

          {/* Direct Same-Quality Download & Export Panel */}
          <div className="p-5 rounded-xl studio-panel space-y-3.5">
            <div>
              <h2 className="font-display text-sm font-semibold text-white">
                Export &amp; Download Captioned Video
              </h2>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                {isFullOriginal
                  ? 'Preserves exact original resolution, frame rate, framing & audio — zero video edits.'
                  : 'Burns your selected high-end caption preset directly into a playable MP4.'}
              </p>
            </div>

            {isRenderingNow && (
              <div className="p-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/25 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="inline-flex items-center gap-1.5 text-[#F5C451] font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {latestJob?.stageDetail || sourceClip.renderStageDetail || 'Rendering same-quality MP4...'}
                  </span>
                  <span className="font-mono text-white tabular-nums">{latestJob?.progress ?? 12}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-[#132219] overflow-hidden">
                  <div
                    style={{ width: `${Math.max(6, latestJob?.progress ?? 12)}%` }}
                    className="h-full bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37] transition-[width] duration-200"
                  />
                </div>
              </div>
            )}

            <div className="space-y-2">
              {isMp4Ready && (
                <button
                  onClick={() => void handleDownloadBurnedMp4()}
                  disabled={downloadingMp4}
                  className="w-full studio-btn-gold h-10 px-4 rounded-lg text-xs font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {downloadingMp4 ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Download className="w-4 h-4" />
                  )}
                  {downloadingMp4
                    ? 'Downloading Captioned MP4...'
                    : `Download High-End Captioned MP4 (${sourceClip.renderedResolution || 'Original'}${sourceClip.renderedFileSize ? ` · ${formatBytes(sourceClip.renderedFileSize)}` : ''})`}
                </button>
              )}

              <button
                onClick={() => void handleSaveAndRenderSameQuality()}
                disabled={isRenderingNow}
                className="w-full studio-btn-primary h-10 px-4 rounded-lg text-xs font-semibold text-white inline-flex items-center justify-center gap-2 disabled:opacity-45"
              >
                {isRenderingNow ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4 text-[#FEF3C7]" />
                )}
                {isRenderingNow
                  ? 'Rendering Same-Quality MP4...'
                  : isMp4Ready
                    ? 'Save Style & Re-Render Same-Quality MP4'
                    : 'Render Burned-In Captioned MP4 (Same Quality)'}
              </button>

              <button
                onClick={() => void handleDownloadSoftSubMp4()}
                disabled={downloadingSoftSub}
                className="w-full h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#10B981]/30 text-xs font-medium text-emerald-200 inline-flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {downloadingSoftSub ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ShieldCheck className="w-3.5 h-3.5 text-[#10B981]" />
                )}
                {downloadingSoftSub
                  ? 'Packaging Bit-Exact MP4...'
                  : 'Instant Lossless Soft-Sub MP4 (0% Re-Encode)'}
              </button>
            </div>

            <div className="pt-2 border-t border-[#D4AF37]/12 flex items-center justify-between gap-2">
              <span className="text-[11px] text-zinc-400">Subtitle Tracks:</span>
              <div className="flex items-center gap-1.5">
                <a
                  href={`/api/projects/${project.id}/clips/${sourceClip.id}/subtitles.srt`}
                  download
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/18 text-[11px] text-zinc-200"
                >
                  <FileText className="w-3 h-3 text-[#F5C451]" />
                  SRT
                </a>
                <a
                  href={`/api/projects/${project.id}/clips/${sourceClip.id}/subtitles.vtt`}
                  download
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/18 text-[11px] text-zinc-200"
                >
                  VTT
                </a>
                <a
                  href={`/api/projects/${project.id}/clips/${sourceClip.id}/subtitles.ass`}
                  download
                  className="inline-flex items-center gap-1 h-7 px-2.5 rounded-md bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/18 text-[11px] text-zinc-200"
                >
                  Styled ASS
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Right: 16 High-End Presets + Granular Typography Controls + Inline Transcript Editor */}
        <div className="xl:col-span-7 space-y-5">
          {/* 16 High-End Presets Grid */}
          <div className="p-5 rounded-xl studio-panel">
            <h2 className="font-display text-sm font-semibold text-white mb-3">
              {CAPTION_PRESETS.length} High-End Studio Caption Presets
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
                        <span
                          style={{
                            color: c.highlightColor,
                            textShadow:
                              c.animation === 'glow' ? `0 0 10px ${c.highlightColor}` : undefined,
                          }}
                        >
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
              Typography, Colors, Layout &amp; Timing
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
                  <option value="pop" className="bg-[#0C1510]">Pop Spring Scale</option>
                  <option value="karaoke" className="bg-[#0C1510]">Karaoke Sweep</option>
                  <option value="fade" className="bg-[#0C1510]">Smooth Fade</option>
                  <option value="slide" className="bg-[#0C1510]">Slide Up</option>
                  <option value="glow" className="bg-[#0C1510]">Radiant Glow</option>
                  <option value="none" className="bg-[#0C1510]">Static Clean</option>
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
                      verticalOffset: pos === 'top' ? 18 : pos === 'middle' ? 50 : 82,
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

          {/* Collapsible Inline Caption Text Editor */}
          <div className="rounded-xl studio-panel overflow-hidden">
            <button
              type="button"
              onClick={() => setShowTextEditor((v) => !v)}
              className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-[#059669]/8 transition-colors"
            >
              <div className="flex items-center gap-2">
                <Edit3 className="w-4 h-4 text-[#F5C451]" />
                <span className="font-display text-sm font-semibold text-white">
                  Edit Caption Words &amp; Lines ({baseSegments.length} segments)
                </span>
              </div>
              {showTextEditor ? (
                <ChevronUp className="w-4 h-4 text-zinc-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-zinc-400" />
              )}
            </button>

            {showTextEditor && (
              <div className="px-5 pb-4 pt-2 border-t border-[#D4AF37]/12 space-y-2.5 max-h-[340px] overflow-y-auto">
                {baseSegments.length === 0 ? (
                  <p className="text-xs text-zinc-500 py-4 text-center">
                    No transcript segments found for this video yet.
                  </p>
                ) : (
                  baseSegments.map((seg, idx) => (
                    <div key={seg.id} className="flex items-start gap-3">
                      <span className="font-mono text-[11px] text-[#F5C451] tabular-nums pt-2 shrink-0 w-16">
                        {formatTimecode(Math.max(0, seg.start - sourceClip.startTime))}
                      </span>
                      <input
                        type="text"
                        dir={isRtlText(seg.text) ? 'rtl' : 'ltr'}
                        value={seg.text}
                        onChange={(e) => {
                          const nextVal = e.target.value;
                          setEditedSegments((prev) => {
                            const list = prev ? [...prev] : baseSegments.map((s) => ({ ...s }));
                            list[idx] = rebuildWordTimings(list[idx], nextVal);
                            return list;
                          });
                        }}
                        className="flex-1 h-9 px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white focus:outline-none focus:border-[#D4AF37]"
                      />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
