import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Menu,
  UploadCloud,
  AlertCircle,
  X,
  Pause,
  Play,
  CheckCircle2,
  Loader2,
  ArrowUpRight,
} from 'lucide-react';
import type {
  AnalysisConfig,
  AppSettings,
  CaptionStyleConfig,
  ClipRecord,
  ColorGradingConfig,
  ExportJob,
  ExportOptions,
  MotionGraphicsConfig,
  MusicTrack,
  NavPage,
  ProjectRecord,
  SystemCapabilities,
} from '../shared/types.ts';
import { DEFAULT_APP_SETTINGS } from '../shared/presets.ts';
import { api } from './lib/api.ts';
import { formatBytes } from './lib/format.ts';
import { uploadManager, useUploadManager } from './lib/uploadManager.ts';
import { Sidebar } from './components/Sidebar.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { UploadPage } from './pages/UploadPage.tsx';
import { AnalysisPage } from './pages/AnalysisPage.tsx';
import { ClipsPage } from './pages/ClipsPage.tsx';
import { EditorPage } from './pages/EditorPage.tsx';
import { CaptionStudioPage } from './pages/CaptionStudioPage.tsx';
import { MotionStudioPage } from './pages/MotionStudioPage.tsx';
import { ExportCenterPage } from './pages/ExportCenterPage.tsx';
import { HistoryPage } from './pages/HistoryPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

const PAGE_LABELS: Record<NavPage, string> = {
  dashboard: 'Dashboard',
  upload: 'Upload Video',
  analysis: 'AI Analysis',
  clips: 'Generated Clips',
  editor: 'Video Editor',
  captions: 'Caption Studio',
  motion: 'Motion & Style',
  export: 'Export Center',
  history: 'Project History',
  settings: 'Settings',
};

const VALID_PAGES: NavPage[] = [
  'dashboard',
  'upload',
  'analysis',
  'clips',
  'editor',
  'captions',
  'motion',
  'export',
  'history',
  'settings',
];

const STORAGE_KEY = 'clipgenius_workspace_state_v1';

function readInitialWorkspaceState(): {
  page: NavPage;
  projectId: string | null;
  clipId: string | null;
} {
  try {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const hashPage = params.get('page') as NavPage | null;
    const hashProject = params.get('project');
    const hashClip = params.get('clip');

    const raw = window.localStorage.getItem(STORAGE_KEY);
    const saved = raw ? (JSON.parse(raw) as { page?: NavPage; projectId?: string | null; clipId?: string | null }) : {};

    const page =
      hashPage && VALID_PAGES.includes(hashPage)
        ? hashPage
        : saved.page && VALID_PAGES.includes(saved.page)
          ? saved.page
          : 'dashboard';

    return {
      page,
      projectId: hashProject || saved.projectId || null,
      clipId: hashClip || saved.clipId || null,
    };
  } catch {
    return { page: 'dashboard', projectId: null, clipId: null };
  }
}

