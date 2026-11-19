import React, { useMemo, useState } from 'react';
import {
  Search,
  Trash2,
  Film,
  ArrowRight,
  UploadCloud,
  CheckCircle2,
  Loader2,
  AlertCircle,
  Clock,
} from 'lucide-react';
import type { NavPage, ProjectRecord } from '../../shared/types.ts';
import { formatBytes, formatDurationHuman, formatRelativeDate } from '../lib/format.ts';

interface HistoryPageProps {
  projects: ProjectRecord[];
  onOpenProject: (projectId: string, destination: NavPage) => void;
  onDeleteProject: (projectId: string) => Promise<void>;
  onNavigate: (page: NavPage) => void;
}

export function HistoryPage({
  projects,
  onOpenProject,
  onDeleteProject,
  onNavigate,
}: HistoryPageProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ProjectRecord['status']>('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.originalFilename.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [projects, query, statusFilter]);

  const handleConfirmDelete = async (id: string) => {
    setDeletingId(id);
    try {
      await onDeleteProject(id);
      setConfirmDeleteId(null);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Project History</h1>
          <p className="mt-1 text-xs text-zinc-400">
            Manage saved long-form video projects, resume interrupted jobs, or remove old media to reclaim disk space.
          </p>
        </div>

        <button
          onClick={() => onNavigate('upload')}
          className="studio-btn-primary inline-flex items-center gap-2 h-10 px-4 rounded-lg text-xs font-semibold text-white whitespace-nowrap shrink-0"
        >
          <UploadCloud className="w-4 h-4 text-[#FEF3C7]" />
          Upload Video
        </button>
      </div>

      {/* Filter & Search Bar */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects by title or filename..."
            className="w-full h-9 pl-9 pr-3 rounded-lg bg-[#0C1510] border border-[#D4AF37]/18 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-[#D4AF37]"
          />
        </div>

        <div className="flex items-center gap-1 p-1 rounded-lg bg-[#0B130F] border border-[#D4AF37]/15">
          {(
            [
              ['all', 'All'],
              ['ready', 'Ready'],
              ['analyzing', 'Processing'],
              ['uploaded', 'Uploaded'],
              ['failed', 'Failed'],
            ] as const
          ).map(([st, label]) => (
            <button
              key={st}
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                statusFilter === st
                  ? 'bg-[#059669] text-white border border-[#D4AF37]/35'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="p-12 rounded-2xl studio-panel text-center">
          <Film className="w-8 h-8 text-zinc-600 mx-auto mb-3" />
          <div className="font-display text-base font-semibold text-white">No matching projects</div>
          <p className="mt-1 text-xs text-zinc-400">
            Adjust your filter or upload a new long-form video to get started.
          </p>
        </div>
      ) : (
        <div className="rounded-xl studio-panel overflow-hidden divide-y divide-[#D4AF37]/10">
          {filtered.map((project) => (
            <div
              key={project.id}
              className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 p-4 hover:bg-[#059669]/8"
            >
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-24 h-14 rounded-lg bg-black overflow-hidden shrink-0 border border-[#D4AF37]/15 flex items-center justify-center">
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
                  <div className="text-sm font-semibold text-white truncate">{project.name}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-400 font-mono tabular-nums">
                    <span>{project.metadata ? formatDurationHuman(project.metadata.duration) : '—'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatBytes(project.fileSize)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{project.clips.length} clips</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatRelativeDate(project.createdAt)}</span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium mr-2">
                  {project.status === 'ready' && (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span className="text-emerald-300">Ready</span>
                    </>
                  )}
                  {project.status === 'analyzing' && (
                    <>
                      <Loader2 className="w-3.5 h-3.5 text-[#F5C451] animate-spin" />
                      <span className="text-[#F5C451]">Analyzing</span>
                    </>
                  )}
                  {project.status === 'uploaded' && (
                    <>
                      <Clock className="w-3.5 h-3.5 text-zinc-400" />
                      <span className="text-zinc-300">Uploaded</span>
                    </>
                  )}
                  {project.status === 'failed' && (
                    <>
                      <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                      <span className="text-red-300">Failed</span>
                    </>
                  )}
                </span>

                <button
                  onClick={() =>
                    onOpenProject(project.id, project.status === 'ready' ? 'clips' : 'analysis')
                  }
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-[#0E1913] hover:bg-[#14241B] border border-[#D4AF37]/20 text-xs font-medium text-white whitespace-nowrap"
                >
                  Open
                  <ArrowRight className="w-3.5 h-3.5 text-[#F5C451]" />
                </button>

                {confirmDeleteId === project.id ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => void handleConfirmDelete(project.id)}
                      disabled={deletingId === project.id}
                      className="h-8 px-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-xs font-semibold text-white whitespace-nowrap"
                    >
                      {deletingId === project.id ? 'Deleting...' : 'Confirm Delete'}
                    </button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="h-8 px-2.5 rounded-lg bg-[#0E1913] border border-[#D4AF37]/15 text-xs text-zinc-300"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(project.id)}
                    aria-label="Delete project"
                    className="h-8 w-8 flex items-center justify-center rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
