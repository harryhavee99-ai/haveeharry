import React, { useMemo, useState } from 'react';
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
} from 'lucide-react';
import type {
  ClipRecord,
  ExportJob,
  ExportOptions,
  NavPage,
  ProjectRecord,
} from '../../shared/types.ts';
import { formatBytes, formatDurationHuman, formatTimecode } from '../lib/format.ts';

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
  onNavigate: (page: NavPage) => void;
}

type SortKey =
  | 'overall'
  | 'interesting'
  | 'educational'
  | 'funny'
  | 'emotional'
  | 'informative'
  | 'chronological';

export function ClipsPage({
  project,
  exportJobs,
  onEditClip,
  onUpdateClipTitle,
  onRegenerateClip,
  onDeleteClip,
  onRenderClipDirect,
  onRenderAllClips,
  onNavigate,
}: ClipsPageProps) {
  const [sortBy, setSortBy] = useState<SortKey>('overall');
  const [editingTitleId, setEditingTitleId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [busyClipId, setBusyClipId] = useState<string | null>(null);
  const [renderingAll, setRenderingAll] = useState(false);

  const sortedClips = useMemo(() => {
    if (!project) return [];
    const list = [...project.clips];
    switch (sortBy) {
      case 'overall':
        return list.sort((a, b) => b.scores.overall - a.scores.overall);
      case 'interesting':
        return list.sort((a, b) => b.scores.engagement - a.scores.engagement);
      case 'educational':
        return list.sort((a, b) => b.scores.educationalValue - a.scores.educationalValue);
      case 'funny':
        return list.sort((a, b) => b.scores.humor - a.scores.humor);
      case 'emotional':
        return list.sort((a, b) => b.scores.emotionalImpact - a.scores.emotionalImpact);
      case 'informative':
        return list.sort((a, b) => b.scores.informationValue - a.scores.informationValue);
      case 'chronological':
        return list.sort((a, b) => a.startTime - b.startTime);
      default:
        return list;
    }
  }, [project, sortBy]);

  if (!project) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">No Project Selected</h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Upload and analyze a video to generate short-form highlight clips ready for HD download.
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

  const renderedCount = project.clips.filter((c) => c.renderedVideoUrl).length;
  const unrenderedIds = project.clips.filter((c) => !c.renderedVideoUrl).map((c) => c.id);

  const saveTitle = async (clip: ClipRecord) => {
    const clean = titleDraft.trim();
    setEditingTitleId(null);
    if (!clean || clean === clip.title) return;
    await onUpdateClipTitle(project.id, clip.id, clean);
  };

  const handleRegenerate = async (clipId: string) => {
    setBusyClipId(clipId);
    try {
      await onRegenerateClip(project.id, clipId);
    } finally {
      setBusyClipId(null);
    }
  };

  const handleRenderSingleHD = async (clipId: string) => {
    setBusyClipId(clipId);
    try {
      await onRenderClipDirect(project.id, clipId, {
        resolution: '1080p',
        codec: 'h264',
        fps: 30,
        quality: 'excellent',
        embedCaptions: true,
        includeMusic: true,
      });
    } finally {
      setBusyClipId(null);
    }
  };

  const handleRenderAllHD = async () => {
    const targets = unrenderedIds.length > 0 ? unrenderedIds : project.clips.map((c) => c.id);
    if (targets.length === 0) return;
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
    } finally {
      setRenderingAll(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Batch HD Download Controls */}
      <div className="flex flex-col xl:flex-row xl:items-end justify-between gap-4 pb-5 border-b border-[#D4AF37]/15">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Generated Highlight Clips</h1>
          <p className="mt-1 text-xs text-zinc-400">
            {project.name} · {project.clips.length} AI-selected standalone clips · Render and download directly in Excellent 1080p HD (CRF 18 · 192k AAC).
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
                ? `Prepare All HD Clips (${unrenderedIds.length})`
                : 'Re-Render All in Excellent HD'}
            </button>
          )}

          {renderedCount > 0 && (
            <a
              href={`/api/projects/${project.id}/download-zip`}
              download
              className="studio-btn-gold inline-flex items-center gap-2 h-10 px-4 rounded-xl text-xs font-semibold whitespace-nowrap"
            >
              <Archive className="w-4 h-4" />
              Download All ZIP ({renderedCount})
            </a>
          )}
        </div>
      </div>

      {/* Sort Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-[#0B130F] border border-[#D4AF37]/15 overflow-x-auto max-w-full">
          {(
            [
              ['overall', 'Highest AI Score'],
              ['interesting', 'Interesting'],
              ['educational', 'Educational'],
              ['funny', 'Funny'],
              ['emotional', 'Emotional'],
              ['informative', 'Informative'],
              ['chronological', 'Chronological'],
            ] as Array<[SortKey, string]>
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

        <span className="text-xs text-zinc-500">
          Scores represent AI-estimated editorial quality, not guaranteed viral metrics.
        </span>
      </div>

      {sortedClips.length === 0 ? (
        <div className="p-12 rounded-2xl studio-panel text-center">
          <Film className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
          <h3 className="font-display text-base font-semibold text-white">No clips generated yet</h3>
          <p className="mt-1 text-sm text-zinc-400">
            Run the AI Analysis pipeline on this project to automatically extract highlight clips.
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
            const latestJob = exportJobs.find(
              (j) => j.projectId === project.id && j.clipId === clip.id
            );
            const isEncoding =
              latestJob && (latestJob.status === 'queued' || latestJob.status === 'rendering');
            const statusText = isEncoding
              ? `Encoding ${latestJob.progress}%`
              : clip.renderedVideoUrl
                ? 'Ready to Download'
                : clip.editingStatus === 'edited'
                  ? 'Edited'
                  : 'Auto-generated';

            return (
              <div
                key={clip.id}
                className="rounded-2xl studio-card overflow-hidden flex flex-col"
              >
                <div className="flex flex-col sm:flex-row gap-4 p-4">
                  {/* Thumbnail with Play Overlay */}
                  <button
                    onClick={() => onEditClip(clip.id)}
                    className="relative sm:w-44 aspect-video sm:aspect-[4/3] rounded-xl bg-black overflow-hidden shrink-0 group border border-white/[0.08]"
                  >
                    <img
                      src={clip.thumbnailUrl}
                      alt={clip.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                    />
                    <div className="absolute inset-0 bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                      <div className="h-9 w-9 rounded-full bg-black/75 border border-white/20 flex items-center justify-center text-white">
                        <Play className="w-4 h-4 ml-0.5" />
                      </div>
                    </div>
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/45 to-transparent px-2.5 py-2 flex items-center justify-between font-mono text-[11px] text-white tabular-nums">
                      <span>{formatDurationHuman(clip.duration)}</span>
                      <span>{clip.framing.aspectRatio}</span>
                    </div>
                  </button>

                  {/* Title, Timestamps, Description */}
                  <div className="min-w-0 flex-1 flex flex-col justify-between">
                    <div>
                      <div className="flex items-center justify-between gap-2 text-xs text-zinc-400 tabular-nums">
                        <span>
                          Clip {String(idx + 1).padStart(2, '0')} · {clip.category} ·{' '}
                          <span
                            className={
                              clip.renderedVideoUrl
                                ? 'text-emerald-400 font-medium'
                                : isEncoding
                                  ? 'text-[#F5C451] font-medium'
                                  : ''
                            }
                          >
                            {statusText}
                          </span>
                        </span>
                        <span className="font-mono font-semibold text-[#F5C451]">
                          AI Est. {clip.scores.overall}/100
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
                        {latestJob?.status === 'completed' && latestJob.fileSize ? (
                          <span className="text-zinc-500"> · {formatBytes(latestJob.fileSize)}</span>
                        ) : null}
                      </div>

                      <p className="mt-2 text-xs text-zinc-300 leading-relaxed line-clamp-2">
                        {clip.description}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Live Encoding Progress Bar when actively rendering */}
                {isEncoding && latestJob && (
                  <div className="px-4 pb-3">
                    <div className="flex items-center justify-between text-[11px] font-mono text-[#F5C451] tabular-nums mb-1">
                      <span>Encoding Excellent Quality 1080p MP4...</span>
                      <span>{latestJob.progress}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#132219] overflow-hidden">
                      <div
                        style={{ width: `${latestJob.progress}%` }}
                        className="h-full bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37] transition-[width] duration-200"
                      />
                    </div>
                  </div>
                )}

                {/* AI Reasoning & Sub-Scores */}
                <div className="px-4 py-3 bg-[#070E0A]/90 border-t border-[#D4AF37]/12 space-y-2">
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    <span className="text-zinc-200 font-medium">Why selected:</span>{' '}
                    {clip.reasonSelected}
                  </p>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-400 tabular-nums">
                    <span>Hook {clip.scores.hookStrength}</span>
                    <span>Story {clip.scores.storyCompleteness}</span>
                    <span>Info {clip.scores.informationValue}</span>
                    <span>Emotion {clip.scores.emotionalImpact}</span>
                    <span>Humor {clip.scores.humor}</span>
                  </div>
                </div>

                {/* Action Bar with Direct Excellent-Quality Download */}
                <div className="px-4 py-3 border-t border-[#D4AF37]/12 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => onEditClip(clip.id)}
                      className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-semibold text-white transition-colors whitespace-nowrap"
                    >
                      <SlidersHorizontal className="w-3.5 h-3.5 text-[#F5C451]" />
                      Edit
                    </button>

                    {clip.renderedVideoUrl ? (
                      <a
                        href={`/api/projects/${project.id}/clips/${clip.id}/download`}
                        download
                        className="studio-btn-gold inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-semibold whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download HD MP4
                      </a>
                    ) : (
                      <button
                        onClick={() => void handleRenderSingleHD(clip.id)}
                        disabled={Boolean(isBusy || isEncoding)}
                        className="studio-btn-primary inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg text-xs font-semibold text-white whitespace-nowrap disabled:opacity-50"
                      >
                        {isEncoding ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Download className="w-3.5 h-3.5 text-[#FEF3C7]" />
                        )}
                        {isEncoding ? 'Rendering...' : 'Render HD MP4'}
                      </button>
                    )}
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
    </div>
  );
}
