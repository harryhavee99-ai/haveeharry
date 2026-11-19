import fs from 'fs';
import path from 'path';
import type { AppSettings, ExportJob, ProjectRecord } from '../shared/types.ts';
import { DEFAULT_APP_SETTINGS } from '../shared/presets.ts';

export const DATA_ROOT = path.resolve(process.cwd(), 'data');
export const PROJECTS_DIR = path.join(DATA_ROOT, 'projects');
export const MUSIC_DIR = path.join(DATA_ROOT, 'music');
export const DB_PATH = path.join(DATA_ROOT, 'db.json');

interface DatabaseState {
  projects: ProjectRecord[];
  exportJobs: ExportJob[];
  settings: AppSettings;
}

function ensureDirs(): void {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.mkdirSync(MUSIC_DIR, { recursive: true });
}

class Store {
  private state: DatabaseState;

  constructor() {
    ensureDirs();
    this.state = this.load();
    // Recover any jobs that were mid-flight when the server restarted
    let changed = false;
    for (const p of this.state.projects) {
      if (p.status === 'analyzing') {
        p.status = 'failed';
        p.errorMessage = 'Server restarted during analysis. Click "Resume Analysis" to continue from the last saved checkpoint.';
        for (const s of p.pipelineStages) {
          if (s.status === 'running') {
            s.status = 'failed';
            s.detail = 'Interrupted by server restart — ready to resume.';
          }
        }
        changed = true;
      }
    }
    for (const j of this.state.exportJobs) {
      if (j.status === 'rendering' || j.status === 'queued') {
        j.status = 'failed';
        j.error = 'Interrupted by server restart. Please re-run export.';
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  private load(): DatabaseState {
    try {
      if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<DatabaseState>;
        return {
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          exportJobs: Array.isArray(parsed.exportJobs) ? parsed.exportJobs : [],
          settings: { ...DEFAULT_APP_SETTINGS, ...(parsed.settings ?? {}) },
        };
      }
    } catch (err) {
      console.error('Failed to read database file, starting fresh:', err);
    }
    return {
      projects: [],
      exportJobs: [],
      settings: { ...DEFAULT_APP_SETTINGS },
    };
  }

  public save(): void {
    ensureDirs();
    const tmpPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf-8');
    fs.renameSync(tmpPath, DB_PATH);
  }

  public getProjects(): ProjectRecord[] {
    return [...this.state.projects].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public getProject(id: string): ProjectRecord | undefined {
    return this.state.projects.find((p) => p.id === id);
  }

  public upsertProject(project: ProjectRecord): ProjectRecord {
    project.updatedAt = new Date().toISOString();
    const idx = this.state.projects.findIndex((p) => p.id === project.id);
    if (idx >= 0) {
      this.state.projects[idx] = project;
    } else {
      this.state.projects.unshift(project);
    }
    this.save();
    return project;
  }

  public deleteProject(id: string): boolean {
    const idx = this.state.projects.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.state.projects.splice(idx, 1);
    this.state.exportJobs = this.state.exportJobs.filter((j) => j.projectId !== id);
    this.save();
    const dir = this.getProjectDir(id);
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return true;
  }

  public getProjectDir(projectId: string): string {
    const dir = path.join(PROJECTS_DIR, projectId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  public getExportJobs(projectId?: string): ExportJob[] {
    const list = projectId
      ? this.state.exportJobs.filter((j) => j.projectId === projectId)
      : this.state.exportJobs;
    return [...list].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  public getExportJob(id: string): ExportJob | undefined {
    return this.state.exportJobs.find((j) => j.id === id);
  }

  public upsertExportJob(job: ExportJob): ExportJob {
    const idx = this.state.exportJobs.findIndex((j) => j.id === job.id);
    if (idx >= 0) {
      this.state.exportJobs[idx] = job;
    } else {
      this.state.exportJobs.unshift(job);
    }
    // Keep last 120 export jobs
    if (this.state.exportJobs.length > 120) {
      this.state.exportJobs = this.state.exportJobs.slice(0, 120);
    }
    this.save();
    return job;
  }

  public getSettings(): AppSettings {
    return { ...this.state.settings };
  }

  public updateSettings(partial: Partial<AppSettings>): AppSettings {
    this.state.settings = { ...this.state.settings, ...partial };
    this.save();
    return this.getSettings();
  }

  public getStorageUsageBytes(): { totalBytes: number; projectCount: number; clipCount: number } {
    const walk = (dir: string): number => {
      if (!fs.existsSync(dir)) return 0;
      let total = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          total += walk(full);
        } else {
          try {
            total += fs.statSync(full).size;
          } catch {
            // ignore transient files
          }
        }
      }
      return total;
    };
    const clipCount = this.state.projects.reduce((acc, p) => acc + p.clips.length, 0);
    return {
      totalBytes: walk(PROJECTS_DIR),
      projectCount: this.state.projects.length,
      clipCount,
    };
  }
}

export const store = new Store();
