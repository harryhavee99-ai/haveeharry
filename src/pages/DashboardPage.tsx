import React from 'react';
import {
  UploadCloud,
  Film,
  ArrowRight,
  Clock,
  AlertCircle,
  CheckCircle2,
  Loader2,
  FolderOpen,
  Download,
} from 'lucide-react';
import type { NavPage, ProjectRecord, SystemCapabilities } from '../../shared/types.ts';
import { formatBytes, formatDurationHuman, formatRelativeDate } from '../lib/format.ts';

interface DashboardPageProps {
  projects: ProjectRecord[];
  capabilities: SystemCapabilities | null;
  onNavigate: (page: NavPage) => void;
  onOpenProject: (projectId: string, destination: NavPage) => void;
}

export function DashboardPage({
  projects,
  capabilities,
  onNavigate,
  onOpenProject,
}: DashboardPageProps) {
  const totalVideos = projects.length;
  const totalClips = projects.reduce((sum, p) => sum + p.clips.length, 0);
  const processingProjects = projects.filter(
    (p) => p.status === 'analyzing' || p.status === 'uploading'
  ).length;
  const completedProjects = projects.filter((p) => p.status === 'ready').length;

  const recentProjects = projects.slice(0, 8);

  return (
    <div className="space-y-8">
      {/* Configuration Notice if GEMINI_API_KEY is missing */}
      {capabilities && !capabilities.geminiConfigured && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200">
          <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold text-amber-100">Gemini API Key Not Detected</p>
            <p className="text-amber-200/80 mt-0.5">
              Video uploads and FFmpeg rendering work locally, while AI transcription and highlight selection require a configured <code className="font-mono text-xs">GEMINI_API_KEY</code> in Settings &gt; Secrets.
            </p>
          </div>
        </div>
      )}

      {/* Architectural Studio Hero Spotlight */}
      <section className="relative overflow-hidden rounded-2xl studio-panel p-6 sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 right-0 h-72 w-96 rounded-full bg-[#059669]/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 left-1/3 h-64 w-80 rounded-full bg-[#D4AF37]/14 blur-3xl"
        />

        <div className="relative flex flex-col lg:flex-row lg:items-end justify-between gap-6">
          <div className="max-w-2xl">
            <div className="text-xs font-medium text-[#F5C451]">
              AI Short-Form Production Studio · MP4, MKV &amp; MOV Ready
            </div>
            <h1 className="mt-2 font-display text-2xl sm:text-4xl font-bold tracking-tight text-white leading-[1.15] [text-wrap:balance]">
              Turn long-form recordings into master-quality vertical clips
            </h1>
            <p className="mt-3 text-sm sm:text-base text-zinc-400 leading-relaxed">
              Upload videos of any duration or file size in MP4, MKV, MOV, WebM, and more. AI extracts verbatim captions and standalone highlights, smart reframing keeps speakers centered, and FFmpeg exports crisp 1080p &amp; 4K clips ready to download.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 shrink-0">
            <button
              onClick={() => onNavigate('upload')}
              className="studio-btn-primary inline-flex items-center justify-center gap-2 h-11 px-6 rounded-xl text-sm font-semibold text-white whitespace-nowrap"
            >
              <UploadCloud className="w-4 h-4 text-[#FEF3C7]" />
              Upload Video
            </button>
            {projects.length > 0 && (
              <button
                onClick={() => onNavigate('clips')}
                className="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/25 text-sm font-medium text-zinc-100 transition-colors whitespace-nowrap"
              >
                <Film className="w-4 h-4 text-[#F5C451]" />
                Browse Clips
              </button>
            )}
          </div>
        </div>

        {/* Clean 4-Step Editorial Pipeline Strip */}
        <div className="relative mt-7 pt-6 border-t border-[#D4AF37]/15 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 text-xs">
          <div>
            <div className="font-mono text-[#F5C451] font-semibold">01. Upload</div>
            <div className="mt-1 text-zinc-100 font-medium">MP4, MKV, MOV &amp; WebM</div>
            <div className="mt-0.5 text-zinc-500">Any length &amp; file size · 2 MB background chunks</div>
          </div>
          <div>
            <div className="font-mono text-[#34D399] font-semibold">02. Intelligence</div>
            <div className="mt-1 text-zinc-100 font-medium">Speech &amp; Highlight AI</div>
            <div className="mt-0.5 text-zinc-500">Verbatim captions + semantic scoring</div>
          </div>
          <div>
            <div className="font-mono text-[#F5C451] font-semibold">03. Studio Craft</div>
            <div className="mt-1 text-zinc-100 font-medium">12 Caption Styles &amp; Reframe</div>
            <div className="mt-0.5 text-zinc-500">Face tracking, motion graphics &amp; grading</div>
          </div>
          <div>
            <div className="font-mono text-[#34D399] font-semibold">04. Master Export</div>
            <div className="mt-1 text-zinc-100 font-medium">Excellent Quality Downloads</div>
            <div className="mt-0.5 text-zinc-500">CRF 18 HD/4K MP4 + batch ZIP bundle</div>
          </div>
        </div>
      </section>

      {/* 4-Column KPI Metric Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-xl studio-panel">
          <div className="text-xs font-medium text-zinc-400">Total Videos Uploaded</div>
          <div className="mt-2 font-mono text-3xl font-bold text-white tabular-nums">
            {totalVideos}
          </div>
          <div className="mt-1 text-xs text-zinc-500">Supports up to 5h per file</div>
        </div>

        <div className="p-5 rounded-xl studio-panel">
          <div className="text-xs font-medium text-zinc-400">Total Clips Generated</div>
          <div className="mt-2 font-mono text-3xl font-bold text-white tabular-nums">
            {totalClips}
          </div>
          <div className="mt-1 text-xs text-zinc-500">AI-selected standalone moments</div>
        </div>

        <div className="p-5 rounded-xl studio-panel">
          <div className="text-xs font-medium text-zinc-400">Processing Projects</div>
          <div className="mt-2 font-mono text-3xl font-bold text-[#F5C451] tabular-nums">
            {processingProjects}
          </div>
          <div className="mt-1 text-xs text-zinc-500">Resumable background pipeline</div>
        </div>

        <div className="p-5 rounded-xl studio-panel">
          <div className="text-xs font-medium text-zinc-400">Completed Projects</div>
          <div className="mt-2 font-mono text-3xl font-bold text-emerald-400 tabular-nums">
            {completedProjects}
          </div>
          <div className="mt-1 text-xs text-zinc-500">Ready for HD download</div>
        </div>
      </div>

      {/* Recent Projects List */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-lg font-semibold text-white">Recent Projects</h2>
          {projects.length > 0 && (
            <button
              onClick={() => onNavigate('history')}
              className="text-xs font-medium text-[#F5C451] hover:text-[#FEF3C7] transition-colors whitespace-nowrap"
            >
              View all projects
            </button>
          )}
        </div>

        {recentProjects.length === 0 ? (
          <div className="p-12 rounded-2xl studio-panel text-center">
            <div className="mx-auto w-12 h-12 rounded-xl bg-[#0E1913] border border-[#D4AF37]/25 flex items-center justify-center text-[#F5C451] mb-4">
              <FolderOpen className="w-6 h-6" />
            </div>
            <h3 className="font-display text-base font-semibold text-white">
              No video projects yet
            </h3>
            <p className="mt-1.5 text-sm text-zinc-400 max-w-md mx-auto">
              Upload your first MP4, MKV, or MOV recording—or generate a spoken test video—to run the full AI clipping and HD export workflow.
            </p>
            <button
              onClick={() => onNavigate('upload')}
              className="mt-5 studio-btn-primary inline-flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-medium text-white"
            >
              <UploadCloud className="w-4 h-4" />
              Go to Upload Studio
            </button>
          </div>
        ) : (
          <div className="rounded-xl studio-panel divide-y divide-[#D4AF37]/10 overflow-hidden">
            {recentProjects.map((project) => {
              const targetPage: NavPage =
                project.status === 'ready'
                  ? 'clips'
                  : project.status === 'analyzing' || project.status === 'failed'
                    ? 'analysis'
                    : 'upload';
              const renderedCount = project.clips.filter((c) => c.renderedVideoUrl).length;

              return (
                <div
                  key={project.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 hover:bg-white/[0.025] transition-colors"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-24 h-14 rounded-lg bg-[#050A07] border border-[#D4AF37]/15 overflow-hidden shrink-0 flex items-center justify-center">
                      {project.thumbnailUrl ? (
                        <img
                          src={project.thumbnailUrl}
                          alt={project.name}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Film className="w-5 h-5 text-zinc-600" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium text-sm text-white truncate">{project.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400 tabular-nums">
                        {project.originalContainer && (
                          <>
                            <span className="font-mono text-[#F5C451]">{project.originalContainer}</span>
                            <span aria-hidden="true">·</span>
                          </>
                        )}
                        <span>{project.metadata ? formatDurationHuman(project.metadata.duration) : 'Pending probe'}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatBytes(project.fileSize)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{project.clips.length} clips</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatRelativeDate(project.createdAt)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between sm:justify-end gap-3 shrink-0">
                    <div className="flex items-center gap-1.5 text-xs font-medium mr-1">
                      {project.status === 'ready' && (
                        <>
                          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          <span className="text-emerald-300">Ready</span>
                        </>
                      )}
                      {project.status === 'analyzing' && (
                        <>
                          <Loader2 className="w-4 h-4 text-[#F5C451] animate-spin" />
                          <span className="text-[#F5C451]">Analyzing</span>
                        </>
                      )}
                      {project.status === 'uploaded' && (
                        <>
                          <Clock className="w-4 h-4 text-zinc-400" />
                          <span className="text-zinc-300">Uploaded</span>
                        </>
                      )}
                      {project.status === 'failed' && (
                        <>
                          <AlertCircle className="w-4 h-4 text-red-400" />
                          <span className="text-red-300">Needs Resume</span>
                        </>
                      )}
                    </div>

                    {renderedCount > 0 && (
                      <a
                        href={`/api/projects/${project.id}/download-zip`}
                        download
                        className="studio-btn-gold inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-xs font-semibold whitespace-nowrap"
                      >
                        <Download className="w-3.5 h-3.5" />
                        ZIP ({renderedCount})
                      </a>
                    )}

                    <button
                      onClick={() => onOpenProject(project.id, targetPage)}
                      className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-white transition-colors whitespace-nowrap"
                    >
                      {project.status === 'ready' ? 'Open Clips' : 'View Pipeline'}
                      <ArrowRight className="w-3.5 h-3.5 text-[#F5C451]" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
