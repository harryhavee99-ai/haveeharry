import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  SlidersHorizontal,
  RefreshCw,
  Download,
  Trash2,
  Check,
  Loader2,
  Film,
  Edit3,
  UploadCloud,
  Archive,
  Play,
  Sparkles,
  AlertCircle,
  Eye,
  X,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Clock,
  Quote,
  Brain,
} from 'lucide-react';
import type {
  ClipRecord,
  ExportJob,
  ExportOptions,
  HookCandidate,
  NavPage,
  ProjectRecord,
} from '../../shared/types.ts';
import { api } from '../lib/api.ts';
import { formatBytes, formatDurationHuman, formatTimecode, isRtlText } from '../lib/format.ts';

interface ClipsPageProps {
  project: ProjectRecord | null;
  exportJobs: ExportJob[];
  onEditClip: (clipId: string) => void;
  onUpdateClipTitle: (projectId: string, clipId: string, title: string) => Promise<void>;
  onRegenerateClip: (projectId: string, clipId: string) => Promise<void>;
  onDeleteClip: (projectId: string, clipId: string) => Promise<void>;
  onRenderClipDirect: (
    projectId: string,
    clipId: string,
    options?: Partial<ExportOptions>
  ) => Promise<void>;
  onRenderAllClips: (
    projectId: string,
    clipIds: string[],
    options: ExportOptions
  ) => Promise<void>;
  onUpdateHookCandidate: (
    projectId: string,
    candidateId: string,
    patch: Partial<HookCandidate>
  ) => Promise<void>;
  onGenerateClipFromHook: (projectId: string, candidateId: string) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

type ViewTab = 'clips' | 'hooks';

type ClipSortKey =
  | 'overall'
  | 'emotional'
  | 'informative'
  | 'entertaining'
  | 'surprising'
  | 'storytelling'
  | 'chronological';

interface PreviewTarget {
  title: string;
  subtitle: string;
  src: string;
  startTime?: number;
  endTime?: number;
  isRenderedMp4: boolean;
}

function getStageLabel(clip: ClipRecord, latestJob?: ExportJob): { text: string; tone: 'ready' | 'busy' | 'error' | 'idle' } {
  if (latestJob && (latestJob.status === 'queued' || latestJob.status === 'rendering')) {
    if (latestJob.stage === 'validating_mp4') return { text: 'Validating MP4...', tone: 'busy' };
    if (latestJob.stage === 'saving_storage') return { text: 'Saving to storage...', tone: 'busy' };
    if (latestJob.stage === 'queued' || latestJob.status === 'queued') return { text: 'Queued for MP4...', tone: 'busy' };
    return { text: `Rendering MP4 ${latestJob.progress}%`, tone: 'busy' };
  }
  if (clip.renderStatus === 'rendering') return { text: 'Rendering MP4...', tone: 'busy' };
  if (clip.renderStatus === 'validating') return { text: 'Validating MP4...', tone: 'busy' };
  if (clip.renderStatus === 'saving') return { text: 'Saving to storage...', tone: 'busy' };
  if (clip.renderStatus === 'queued') return { text: 'Queued for MP4...', tone: 'busy' };
  if (clip.renderStatus === 'failed' || latestJob?.status === 'failed') {
    return { text: 'MP4 Render Failed', tone: 'error' };
  }
  if (clip.renderStatus === 'export_ready' || clip.renderedVideoUrl) {
    return { text: 'Export Ready (Verified MP4)', tone: 'ready' };
  }
  return { text: 'Not Rendered Yet', tone: 'idle' };
}

export function ClipsPage({
  project,
  exportJobs,
  onEditClip,
  onUpdateClipTitle,
  onRegenerateClip,
  onDeleteClip,
  onRenderClipDirect,
  onRenderAllClips,
  onUpdateHookCandidate,
  onGenerateClipFromHook,
  onNavigate,
}: ClipsPageProps) {
  const [activeTab, setActiveTab] = useState<ViewTab>('clips');
  const [sortBy, setSortBy] = useState<ClipSortKey>('overall');
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [busyClipId, setBusyClipId] = useState<string | null>(null);
  const [downloadingClipId, setDownloadingClipId] = useState<string | null>(null);
  const [pendingAutoDownloadIds, setPendingAutoDownloadIds] = useState<string[]>([]);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [renderingAll, setRenderingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  // Hook Intelligence local state
  const [expandedTranscriptIds, setExpandedTranscriptIds] = useState<Record<string, boolean>>({});
  const [timestampDrafts, setTimestampDrafts] = useState<Record<string, { start: string; end: string }>>({});
  const [busyCandidateId, setBusyCandidateId] = useState<string | null>(null);
  const [showRejectedHooks, setShowRejectedHooks] = useState(true);

  // Inline Preview Modal state
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);

  // Auto-download clip as soon as its queued render reaches export_ready
  useEffect(() => {
    if (!project || pendingAutoDownloadIds.length === 0) return;
    for (const clipId of pendingAutoDownloadIds) {
      const clip = project.clips.find((c) => c.id === clipId);
      if (!clip) continue;
      if (clip.renderStatus === 'export_ready' && clip.renderedVideoUrl) {
        setPendingAutoDownloadIds((prev) => prev.filter((id) => id !== clipId));
        void triggerVerifiedMp4Download(project.id, clip.id);
      } else if (clip.renderStatus === 'failed') {
        setPendingAutoDownloadIds((prev) => prev.filter((id) => id !== clipId));
        setActionError(clip.renderError || `MP4 export failed for "${clip.title}".`);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, pendingAutoDownloadIds]);

  const sortedClips = useMemo(() => {
    if (!project) return [];
    const list = [...project.clips];
    switch (sortBy) {
      case 'overall':
        return list.sort((a, b) => (b.hookBreakdown?.total ?? b.scores.overall) - (a.hookBreakdown?.total ?? a.scores.overall));
      case 'emotional':
        return list.sort((a, b) => (b.hookBreakdown?.emotionalScore ?? b.scores.emotionalImpact) - (a.hookBreakdown?.emotionalScore ?? a.scores.emotionalImpact));
      case 'informative':
        return list.sort((a, b) => (b.hookBreakdown?.informativeScore ?? b.scores.informationValue) - (a.hookBreakdown?.informativeScore ?? a.scores.informationValue));
      case 'entertaining':
        return list.sort((a, b) => (b.hookBreakdown?.entertainingScore ?? b.scores.humor) - (a.hookBreakdown?.entertainingScore ?? a.scores.humor));
      case 'surprising':
        return list.sort((a, b) => (b.hookBreakdown?.surprisingScore ?? b.scores.hookStrength) - (a.hookBreakdown?.surprisingScore ?? a.scores.hookStrength));
      case 'storytelling':
        return list.sort((a, b) => (b.hookBreakdown?.storytellingScore ?? b.scores.storyCompleteness) - (a.hookBreakdown?.storytellingScore ?? a.scores.storyCompleteness));
      case 'chronological':
        return list.sort((a, b) => a.startTime - b.startTime);
      default:
        return list;
    }
  }, [project, sortBy]);

  const sortedHookCandidates = useMemo(() => {
    if (!project?.hookCandidates) return [];
    const filtered = showRejectedHooks
      ? [...project.hookCandidates]
      : project.hookCandidates.filter((c) => c.status !== 'rejected');

    switch (sortBy) {
      case 'overall':
        return filtered.sort((a, b) => b.hookBreakdown.total - a.hookBreakdown.total);
      case 'emotional':
        return filtered.sort((a, b) => b.hookBreakdown.emotionalScore - a.hookBreakdown.emotionalScore);
      case 'informative':
        return filtered.sort((a, b) => b.hookBreakdown.informativeScore - a.hookBreakdown.informativeScore);
      case 'entertaining':
        return filtered.sort((a, b) => b.hookBreakdown.entertainingScore - a.hookBreakdown.entertainingScore);
      case 'surprising':
        return filtered.sort((a, b) => b.hookBreakdown.surprisingScore - a.hookBreakdown.surprisingScore);
      case 'storytelling':
        return filtered.sort((a, b) => b.hookBreakdown.storytellingScore - a.hookBreakdown.storytellingScore);
      case 'chronological':
        return filtered.sort((a, b) => a.startTime - b.startTime);
      default:
        return filtered;
    }
  }, [project?.hookCandidates, sortBy, showRejectedHooks]);

  const triggerVerifiedMp4Download = async (projectId: string, clipId: string) => {
    setActionError(null);
    setActionNotice(null);
    setDownloadingClipId(clipId);
    try {
      const result = await api.downloadClipMp4(projectId, clipId);
      setActionNotice(`Downloaded ${result.filename} (${formatBytes(result.fileSize)})`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to download MP4 file.');
    } finally {
      setDownloadingClipId(null);
    }
  };

  const handleDownloadZip = async () => {
    if (!project) return;
    setActionError(null);
    setActionNotice(null);
    setDownloadingZip(true);
    try {
      await api.downloadProjectZip(project.id, project.name);
      setActionNotice('Downloaded ZIP bundle containing verified MP4 clips and SRT subtitles.');
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'ZIP download failed.');
    } finally {
      setDownloadingZip(false);
    }
  };

  if (!project) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">No Project Selected</h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Upload and analyze a video to detect hooks and generate playable MP4 clips.
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

  const hookCandidates = project.hookCandidates ?? [];
  const verifiedHookCount = hookCandidates.filter((c) => c.status !== 'rejected').length;
  const renderedCount = project.clips.filter((c) => c.renderStatus === 'export_ready' || c.renderedVideoUrl).length;
  const unrenderedIds = project.clips
    .filter((c) => c.renderStatus !== 'export_ready' && !c.renderedVideoUrl)
    .map((c) => c.id);

  const saveTitle = async (clip: ClipRecord) => {
    const clean = titleDraft.trim();
    setEditingTitleId(null);
    if (!clean || clean === clip.title) return;
    await onUpdateClipTitle(project.id, clip.id, clean);
  };

  const handleRegenerate = async (clipId: string) => {
    setActionError(null);
    setBusyClipId(clipId);
    try {
      await onRegenerateClip(project.id, clipId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to regenerate clip.');
    } finally {
      setBusyClipId(null);
    }
  };

  const handleRenderAndDownload = async (clip: ClipRecord) => {
    setActionError(null);
    if (clip.renderStatus === 'export_ready' && clip.renderedVideoUrl) {
      await triggerVerifiedMp4Download(project.id, clip.id);
      return;
    }
    setBusyClipId(clip.id);
    setPendingAutoDownloadIds((prev) => (prev.includes(clip.id) ? prev : [...prev, clip.id]));
    try {
      await onRenderClipDirect(project.id, clip.id, {
        resolution: '1080p',
        codec: 'h264',
        fps: 30,
        quality: 'excellent',
        embedCaptions: true,
        includeMusic: true,
      });
    } catch (err) {
      setPendingAutoDownloadIds((prev) => prev.filter((id) => id !== clip.id));
      setActionError(err instanceof Error ? err.message : 'Failed to start MP4 render.');
    } finally {
      setBusyClipId(null);
    }
  };

  const handleRenderAllHD = async () => {
    const targets = unrenderedIds.length > 0 ? unrenderedIds : project.clips.map((c) => c.id);
    if (targets.length === 0) return;
    setActionError(null);
    setRenderingAll(true);
    try {
      await onRenderAllClips(project.id, targets, {
        resolution: '1080p',
        codec: 'h264',
        fps: 30,
        quality: 'excellent',
        embedCaptions: true,
        includeMusic: true,
      });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to queue batch render.');
    } finally {
      setRenderingAll(false);
    }
  };

  const openClipPreview = (clip: ClipRecord) => {
    if (clip.renderedVideoUrl && clip.renderStatus === 'export_ready') {
      setPreviewTarget({
        title: clip.title,
        subtitle: `Verified Rendered MP4 · ${clip.renderedResolution || clip.framing.aspectRatio} · ${formatDurationHuman(clip.renderedDuration ?? clip.duration)}`,
        src: `${clip.renderedVideoUrl}?t=${encodeURIComponent(clip.renderedAt || clip.updatedAt)}`,
        isRenderedMp4: true,
      });
    } else if (project.sourceUrl) {
      setPreviewTarget({
        title: clip.title,
        subtitle: `Source Preview · ${formatTimecode(clip.startTime)} – ${formatTimecode(clip.endTime)} (${formatDurationHuman(clip.duration)})`,
        src: project.sourceUrl,
        startTime: clip.startTime,
        endTime: clip.endTime,
        isRenderedMp4: false,
      });
    } else {
      setActionError('Source video preview is unavailable for this clip.');
    }
  };

  const openHookPreview = (cand: HookCandidate) => {
    if (!project.sourceUrl) {
      setActionError('Original source video is unavailable for preview.');
      return;
    }
    setPreviewTarget({
      title: cand.title,
      subtitle: `Original Section · ${formatTimecode(cand.startTime)} – ${formatTimecode(cand.endTime)} (${formatDurationHuman(cand.duration)})`,
      src: project.sourceUrl,
      startTime: cand.startTime,
      endTime: cand.endTime,
      isRenderedMp4: false,
    });
  };

  const handleCandidateAction = async (
    cand: HookCandidate,
    action: 'approve' | 'reject' | 'save_times' | 'generate_clip'
  ) => {
    setActionError(null);
    setActionNotice(null);
    setBusyCandidateId(cand.id);
    try {
      if (action === 'approve') {
        await onUpdateHookCandidate(project.id, cand.id, { status: 'approved' });
      } else if (action === 'reject') {
        await onUpdateHookCandidate(project.id, cand.id, { status: 'rejected' });
      } else if (action === 'save_times') {
        const draft = timestampDrafts[cand.id];
        if (draft) {
          const parsedStart = Number(draft.start);
          const parsedEnd = Number(draft.end);
          if (!Number.isFinite(parsedStart) || !Number.isFinite(parsedEnd) || parsedEnd <= parsedStart + 1) {
            setActionError('End timestamp must be at least 1 second after start timestamp.');
            return;
          }
          await onUpdateHookCandidate(project.id, cand.id, {
            startTime: parsedStart,
            endTime: parsedEnd,
          });
          setActionNotice(`Updated timestamps for "${cand.title}" and synced transcript excerpt.`);
        }
      } else if (action === 'generate_clip') {
        const draft = timestampDrafts[cand.id];
        if (draft) {
          const parsedStart = Number(draft.start);
          const parsedEnd = Number(draft.end);
          if (Number.isFinite(parsedStart) && Number.isFinite(parsedEnd) && parsedEnd > parsedStart + 1) {
            await onUpdateHookCandidate(project.id, cand.id, {
              startTime: parsedStart,
              endTime: parsedEnd,
              status: 'approved',
            });
          }
        }
        await onGenerateClipFromHook(project.id, cand.id);
        setActionNotice(`Generated clip "${cand.title}" and started FFmpeg MP4 rendering + validation.`);
        setActiveTab('clips');
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Hook action failed.');
    } finally {
      setBusyCandidateId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Batch HD Download Controls */}
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 pb-5 border-b border-[#D4AF37]/15">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Generated Highlight Clips</h1>
          <p className="mt-1 text-xs text-zinc-400">
            {project.name} · {project.clips.length} generated clips ({renderedCount} verified MP4 ready) · {verifiedHookCount} verified hooks discovered.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {project.clips.length > 0 && (
            <button
              onClick={() => void handleRenderAllHD()}
              disabled={renderingAll}
              className="studio-btn-primary inline-flex items-center gap-2 h-10 px-4 rounded-xl text-xs font-semibold text-white whitespace-nowrap disabled:opacity-50"
            >
              {renderingAll ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Sparkles className="w-4 h-4 text-[#FEF3C7]" />
              )}
              {unrenderedIds.length > 0
                ? `Render Missing MP4s (${unrenderedIds.length})`
                : 'Re-Render All in 1080p HD'}
            </button>
          )}

          {renderedCount > 0 && (
            <button
              onClick={() => void handleDownloadZip()}
              disabled={downloadingZip}
              className="studio-btn-gold inline-flex items-center gap-2 h-10 px-4 rounded-xl text-xs font-semibold whitespace-nowrap disabled:opacity-50"
            >
              {downloadingZip ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Archive className="w-4 h-4" />
              )}
              {downloadingZip ? 'Packaging ZIP...' : `Download All ZIP (${renderedCount})`}
            </button>
          )}
        </div>
      </div>

      {/* View Switcher: Generated Clips vs Hook Intelligence */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#0B130F] border border-[#D4AF37]/20 self-start">
          <button
            onClick={() => setActiveTab('clips')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'clips'
                ? 'bg-[#059669] text-white border border-[#D4AF37]/35'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Film className="w-3.5 h-3.5" />
            Generated Clips ({project.clips.length})
          </button>
          <button
            onClick={() => setActiveTab('hooks')}
            className={`inline-flex items-center gap-2 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap ${
              activeTab === 'hooks'
                ? 'bg-[#059669] text-white border border-[#D4AF37]/35'
                : 'text-zinc-400 hover:text-white'
            }`}
          >
            <Brain className="w-3.5 h-3.5 text-[#F5C451]" />
            Hook Intelligence ({hookCandidates.length})
          </button>
        </div>

        {/* Sort Filter Bar */}
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B130F] border border-[#D4AF37]/15 overflow-x-auto max-w-full">
          {(
            [
              ['overall', 'Highest Score'],
              ['emotional', 'Most Emotional'],
              ['informative', 'Most Informative'],
              ['entertaining', 'Most Entertaining'],
              ['surprising', 'Most Surprising'],
              ['storytelling', 'Best Storytelling'],
              ['chronological', 'Chronological'],
            ] as Array<[ClipSortKey, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSortBy(key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                sortBy === key
                  ? 'bg-[#059669] text-white border border-[#D4AF37]/35'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Inline Status & Error Banners */}
      {actionError && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-red-500/12 border border-red-500/35 text-xs text-red-200">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{actionError}</span>
          </div>
          <button onClick={() => setActionError(null)} className="p-1 text-red-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {actionNotice && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-emerald-500/12 border border-emerald-500/30 text-xs text-emerald-200">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{actionNotice}</span>
          </div>
          <button onClick={() => setActionNotice(null)} className="p-1 text-emerald-300 hover:text-white">
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {project.hookSelectionNote && (
        <div className="px-4 py-3 rounded-xl bg-[#D4AF37]/10 border border-[#D4AF37]/25 text-xs text-[#FEF3C7]">
          {project.hookSelectionNote}
        </div>
      )}

      {/* TAB 1: GENERATED CLIPS */}
      {activeTab === 'clips' && (
        <>
          {sortedClips.length === 0 ? (
            <div className="p-12 rounded-2xl studio-panel text-center">
              <Film className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
              <h3 className="font-display text-base font-semibold text-white">No clips generated yet</h3>
              <p className="mt-1 text-sm text-zinc-400">
                Run the AI Analysis pipeline or approve a candidate from Hook Intelligence to generate verified MP4 clips.
              </p>
              <button
                onClick={() => onNavigate('analysis')}
                className="mt-4 studio-btn-primary h-10 px-5 rounded-lg text-sm font-medium text-white"
              >
                Go to AI Analysis
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {sortedClips.map((clip, idx) => {
                const isBusy = busyClipId === clip.id;
                const isDownloading = downloadingClipId === clip.id;
                const latestJob = exportJobs.find(
                  (j) => j.projectId === project.id && j.clipId === clip.id
                );
                const isEncoding =
                  (latestJob && (latestJob.status === 'queued' || latestJob.status === 'rendering')) ||
                  clip.renderStatus === 'queued' ||
                  clip.renderStatus === 'rendering' ||
                  clip.renderStatus === 'validating' ||
                  clip.renderStatus === 'saving';
                const stageInfo = getStageLabel(clip, latestJob);
                const isExportReady = Boolean(
                  !isEncoding && (clip.renderStatus === 'export_ready' || clip.renderedVideoUrl)
                );
                const fileSize = clip.renderedFileSize ?? latestJob?.fileSize;
                const renderErr = clip.renderError || (latestJob?.status === 'failed' ? latestJob.error : undefined);

                return (
                  <div
                    key={clip.id}
                    className="rounded-2xl studio-card overflow-hidden flex flex-col"
                  >
                    <div className="flex flex-col sm:flex-row gap-4 p-4">
                      {/* Thumbnail with Play Preview */}
                      <button
                        onClick={() => openClipPreview(clip)}
                        title="Preview clip"
                        className="relative sm:w-44 aspect-video sm:aspect-[4/3] rounded-xl bg-black overflow-hidden shrink-0 group border border-white/[0.08]"
                      >
                        <img
                          src={clip.thumbnailUrl}
                          alt={clip.title}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                        />
                        <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <div className="h-9 w-9 rounded-full bg-black/75 border border-[#D4AF37]/40 flex items-center justify-center text-white">
                            <Play className="w-4 h-4 ml-0.5" />
                          </div>
                        </div>
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-2.5 py-2 flex items-center justify-between font-mono text-[11px] text-white tabular-nums">
                          <span>{formatDurationHuman(clip.renderedDuration ?? clip.duration)}</span>
                          <span>{clip.framing.aspectRatio}</span>
                        </div>
                      </button>

                      {/* Title, Timestamps, Opening Hook Quote */}
                      <div className="min-w-0 flex-1 flex flex-col justify-between">
                        <div>
                          <div className="flex items-center justify-between gap-2 text-xs text-zinc-400 tabular-nums">
                            <span className="truncate">
                              Clip {String(idx + 1).padStart(2, '0')} · {clip.topic || clip.category} ·{' '}
                              <span
                                className={
                                  stageInfo.tone === 'ready'
                                    ? 'text-emerald-400 font-medium'
                                    : stageInfo.tone === 'busy'
                                      ? 'text-[#F5C451] font-medium'
                                      : stageInfo.tone === 'error'
                                        ? 'text-red-400 font-medium'
                                        : 'text-zinc-400'
                                }
                              >
                                {stageInfo.text}
                              </span>
                            </span>
                            <span className="font-mono font-semibold text-[#F5C451] shrink-0">
                              Score {clip.hookBreakdown?.total ?? clip.scores.overall}/100
                            </span>
                          </div>

                          {editingTitleId === clip.id ? (
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <input
                                type="text"
                                value={titleDraft}
                                onChange={(e) => setTitleDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') void saveTitle(clip);
                                  if (e.key === 'Escape') setEditingTitleId(null);
                                }}
                                autoFocus
                                className="flex-1 h-8 px-2.5 rounded-md bg-[#0C1510] border border-[#D4AF37] text-sm text-white focus:outline-none"
                              />
                              <button
                                onClick={() => void saveTitle(clip)}
                                className="h-8 w-8 flex items-center justify-center rounded-md bg-[#059669] text-white"
                              >
                                <Check className="w-4 h-4" />
                              </button>
                            </div>
                          ) : (
                            <div className="mt-1 flex items-start justify-between gap-2">
                              <h3 className="font-display text-base font-semibold text-white leading-snug">
                                {clip.title}
                              </h3>
                              <button
                                onClick={() => {
                                  setEditingTitleId(clip.id);
                                  setTitleDraft(clip.title);
                                }}
                                aria-label="Edit clip title"
                                className="p-1 text-zinc-500 hover:text-[#F5C451] shrink-0"
                              >
                                <Edit3 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}

                          <div className="mt-1 font-mono text-[11px] text-zinc-400 tabular-nums">
                            Source {formatTimecode(clip.startTime)} – {formatTimecode(clip.endTime)}
                            {clip.renderedResolution ? (
                              <span className="text-zinc-500"> · {clip.renderedResolution}</span>
                            ) : null}
                            {fileSize ? (
                              <span className="text-emerald-400/90"> · {formatBytes(fileSize)} MP4</span>
                            ) : null}
                          </div>

                          {clip.openingDialogue ? (
                            <p
                              dir={isRtlText(clip.openingDialogue) ? 'rtl' : 'ltr'}
                              className="mt-2 text-xs text-emerald-100/90 italic leading-relaxed line-clamp-2"
                            >
                              “{clip.openingDialogue}”
                            </p>
                          ) : (
                            <p className="mt-2 text-xs text-zinc-300 leading-relaxed line-clamp-2">
                              {clip.description}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Live Encoding / FFprobe Validation Progress */}
                    {isEncoding && (
                      <div className="px-4 pb-3">
                        <div className="flex items-center justify-between text-[11px] font-mono text-[#F5C451] tabular-nums mb-1">
                          <span>{latestJob?.stageDetail || clip.renderStageDetail || stageInfo.text}</span>
                          <span>{latestJob?.progress ?? 15}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-[#132219] overflow-hidden">
                          <div
                            style={{ width: `${Math.max(8, latestJob?.progress ?? 15)}%` }}
                            className="h-full bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37] transition-[width] duration-200"
                          />
                        </div>
                      </div>
                    )}

                    {/* Actual Render Error Display */}
                    {renderErr && !isEncoding && (
                      <div className="mx-4 mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/25 text-[11px] text-red-200 flex items-start gap-2">
                        <AlertCircle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
                        <span>{renderErr}</span>
                      </div>
                    )}

                    {/* AI Reasoning & 7-Criterion Breakdown */}
                    <div className="px-4 py-3 bg-[#070E0A]/90 border-t border-[#D4AF37]/12 space-y-2">
                      <p className="text-xs text-zinc-400 leading-relaxed">
                        <span className="text-zinc-200 font-medium">Why selected:</span>{' '}
                        {clip.reasonSelected}
                      </p>
                      {clip.hookBreakdown ? (
                        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px] text-zinc-400 tabular-nums">
                          <span>Hook {clip.hookBreakdown.openingHook}/20</span>
                          <span>Curiosity {clip.hookBreakdown.curiosityInterest}/15</span>
                          <span>Emotion {clip.hookBreakdown.emotionalEngagement}/15</span>
                          <span>Value {clip.hookBreakdown.infoEntertainment}/15</span>
                          <span>Arc {clip.hookBreakdown.storyCompleteness}/15</span>
                          <span>Context {clip.hookBreakdown.standaloneContext}/10</span>
                          <span>A/V {clip.hookBreakdown.audioVisualQuality}/10</span>
                        </div>
                      ) : (
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-400 tabular-nums">
                          <span>Hook {clip.scores.hookStrength}</span>
                          <span>Story {clip.scores.storyCompleteness}</span>
                          <span>Info {clip.scores.informationValue}</span>
                          <span>Emotion {clip.scores.emotionalImpact}</span>
                        </div>
                      )}
                    </div>

                    {/* Action Bar: Preview, Download MP4, Edit, Regenerate, Delete */}
                    <div className="px-4 py-3 border-t border-[#D4AF37]/12 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => openClipPreview(clip)}
                          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-zinc-100 transition-colors whitespace-nowrap"
                        >
                          <Eye className="w-3.5 h-3.5 text-[#10B981]" />
                          Preview
                        </button>

                        <button
                          onClick={() => void handleRenderAndDownload(clip)}
                          disabled={Boolean(isBusy || isEncoding || isDownloading)}
                          className={`${
                            isExportReady ? 'studio-btn-gold' : 'studio-btn-primary text-white'
                          } inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-semibold whitespace-nowrap disabled:opacity-50`}
                        >
                          {isDownloading || isEncoding ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Download className="w-3.5 h-3.5" />
                          )}
                          {isDownloading
                            ? 'Downloading MP4...'
                            : isEncoding
                              ? stageInfo.text
                              : isExportReady
                                ? 'Download MP4'
                                : 'Render & Download MP4'}
                        </button>

                        <button
                          onClick={() => onEditClip(clip.id)}
                          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-white transition-colors whitespace-nowrap"
                        >
                          <SlidersHorizontal className="w-3.5 h-3.5 text-[#F5C451]" />
                          Edit
                        </button>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => void handleRegenerate(clip.id)}
                          disabled={Boolean(isBusy || isEncoding)}
                          title="Ask AI to select a fresh alternate moment"
                          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-xs font-medium text-zinc-300 transition-colors whitespace-nowrap disabled:opacity-50"
                        >
                          {isBusy ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          Regenerate
                        </button>
                        <button
                          onClick={() => void onDeleteClip(project.id, clip.id)}
                          aria-label="Delete clip"
                          className="h-9 w-9 flex items-center justify-center rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* TAB 2: HOOK INTELLIGENCE */}
      {activeTab === 'hooks' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 rounded-xl studio-panel">
            <div className="text-xs text-zinc-300">
              <span className="font-semibold text-white">Two-Pass Hook Intelligence:</span>{' '}
              Inspect every discovered opening hook, 7-criterion score breakdown, Pass 2 verification audit, verbatim transcript, and fine-tune start/end timestamps before generating MP4 clips.
            </div>
            <label className="inline-flex items-center gap-2 text-xs text-zinc-400 cursor-pointer shrink-0">
              <input
                type="checkbox"
                checked={showRejectedHooks}
                onChange={(e) => setShowRejectedHooks(e.target.checked)}
                className="accent-[#10B981]"
              />
              Show Pass 2 rejected candidates
            </label>
          </div>

          {sortedHookCandidates.length === 0 ? (
            <div className="p-12 rounded-2xl studio-panel text-center">
              <Brain className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
              <h3 className="font-display text-base font-semibold text-white">
                No Hook Candidates Recorded Yet
              </h3>
              <p className="mt-1 text-sm text-zinc-400">
                Run or re-run AI Analysis on this project to populate two-pass Hook Intelligence candidates.
              </p>
              <button
                onClick={() => onNavigate('analysis')}
                className="mt-4 studio-btn-primary h-10 px-5 rounded-lg text-sm font-medium text-white"
              >
                Open AI Analysis
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {sortedHookCandidates.map((cand) => {
                const isBusy = busyCandidateId === cand.id;
                const draft = timestampDrafts[cand.id] ?? {
                  start: String(cand.startTime),
                  end: String(cand.endTime),
                };
                const hasTimeChange =
                  Number(draft.start) !== cand.startTime || Number(draft.end) !== cand.endTime;
                const isExpanded = Boolean(expandedTranscriptIds[cand.id]);

                const statusColor =
                  cand.status === 'generated'
                    ? 'text-emerald-300 border-emerald-500/35 bg-emerald-500/12'
                    : cand.status === 'approved' || cand.status === 'verified'
                      ? 'text-[#FEF3C7] border-[#D4AF37]/35 bg-[#D4AF37]/12'
                      : cand.status === 'rejected'
                        ? 'text-red-300 border-red-500/35 bg-red-500/10'
                        : 'text-zinc-300 border-white/15 bg-white/5';

                return (
                  <div
                    key={cand.id}
                    className={`rounded-2xl studio-card p-5 space-y-4 ${
                      cand.status === 'rejected' ? 'opacity-80' : ''
                    }`}
                  >
                    {/* Top Row: Title, Topic, Status, Total Score */}
                    <div className="flex flex-col md:flex-row md:items-start justify-between gap-3">
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <span className={`px-2 py-0.5 rounded-md border font-semibold uppercase tracking-wide ${statusColor}`}>
                            {cand.status === 'generated'
                              ? 'Clip Generated'
                              : cand.status === 'verified'
                                ? 'Pass 2 Verified'
                                : cand.status}
                          </span>
                          <span className="px-2 py-0.5 rounded-md bg-[#0C1510] border border-[#D4AF37]/20 text-zinc-300 font-medium">
                            Topic: {cand.topic}
                          </span>
                          <span className="text-zinc-500 font-mono">
                            {cand.category} · {cand.speakerLabel}
                          </span>
                        </div>
                        <h3 className="font-display text-base font-semibold text-white">
                          {cand.title}
                        </h3>
                      </div>

                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right">
                          <div className="font-mono text-xl font-bold text-[#F5C451] tabular-nums">
                            {cand.hookBreakdown.total}
                            <span className="text-xs text-zinc-500 font-normal">/100</span>
                          </div>
                          <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                            Hook Score
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Actual Verbatim Opening Dialogue */}
                    {cand.openingDialogue && (
                      <div className="p-3.5 rounded-xl bg-[#070E0A] border border-[#10B981]/25 flex items-start gap-2.5">
                        <Quote className="w-4 h-4 text-[#10B981] shrink-0 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-[11px] font-medium text-emerald-400 uppercase tracking-wide">
                            Actual Opening Dialogue
                          </div>
                          <p
                            dir={isRtlText(cand.openingDialogue) ? 'rtl' : 'ltr'}
                            className="mt-1 text-sm text-white leading-relaxed"
                          >
                            “{cand.openingDialogue}”
                          </p>
                        </div>
                      </div>
                    )}

                    {/* 7-Criterion Scoring Breakdown Grid */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 font-mono text-[11px] tabular-nums">
                      {[
                        ['Opening Hook', cand.hookBreakdown.openingHook, 20],
                        ['Curiosity', cand.hookBreakdown.curiosityInterest, 15],
                        ['Emotion', cand.hookBreakdown.emotionalEngagement, 15],
                        ['Info / Ent.', cand.hookBreakdown.infoEntertainment, 15],
                        ['Completeness', cand.hookBreakdown.storyCompleteness, 15],
                        ['Standalone', cand.hookBreakdown.standaloneContext, 10],
                        ['A/V Quality', cand.hookBreakdown.audioVisualQuality, 10],
                      ].map(([label, pts, max]) => (
                        <div
                          key={String(label)}
                          className="px-2.5 py-2 rounded-lg bg-[#0B140F] border border-[#D4AF37]/12"
                        >
                          <div className="text-[10px] text-zinc-500 truncate">{label}</div>
                          <div className="mt-0.5 text-zinc-100 font-semibold">
                            {pts}
                            <span className="text-zinc-500">/{max}</span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Why AI Selected + Verification Notes + Rejections */}
                    <div className="space-y-1.5 text-xs text-zinc-300">
                      <p>
                        <span className="font-semibold text-white">Why AI selected it:</span>{' '}
                        {cand.reasonSelected}
                      </p>
                      {cand.verificationNotes && (
                        <p className="text-zinc-400">
                          <span className="font-semibold text-emerald-300">Pass 2 Audit:</span>{' '}
                          {cand.verificationNotes}
                        </p>
                      )}
                      {cand.rejectedReasons && cand.rejectedReasons.length > 0 && (
                        <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-200">
                          <span className="font-semibold">Flagged issues: </span>
                          {cand.rejectedReasons.join(' · ')}
                        </div>
                      )}
                    </div>

                    {/* Editable Start & End Timestamps */}
                    <div className="flex flex-wrap items-end gap-3 p-3 rounded-xl bg-[#070E0A]/90 border border-[#D4AF37]/12">
                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          Start (sec · {formatTimecode(Number(draft.start) || 0)})
                        </label>
                        <input
                          type="number"
                          step="0.5"
                          min={0}
                          max={project.metadata?.duration ?? 99999}
                          value={draft.start}
                          onChange={(e) =>
                            setTimestampDrafts((prev) => ({
                              ...prev,
                              [cand.id]: { start: e.target.value, end: draft.end },
                            }))
                          }
                          className="w-28 h-8 px-2.5 rounded-md bg-[#0C1510] border border-[#D4AF37]/25 font-mono text-xs text-white"
                        />
                      </div>

                      <div>
                        <label className="block text-[11px] text-zinc-400 mb-1">
                          End (sec · {formatTimecode(Number(draft.end) || 0)})
                        </label>
                        <input
                          type="number"
                          step="0.5"
                          min={1}
                          max={project.metadata?.duration ?? 99999}
                          value={draft.end}
                          onChange={(e) =>
                            setTimestampDrafts((prev) => ({
                              ...prev,
                              [cand.id]: { start: draft.start, end: e.target.value },
                            }))
                          }
                          className="w-28 h-8 px-2.5 rounded-md bg-[#0C1510] border border-[#D4AF37]/25 font-mono text-xs text-white"
                        />
                      </div>

                      <div className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md bg-[#0C1510] border border-white/10 font-mono text-xs text-[#F5C451] tabular-nums">
                        <Clock className="w-3.5 h-3.5" />
                        {formatDurationHuman(
                          Math.max(0, (Number(draft.end) || cand.endTime) - (Number(draft.start) || cand.startTime))
                        )}
                      </div>

                      {hasTimeChange && (
                        <button
                          onClick={() => void handleCandidateAction(cand, 'save_times')}
                          disabled={isBusy}
                          className="h-8 px-3 rounded-md bg-[#059669] hover:bg-[#10B981] text-xs font-semibold text-white"
                        >
                          Save Timestamps
                        </button>
                      )}

                      {cand.transcriptExcerpt && (
                        <button
                          onClick={() =>
                            setExpandedTranscriptIds((prev) => ({
                              ...prev,
                              [cand.id]: !prev[cand.id],
                            }))
                          }
                          className="ml-auto inline-flex items-center gap-1 h-8 px-2.5 rounded-md text-xs text-zinc-300 hover:text-white hover:bg-white/5"
                        >
                          {isExpanded ? (
                            <>
                              Hide Transcript <ChevronUp className="w-3.5 h-3.5" />
                            </>
                          ) : (
                            <>
                              Full Transcript <ChevronDown className="w-3.5 h-3.5" />
                            </>
                          )}
                        </button>
                      )}
                    </div>

                    {isExpanded && cand.transcriptExcerpt && (
                      <pre
                        dir={isRtlText(cand.transcriptExcerpt) ? 'rtl' : 'ltr'}
                        className="p-3.5 rounded-xl bg-[#050A07] border border-white/10 text-xs text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed max-h-56 overflow-y-auto"
                      >
                        {cand.transcriptExcerpt}
                      </pre>
                    )}

                    {/* Candidate Actions */}
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#D4AF37]/12">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => openHookPreview(cand)}
                          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-white"
                        >
                          <Play className="w-3.5 h-3.5 text-[#10B981]" />
                          Preview Original Section
                        </button>

                        <button
                          onClick={() => void handleCandidateAction(cand, 'approve')}
                          disabled={isBusy || cand.status === 'approved'}
                          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-xs font-medium text-emerald-200 disabled:opacity-40"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Approve
                        </button>

                        <button
                          onClick={() => void handleCandidateAction(cand, 'reject')}
                          disabled={isBusy || cand.status === 'rejected'}
                          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg bg-red-500/12 hover:bg-red-500/22 border border-red-500/25 text-xs font-medium text-red-200 disabled:opacity-40"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Reject
                        </button>
                      </div>

                      <button
                        onClick={() => void handleCandidateAction(cand, 'generate_clip')}
                        disabled={isBusy}
                        className="studio-btn-gold inline-flex items-center gap-1.5 h-9 px-4 rounded-lg text-xs font-semibold whitespace-nowrap disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Sparkles className="w-3.5 h-3.5" />
                        )}
                        {cand.clipId ? 'Update Clip & Render MP4' : 'Generate Clip & Render MP4'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* INLINE CLIP / HOOK PREVIEW MODAL */}
      {previewTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setPreviewTarget(null)}
        >
          <div
            className="w-full max-w-3xl rounded-2xl studio-panel border border-[#D4AF37]/30 overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3.5 border-b border-[#D4AF37]/15 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-display text-sm font-semibold text-white truncate">
                  {previewTarget.title}
                </h3>
                <p className="text-[11px] text-zinc-400 font-mono truncate">
                  {previewTarget.subtitle}
                </p>
              </div>
              <button
                onClick={() => setPreviewTarget(null)}
                aria-label="Close preview"
                className="h-8 w-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center text-zinc-300"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="bg-black flex items-center justify-center max-h-[70vh]">
              <video
                ref={previewVideoRef}
                src={previewTarget.src}
                controls
                autoPlay
                playsInline
                onLoadedMetadata={(e) => {
                  const vid = e.currentTarget;
                  if (!previewTarget.isRenderedMp4 && typeof previewTarget.startTime === 'number') {
                    vid.currentTime = previewTarget.startTime;
                  }
                }}
                onTimeUpdate={(e) => {
                  const vid = e.currentTarget;
                  if (
                    !previewTarget.isRenderedMp4 &&
                    typeof previewTarget.endTime === 'number' &&
                    vid.currentTime >= previewTarget.endTime
                  ) {
                    vid.pause();
                    if (typeof previewTarget.startTime === 'number') {
                      vid.currentTime = previewTarget.startTime;
                    }
                  }
                }}
                className="max-h-[70vh] w-full object-contain"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