export default function App() {
  const initial = useMemo(() => readInitialWorkspaceState(), []);
  const [activePage, setActivePage] = useState<NavPage>(initial.page);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(initial.projectId);
  const [activeClipId, setActiveClipId] = useState<string | null>(initial.clipId);
  const [exportJobs, setExportJobs] = useState<ExportJob[]>([]);
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [storage, setStorage] = useState<{
    totalBytes: number;
    projectCount: number;
    clipCount: number;
  } | null>(null);
  const [toastError, setToastError] = useState<string | null>(null);
  const uploadState = useUploadManager();
  const activePageRef = useRef<NavPage>(activePage);
  activePageRef.current = activePage;

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null,
    [projects, activeProjectId]
  );

  const refreshAll = useCallback(async () => {
    try {
      const [projList, jobs, tracks, prefs, sys] = await Promise.all([
        api.getProjects(),
        api.getExports(),
        api.getMusicTracks(),
        api.getSettings(),
        api.getCapabilities(),
      ]);
      setProjects(projList);
      setExportJobs(jobs);
      setMusicTracks(tracks);
      setSettings(prefs);
      setCapabilities(sys.capabilities);
      setStorage(sys.storage);
      setActiveProjectId((curr) =>
        curr && projList.some((p) => p.id === curr) ? curr : projList[0]?.id ?? null
      );
    } catch (err) {
      setToastError(err instanceof Error ? err.message : 'Failed to connect to ClipGenius server.');
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // Persist active workspace view across browser reloads and back/forward navigation
  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          page: activePage,
          projectId: activeProjectId,
          clipId: activeClipId,
        })
      );
      const params = new URLSearchParams();
      params.set('page', activePage);
      if (activeProjectId) params.set('project', activeProjectId);
      if (activeClipId) params.set('clip', activeClipId);
      const nextHash = `#${params.toString()}`;
      if (window.location.hash !== nextHash) {
        window.history.replaceState(null, '', nextHash);
      }
    } catch {
      // ignore storage quota / private mode errors
    }
  }, [activePage, activeProjectId, activeClipId]);

  useEffect(() => {
    const onHashChange = () => {
      const next = readInitialWorkspaceState();
      setActivePage(next.page);
      if (next.projectId) setActiveProjectId(next.projectId);
      if (next.clipId) setActiveClipId(next.clipId);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Real background polling whenever an AI analysis pipeline or FFmpeg export render is active
  const hasActiveWork = useMemo(() => {
    const analyzing = projects.some((p) => p.status === 'analyzing');
    const rendering = exportJobs.some((j) => j.status === 'queued' || j.status === 'rendering');
    return analyzing || rendering;
  }, [projects, exportJobs]);

  useEffect(() => {
    if (!hasActiveWork) return;
    const timer = setInterval(async () => {
      try {
        const [projList, jobs] = await Promise.all([api.getProjects(), api.getExports()]);
        setProjects(projList);
        setExportJobs(jobs);
      } catch {
        // retry on next interval
      }
    }, 1800);
    return () => clearInterval(timer);
  }, [hasActiveWork]);

  const handleProjectCreated = useCallback((project: ProjectRecord) => {
    setProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)]);
    setActiveProjectId((curr) =>
      !curr || activePageRef.current === 'upload' ? project.id : curr
    );
  }, []);

  useEffect(() => {
    uploadManager.setOnProjectCompleted(handleProjectCreated);
    return () => uploadManager.setOnProjectCompleted(null);
  }, [handleProjectCreated]);

  const activeUploadInfo = uploadState.info;
  const isBgUploadInProgress =
    activeUploadInfo?.state === 'uploading' ||
    activeUploadInfo?.state === 'paused' ||
    activeUploadInfo?.state === 'assembling' ||
    activeUploadInfo?.state === 'error';

  const sidebarUploadProgressText = useMemo(() => {
    if (!activeUploadInfo) return null;
    if (activeUploadInfo.state === 'uploading') return `${activeUploadInfo.percentage}%`;
    if (activeUploadInfo.state === 'assembling') return 'Finalizing';
    if (activeUploadInfo.state === 'paused') return `Paused`;
    if (activeUploadInfo.state === 'error') return 'Retry';
    return null;
  }, [activeUploadInfo]);

  const showBackgroundUploadDock =
    activePage !== 'upload' &&
    (isBgUploadInProgress || (Boolean(uploadState.completedProject) && !uploadState.bannerDismissed));

  const handleStartAnalysis = async (projectId: string, config?: AnalysisConfig, highlightsOnly = false) => {
    try {
      setToastError(null);
      const res = await api.startAnalysis(projectId, config, highlightsOnly);
      if (res.project) {
        setProjects((prev) => prev.map((p) => (p.id === projectId ? res.project : p)));
      }
      setActiveProjectId(projectId);
      setActivePage('analysis');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start AI analysis.';
      setToastError(msg);
      throw err;
    }
  };

  const handleOpenProject = (projectId: string, destination: NavPage) => {
    setActiveProjectId(projectId);
    const proj = projects.find((p) => p.id === projectId);
    setActiveClipId(proj?.clips[0]?.id ?? null);
    setActivePage(destination);
  };

  const handleEditClip = (clipId: string) => {
    setActiveClipId(clipId);
    setActivePage('editor');
  };

  const handleSaveClip = async (projectId: string, clip: ClipRecord): Promise<ClipRecord> => {
    const updated = await api.updateClip(projectId, clip.id, clip);
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? { ...p, clips: p.clips.map((c) => (c.id === updated.id ? updated : c)) }
          : p
      )
    );
    return updated;
  };

  const handleUpdateClipTitle = async (projectId: string, clipId: string, title: string) => {
    const updated = await api.updateClip(projectId, clipId, { title });
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId
          ? { ...p, clips: p.clips.map((c) => (c.id === updated.id ? updated : c)) }
          : p
      )
    );
  };

  const handleApplyCaptionsToAll = async (
    projectId: string,
    clipId: string,
    style: CaptionStyleConfig
  ) => {
    const res = await api.applyCaptionsToAll(projectId, clipId, style);
    setProjects((prev) => prev.map((p) => (p.id === projectId ? res.project : p)));
  };

  const handleApplyStyleToAll = async (
    projectId: string,
    clipId: string,
    payload: { colorGrading: ColorGradingConfig; motionGraphics: MotionGraphicsConfig }
  ) => {
    const res = await api.applyStyleToAll(projectId, clipId, payload);
    setProjects((prev) => prev.map((p) => (p.id === projectId ? res.project : p)));
  };

  const handleRegenerateClip = async (projectId: string, clipId: string) => {
    try {
      const updated = await api.regenerateClip(projectId, clipId);
      setProjects((prev) =>
        prev.map((p) =>
          p.id === projectId
            ? { ...p, clips: p.clips.map((c) => (c.id === updated.id ? updated : c)) }
            : p
        )
      );
    } catch (err) {
      setToastError(err instanceof Error ? err.message : 'Failed to regenerate clip.');
    }
  };

  const handleDeleteClip = async (projectId: string, clipId: string) => {
    await api.deleteClip(projectId, clipId);
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, clips: p.clips.filter((c) => c.id !== clipId) } : p
      )
    );
  };

  const handleDeleteProject = async (projectId: string) => {
    await api.deleteProject(projectId);
    uploadManager.clearCompletedProjectIfId(projectId);
    setProjects((prev) => {
      const remaining = prev.filter((p) => p.id !== projectId);
      if (activeProjectId === projectId) {
        setActiveProjectId(remaining[0]?.id ?? null);
      }
      return remaining;
    });
    const sys = await api.getCapabilities();
    setStorage(sys.storage);
  };

  const handleExportSingle = async (
    projectId: string,
    clipId: string,
    options?: Partial<ExportOptions>
  ) => {
    const job = await api.exportClip(projectId, clipId, options ?? {});
    setExportJobs((prev) => [job, ...prev]);
  };

  const handleExportBatch = async (
    projectId: string,
    clipIds: string[],
    options: ExportOptions
  ) => {
    const res = await api.exportBatch(projectId, clipIds, options);
    setExportJobs((prev) => [...res.jobs, ...prev]);
  };

  const handleSaveSettings = async (patch: Partial<AppSettings>) => {
    const updated = await api.updateSettings(patch);
    setSettings(updated);
  };

  return (
    <div className="min-h-screen flex bg-transparent text-[#F4F5F8]">
      <Sidebar
        activePage={activePage}
        onNavigate={setActivePage}
        projects={projects}
        activeProjectId={activeProject?.id ?? null}
        onSelectProject={(id) => {
          setActiveProjectId(id);
          const proj = projects.find((p) => p.id === id);
          setActiveClipId(proj?.clips[0]?.id ?? null);
        }}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        uploadProgressText={sidebarUploadProgressText}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean Contextual Top Bar */}
        <header className="sticky top-0 z-30 h-16 px-4 sm:px-8 bg-[#060C09]/85 backdrop-blur-xl border-b border-[#D4AF37]/14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden p-2 -ml-2 text-[#94A89C] hover:text-white rounded-md"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="font-display font-semibold text-white whitespace-nowrap">
                {PAGE_LABELS[activePage]}
              </span>
              {activeProject && activePage !== 'dashboard' && activePage !== 'upload' && activePage !== 'settings' && (
                <>
                  <span className="text-[#D4AF37]/50">/</span>
                  <span className="text-[#94A89C] truncate max-w-[260px]">
                    {activeProject.name}
                  </span>
                </>
              )}
            </div>
          </div>

          <button
            onClick={() => setActivePage('upload')}
            className={`inline-flex items-center gap-2 h-9 px-3.5 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
              isBgUploadInProgress
                ? 'bg-[#059669]/20 hover:bg-[#059669]/30 border-[#D4AF37]/45 text-[#FEFCE8]'
                : 'bg-[#0E1913] hover:bg-[#14251C] border-[#D4AF37]/25 text-[#FEFCE8]'
            }`}
          >
            {activeUploadInfo?.state === 'uploading' || activeUploadInfo?.state === 'assembling' ? (
              <Loader2 className="w-3.5 h-3.5 text-[#F5C451] animate-spin" />
            ) : (
              <UploadCloud className="w-3.5 h-3.5 text-[#F5C451]" />
            )}
            <span className="tabular-nums">
              {activeUploadInfo?.state === 'uploading'
                ? `Uploading ${activeUploadInfo.percentage}%`
                : activeUploadInfo?.state === 'assembling'
                  ? 'Finalizing Upload...'
                  : activeUploadInfo?.state === 'paused'
                    ? `Upload Paused (${activeUploadInfo.percentage}%)`
                    : activeUploadInfo?.state === 'error'
                      ? 'Upload Needs Retry'
                      : 'Upload Video'}
            </span>
          </button>
        </header>

        {/* Persistent Background Upload Dock — stays live while exploring any other page */}
        {showBackgroundUploadDock && (
          <div className="mx-4 sm:mx-8 mt-4 rounded-xl studio-panel border border-[#D4AF37]/30 px-4 py-3 shadow-[0_12px_32px_-12px_rgba(0,0,0,0.7)]">
            {isBgUploadInProgress && activeUploadInfo ? (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    {activeUploadInfo.state === 'error' ? (
                      <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
                    ) : activeUploadInfo.state === 'paused' ? (
                      <Pause className="w-4 h-4 text-[#F5C451] shrink-0" />
                    ) : (
                      <Loader2 className="w-4 h-4 text-[#10B981] animate-spin shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs font-semibold text-white">
                        <span className="truncate max-w-[260px] sm:max-w-[420px]">
                          {uploadState.fileName || activeUploadInfo.fileName}
                        </span>
                        <span className="font-mono text-[#F5C451] tabular-nums shrink-0">
                          {activeUploadInfo.percentage}%
                        </span>
                      </div>
                      <div className="text-[11px] text-[#94A89C] tabular-nums truncate">
                        {activeUploadInfo.retryNotice
                          ? activeUploadInfo.retryNotice
                          : activeUploadInfo.state === 'assembling'
                            ? 'Assembling chunks & probing video streams with FFprobe...'
                            : activeUploadInfo.state === 'paused'
                              ? `Paused at ${formatBytes(activeUploadInfo.uploadedBytes)} / ${formatBytes(activeUploadInfo.totalBytes)}`
                              : activeUploadInfo.state === 'error'
                                ? `Interrupted: ${activeUploadInfo.error || 'Connection lost'} — click Resume to continue`
                                : `Uploading in background · ${formatBytes(activeUploadInfo.uploadedBytes)} / ${formatBytes(activeUploadInfo.totalBytes)} · ${formatBytes(activeUploadInfo.speedBytesPerSec)}/s`}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {activeUploadInfo.state !== 'assembling' && (
                      <button
                        onClick={() => {
                          if (activeUploadInfo.state === 'uploading') {
                            uploadManager.pauseUpload();
                          } else {
                            void uploadManager.resumeUpload();
                          }
                        }}
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-[#0E1913] hover:bg-[#14251C] border border-[#D4AF37]/25 text-xs font-medium text-white"
                      >
                        {activeUploadInfo.state === 'uploading' ? (
                          <>
                            <Pause className="w-3.5 h-3.5 text-[#F5C451]" /> Pause
                          </>
                        ) : (
                          <>
                            <Play className="w-3.5 h-3.5 text-[#10B981]" /> Resume
                          </>
                        )}
                      </button>
                    )}
                    <button
                      onClick={() => setActivePage('upload')}
                      className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-[#059669]/20 hover:bg-[#059669]/30 border border-[#10B981]/30 text-xs font-medium text-[#FEFCE8]"
                    >
                      Open
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => void uploadManager.cancelUpload()}
                      aria-label="Cancel background upload"
                      className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-red-500/12 hover:bg-red-500/25 text-red-300"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="h-1.5 rounded-full bg-[#132219] overflow-hidden">
                  <div
                    style={{ width: `${activeUploadInfo.percentage}%` }}
                    className={`h-full transition-[width] duration-150 ${
                      activeUploadInfo.state === 'error'
                        ? 'bg-red-500'
                        : 'bg-gradient-to-r from-[#059669] via-[#10B981] to-[#D4AF37]'
                    }`}
                  />
                </div>
              </div>
            ) : uploadState.completedProject ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <CheckCircle2 className="w-4 h-4 text-[#10B981] shrink-0" />
                  <div className="min-w-0 text-xs">
                    <span className="font-semibold text-white">Upload complete: </span>
                    <span className="text-[#E6EFE9] truncate">
                      {uploadState.completedProject.originalFilename}
                    </span>
                    <span className="text-[#94A89C]"> — ready for AI clipping analysis.</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => {
                      if (uploadState.completedProject) {
                        setActiveProjectId(uploadState.completedProject.id);
                      }
                      setActivePage('upload');
                    }}
                    className="studio-btn-primary inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold text-white"
                  >
                    Open & Analyze
                    <ArrowUpRight className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => uploadManager.dismissBanner()}
                    aria-label="Dismiss upload complete notice"
                    className="inline-flex items-center justify-center h-8 w-8 rounded-lg bg-[#0E1913] hover:bg-[#14251C] text-[#94A89C] hover:text-white"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        )}

        {/* Global Error Banner if needed */}
        {toastError && (
          <div className="mx-4 sm:mx-8 mt-4 flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-red-500/12 border border-red-500/30 text-xs text-red-200">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{toastError}</span>
            </div>
            <button
              onClick={() => setToastError(null)}
              aria-label="Dismiss error"
              className="p-1 text-red-300 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Active Page Viewport */}
        <main className="flex-1 p-4 sm:p-8 max-w-[1440px] w-full mx-auto">
          {activePage === 'dashboard' && (
            <DashboardPage
              projects={projects}
              capabilities={capabilities}
              onNavigate={setActivePage}
              onOpenProject={handleOpenProject}
            />
          )}

          {activePage === 'upload' && (
            <UploadPage
              settings={settings}
              onStartAnalysis={(projectId, cfg) => handleStartAnalysis(projectId, cfg, false)}
            />
          )}

          {activePage === 'analysis' && (
            <AnalysisPage
              project={activeProject}
              onResumeOrStart={(projectId, highlightsOnly) =>
                handleStartAnalysis(projectId, undefined, Boolean(highlightsOnly))
              }
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'clips' && (
            <ClipsPage
              project={activeProject}
              exportJobs={exportJobs}
              onEditClip={handleEditClip}
              onUpdateClipTitle={handleUpdateClipTitle}
              onRegenerateClip={handleRegenerateClip}
              onDeleteClip={handleDeleteClip}
              onRenderClipDirect={handleExportSingle}
              onRenderAllClips={handleExportBatch}
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'editor' && (
            <EditorPage
              project={activeProject}
              clipId={activeClipId}
              musicTracks={musicTracks}
              onSelectClip={setActiveClipId}
              onSaveClip={handleSaveClip}
              onExportClip={(projectId, clipId) => handleExportSingle(projectId, clipId)}
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'captions' && (
            <CaptionStudioPage
              project={activeProject}
              clipId={activeClipId}
              onSelectClip={setActiveClipId}
              onSaveClip={handleSaveClip}
              onApplyToAll={handleApplyCaptionsToAll}
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'motion' && (
            <MotionStudioPage
              project={activeProject}
              clipId={activeClipId}
              onSelectClip={setActiveClipId}
              onSaveClip={handleSaveClip}
              onApplyStyleToAll={handleApplyStyleToAll}
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'export' && (
            <ExportCenterPage
              project={activeProject}
              exportJobs={exportJobs}
              settings={settings}
              capabilities={capabilities}
              onExportBatch={handleExportBatch}
              onExportSingle={handleExportSingle}
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'history' && (
            <HistoryPage
              projects={projects}
              onOpenProject={handleOpenProject}
              onDeleteProject={handleDeleteProject}
              onNavigate={setActivePage}
            />
          )}

          {activePage === 'settings' && (
            <SettingsPage
              settings={settings}
              capabilities={capabilities}
              storage={storage}
              onSaveSettings={handleSaveSettings}
            />
          )}
        </main>
      </div>
    </div>
  );
}
