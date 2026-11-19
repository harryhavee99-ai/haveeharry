import React from 'react';
import {
  LayoutDashboard,
  UploadCloud,
  Cpu,
  Film,
  SlidersHorizontal,
  Captions,
  Wand2,
  Download,
  History,
  Settings,
  X,
  Scissors,
} from 'lucide-react';
import type { NavPage, ProjectRecord } from '../../shared/types.ts';

interface SidebarProps {
  activePage: NavPage;
  onNavigate: (page: NavPage) => void;
  projects: ProjectRecord[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  uploadProgressText?: string | null;
}

const NAV_GROUPS: Array<{
  title: string;
  items: Array<{ id: NavPage; label: string; icon: React.ComponentType<{ className?: string }> }>;
}> = [
  {
    title: 'Workflow',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { id: 'upload', label: 'Upload Video', icon: UploadCloud },
      { id: 'analysis', label: 'AI Analysis', icon: Cpu },
      { id: 'clips', label: 'Generated Clips', icon: Film },
    ],
  },
  {
    title: 'Creative Studios',
    items: [
      { id: 'editor', label: 'Video Editor', icon: SlidersHorizontal },
      { id: 'captions', label: 'Caption Studio', icon: Captions },
      { id: 'motion', label: 'Motion & Style', icon: Wand2 },
    ],
  },
  {
    title: 'Delivery',
    items: [
      { id: 'export', label: 'Export Center', icon: Download },
      { id: 'history', label: 'Project History', icon: History },
      { id: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

export function Sidebar({
  activePage,
  onNavigate,
  projects,
  activeProjectId,
  onSelectProject,
  mobileOpen,
  onCloseMobile,
  uploadProgressText,
}: SidebarProps) {
  const navContent = (
    <div className="flex h-full flex-col bg-[#070D0A]/95 backdrop-blur-xl border-r border-[#D4AF37]/15">
      {/* Brand Header */}
      <div className="flex items-center justify-between h-16 px-5 border-b border-[#D4AF37]/12">
        <button
          onClick={() => {
            onNavigate('dashboard');
            onCloseMobile();
          }}
          className="flex items-center gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[#D4AF37] rounded-md"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-[#059669] via-[#10B981] to-[#D4AF37] text-[#050A07] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_6px_16px_-4px_rgba(212,175,55,0.45)] shrink-0">
            <Scissors className="h-4 w-4" />
          </div>
          <span className="font-display text-base font-bold tracking-tight text-[#F6F8F5] whitespace-nowrap">
            ClipGenius <span className="text-[#F5C451]">AI</span>
          </span>
        </button>
        <button
          onClick={onCloseMobile}
          aria-label="Close navigation"
          className="lg:hidden p-2 text-zinc-400 hover:text-white rounded-md"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Active Project Selector */}
      {projects.length > 0 && (
        <div className="px-4 pt-4 pb-2">
          <label className="block text-[11px] font-medium text-[#94A89C] mb-1.5">
            Active Project
          </label>
          <select
            value={activeProjectId ?? ''}
            onChange={(e) => onSelectProject(e.target.value)}
            className="w-full h-9 px-2.5 rounded-lg bg-[#0E1913] border border-[#D4AF37]/20 text-xs text-emerald-50 focus:outline-none focus:border-[#D4AF37] truncate"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id} className="bg-[#0E1913] text-emerald-50">
                {p.name} ({p.clips.length} clips)
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Navigation Links */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.title}>
            <div className="px-2.5 mb-1.5 text-[11px] font-medium text-[#7A9484]">
              {group.title}
            </div>
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = activePage === item.id;
                const showUploadPct = item.id === 'upload' && Boolean(uploadProgressText);
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      onNavigate(item.id);
                      onCloseMobile();
                    }}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-all duration-150 whitespace-nowrap ${
                      isActive
                        ? 'bg-gradient-to-r from-[#059669]/25 to-[#D4AF37]/12 text-[#FEFCE8] shadow-[inset_0_0_0_1px_rgba(212,175,55,0.34)]'
                        : 'text-[#9BB0A3] hover:text-white hover:bg-[#10B981]/[0.08]'
                    }`}
                  >
                    <Icon
                      className={`h-4 w-4 shrink-0 ${
                        isActive || showUploadPct ? 'text-[#F5C451]' : 'text-[#668272]'
                      }`}
                    />
                    <span className="truncate flex-1 text-left">{item.label}</span>
                    {showUploadPct && (
                      <span className="font-mono text-[11px] font-semibold text-[#F5C451] tabular-nums shrink-0">
                        {uploadProgressText}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom Quick Action */}
      <div className="p-4 border-t border-[#D4AF37]/12">
        <button
          onClick={() => {
            onNavigate('upload');
            onCloseMobile();
          }}
          className="studio-btn-primary w-full h-10 px-4 rounded-lg text-sm font-semibold text-white whitespace-nowrap"
        >
          New Video Project
        </button>
      </div>
    </div>
  );

  return (
    <>
      <aside className="hidden lg:block w-[248px] shrink-0 h-screen sticky top-0">
        {navContent}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/70" onClick={onCloseMobile} />
          <div className="relative w-[264px] max-w-[82vw] h-full z-10">{navContent}</div>
        </div>
      )}
    </>
  );
}
