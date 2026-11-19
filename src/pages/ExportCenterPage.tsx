import React, { useMemo, useState } from 'react';
import {
  Download,
  Archive,
  Play,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
  UploadCloud,
} from 'lucide-react';
import type {
  AppSettings,
  ExportCodec,
  ExportFps,
  ExportJob,
  ExportOptions,
  ExportResolution,
  NavPage,
  ProjectRecord,
  SystemCapabilities,
} from '../../shared/types.ts';
import { formatBytes, formatDurationHuman, formatRelativeDate } from '../lib/format.ts';

interface ExportCenterPageProps {
  project: ProjectRecord | null;
  exportJobs: ExportJob[];
  settings: AppSettings;
  capabilities: SystemCapabilities | null;
  onExportBatch: (
    projectId: string,
    clipIds: string[],
    options: ExportOptions
  ) => Promise<void>;
  onExportSingle: (
    projectId: string,
    clipId: string,
    options: ExportOptions
  ) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

export function ExportCenterPage({
  project,
  exportJobs,
  settings,
  capabilities,
  onExportBatch,
  onExportSingle,
  onNavigate,
}: ExportCenterPageProps) {
  const [options, setOptions] = useState<ExportOptions>({
    resolution: settings.defaultExportResolution,
    codec: settings.defaultExportCodec,
    fps: settings.defaultExportFps,
    quality: 'excellent',
    embedCaptions: true,
    includeMusic: true,
  });

  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const projectJobs = useMemo(
    () => (project ? exportJobs.filter((j) => j.projectId === project.id) : exportJobs),
    [exportJobs, project]
  );

  if (!project) {
    return (
      <div className="p-12 rounded-2xl studio-panel text-center">
        <h2 className="font-display text-lg font-semibold text-white">Export Center</h2>
        <p className="mt-1.5 text-sm text-zinc-400">
          Select or upload a project with generated clips to render production MP4 files and ZIP bundles.
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

  const effectiveSelected =
    selectedIds.length > 0 ? selectedIds : project.clips.map((c) => c.id);
  const renderedClipsCount = project.clips.filter((c) => c.renderedVideoUrl).length;

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleRenderBatch = async () => {
    if (project.clips.length === 0) return;
    setSubmitting(true);
    try {
      await onExportBatch(project.id, effectiveSelected, options);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Export Center</h1>
          <p className="mt-1 text-xs text-zinc-400">
            {project.name} · Real FFmpeg video encoding with embedded ASS captions, reframing, color grading, and ducked audio.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {renderedClipsCount > 0 && (
            <a
              href={`/api/projects/${project.id}/download-zip`}
              download
              className="studio-btn-gold inline-flex items-center gap-2 h-10 px-4 rounded-lg text-xs font-semibold whitespace-nowrap"
            >
              <Archive className="w-4 h-4" />
              Download All as ZIP ({renderedClipsCount})
            </a>
          )}

          <button
            onClick={() => void handleRenderBatch()}
            disabled={submitting || project.clips.length === 0}
            className="studio-btn-primary inline-flex items-center gap-2 h-10 px-4 rounded-lg disabled:opacity-40 text-xs font-semibold text-white whitespace-nowrap"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4 text-[#FEF3C7]" />
            )}
            Render {selectedIds.length > 0 ? `${selectedIds.length} Selected` : `All ${project.clips.length} Clips`}
          </button>
        </div>
      </div>

      {/* Export Encoding Settings */}
      <div className="p-5 rounded-2xl studio-panel grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Resolution</label>
          <select
            value={options.resolution}
            onChange={(e) =>
              setOptions((o) => ({ ...o, resolution: e.target.value as ExportResolution }))
            }
            className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
          >
            <option value="720p" className="bg-[#0C1510]">720p HD (Fast)</option>
            <option value="1080p" className="bg-[#0C1510]">1080p Full HD</option>
            <option value="4k" className="bg-[#0C1510]">4K Ultra HD (2160p)</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Video Quality</label>
          <select
            value={options.quality ?? 'excellent'}
            onChange={(e) =>
              setOptions((o) => ({
                ...o,
                quality: e.target.value as NonNullable<ExportOptions['quality']>,
              }))
            }
            className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
          >
            <option value="standard" className="bg-[#0C1510]">Standard (Fast)</option>
            <option value="excellent" className="bg-[#0C1510]">Excellent (CRF 18 · 192k AAC)</option>
            <option value="master" className="bg-[#0C1510]">Studio Master (CRF 16 · Max)</option>
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Video Codec</label>
          <select
            value={options.codec}
            onChange={(e) =>
              setOptions((o) => ({ ...o, codec: e.target.value as ExportCodec }))
            }
            className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
          >
            <option value="h264" className="bg-[#0C1510]">MP4 · H.264 (Universal)</option>
            {capabilities?.h265Supported !== false && (
              <option value="h265" className="bg-[#0C1510]">MP4 · H.265 / HEVC</option>
            )}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1.5">Frame Rate</label>
          <select
            value={options.fps}
            onChange={(e) =>
              setOptions((o) => ({ ...o, fps: Number(e.target.value) as ExportFps }))
            }
            className="w-full h-9 px-2.5 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white"
          >
            <option value={24} className="bg-[#0C1510]">24 FPS (Cinematic)</option>
            <option value={30} className="bg-[#0C1510]">30 FPS (Standard)</option>
            <option value={60} className="bg-[#0C1510]">60 FPS (Smooth)</option>
          </select>
        </div>

        <label className="flex items-center justify-between px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/15 cursor-pointer">
          <span className="text-xs font-medium text-zinc-200">Embed Captions</span>
          <input
            type="checkbox"
            checked={options.embedCaptions}
            onChange={(e) => setOptions((o) => ({ ...o, embedCaptions: e.target.checked }))}
            className="accent-[#10B981] w-4 h-4"
          />
        </label>

        <label className="flex items-center justify-between px-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/15 cursor-pointer">
          <span className="text-xs font-medium text-zinc-200">Include Music</span>
          <input
            type="checkbox"
            checked={options.includeMusic}
            onChange={(e) => setOptions((o) => ({ ...o, includeMusic: e.target.checked }))}
            className="accent-[#10B981] w-4 h-4"
          />
        </label>
      </div>

      {/* Clips Export Table */}
      <div className="rounded-xl studio-panel overflow-hidden">
        <div className="px-5 py-3.5 border-b border-[#D4AF37]/12 flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-white">
            Project Clips ({project.clips.length})
          </h2>
          {selectedIds.length > 0 && (
            <button
              onClick={() => setSelectedIds([])}
              className="text-xs text-[#F5C451] hover:text-[#FEF3C7]"
            >
              Clear selection ({selectedIds.length})
            </button>
          )}
        </div>

        <div className="divide-y divide-[#D4AF37]/10">
          {project.clips.map((clip, idx) => {
            const latestJob = projectJobs.find((j) => j.clipId === clip.id);
            const isRendering =
              latestJob && (latestJob.status === 'rendering' || latestJob.status === 'queued');
            const isChecked = selectedIds.includes(clip.id);

            return (
              <div
                key={clip.id}
                className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 px-5 py-4 hover:bg-[#059669]/8"
              >
                <div className="flex items-center gap-3.5 min-w-0">
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleSelect(clip.id)}
                    aria-label={`Select ${clip.title}`}
                    className="accent-[#10B981] w-4 h-4 shrink-0"
                  />
                  <div className="w-20 h-12 rounded-md bg-black overflow-hidden shrink-0 border border-[#D4AF37]/15">
                    <img
                      src={clip.thumbnailUrl}
                      alt={clip.title}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-white truncate">
                      {String(idx + 1).padStart(2, '0')}. {clip.title}
                    </div>
                    <div className="mt-0.5 text-xs text-zinc-400 font-mono tabular-nums">
                      {formatDurationHuman(clip.duration)} · {clip.framing.aspectRatio} ·{' '}
                      {clip.captionStyle.enabled ? clip.captionStyle.presetId : 'No captions'}
                    </div>
                  </div>
                </div>

                {/* Progress + Actions */}
                <div className="flex flex-wrap items-center gap-3 shrink-0">
                  {isRendering && latestJob && (
                    <div className="flex items-center gap-2.5 min-w-[160px]">
                      <Loader2 className="w-4 h-4 text-[#F5C451] animate-spin shrink-0" />
                      <div className="flex-1">
                        <div className="flex justify-between text-[11px] text-[#F5C451] font-mono tabular-nums mb-1">
                          <span>{latestJob.status === 'queued' ? 'Queued' : 'Encoding'}</span>
                          <span>{latestJob.progress}%</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-[#132219] overflow-hidden">
                          <div
                            style={{ width: `${latestJob.progress}%` }}
                            className="h-full bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37] transition-[width] duration-200"
                          />
                        </div>
                      </div>
                    </div>
                  )}

                  {!isRendering && latestJob?.status === 'failed' && (
                    <span className="inline-flex items-center gap-1 text-xs text-red-400">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Render failed
                    </span>
                  )}

                  <a
                    href={`/api/projects/${project.id}/clips/${clip.id}/subtitles.srt`}
                    download
                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[#0C1510] hover:bg-[#132219] border border-[#D4AF37]/18 text-xs text-zinc-300 whitespace-nowrap"
                  >
                    <FileText className="w-3.5 h-3.5 text-[#F5C451]" />
                    SRT
                  </a>

                  <button
                    onClick={() => void onExportSingle(project.id, clip.id, options)}
                    disabled={Boolean(isRendering)}
                    className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/22 text-xs font-medium text-white disabled:opacity-40 whitespace-nowrap"
                  >
                    {clip.renderedVideoUrl ? 'Re-Render' : 'Render MP4'}
                  </button>

                  {clip.renderedVideoUrl && (
                    <a
                      href={`/api/projects/${project.id}/clips/${clip.id}/download`}
                      download
                      className="studio-btn-gold inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold whitespace-nowrap"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download HD MP4
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent Render Job Log */}
      {projectJobs.length > 0 && (
        <div className="rounded-xl studio-panel overflow-hidden">
          <div className="px-5 py-3.5 border-b border-[#D4AF37]/12">
            <h2 className="font-display text-sm font-semibold text-white">FFmpeg Render Queue</h2>
          </div>
          <div className="divide-y divide-[#D4AF37]/8">
            {projectJobs.slice(0, 12).map((job) => (
              <div
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-xs"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  {job.status === 'completed' && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  )}
                  {(job.status === 'rendering' || job.status === 'queued') && (
                    <Loader2 className="w-4 h-4 text-[#F5C451] animate-spin shrink-0" />
                  )}
                  {job.status === 'failed' && (
                    <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                  )}
                  <span className="font-medium text-white truncate">{job.clipTitle}</span>
                  <span className="text-zinc-500 font-mono tabular-nums">
                    {job.options.resolution} · {job.options.codec.toUpperCase()} · {job.options.fps}fps
                  </span>
                </div>

                <div className="flex items-center gap-4 text-zinc-400 font-mono tabular-nums">
                  {job.fileSize ? <span>{formatBytes(job.fileSize)}</span> : null}
                  <span>{job.progress}%</span>
                  <span>{formatRelativeDate(job.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
