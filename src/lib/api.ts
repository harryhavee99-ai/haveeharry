import type {
  AnalysisConfig,
  AppSettings,
  ClipRecord,
  ExportJob,
  ExportOptions,
  MusicTrack,
  ProjectRecord,
  SystemCapabilities,
} from '../../shared/types.ts';

function parseReadableError(status: number, text: string, fallback: string): string {
  const trimmed = text.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      if (parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }
      if (parsed && typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // Not JSON — check if it's an HTML proxy/warmup page
      if (trimmed.startsWith('<!') || trimmed.toLowerCase().includes('<html')) {
        if (status === 413) return 'Upload chunk exceeded proxy size limit (413).';
        if (status === 502 || status === 503 || status === 504) {
          return 'Server is waking up or temporarily busy. Retrying automatically...';
        }
        if (status === 403) return 'Session authentication expired. Please refresh the page and retry.';
        return `Server returned an unexpected HTML response (${status}).`;
      }
      return trimmed.slice(0, 240);
    }
  }
  return fallback || `Request failed (${status})`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(parseReadableError(res.status, text, `Request failed (${res.status})`));
  }
  if (!text) return null as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(parseReadableError(res.status, text, 'Invalid server response.'));
  }
}

export const api = {
  getCapabilities: () =>
    requestJson<{
      capabilities: SystemCapabilities;
      storage: { totalBytes: number; projectCount: number; clipCount: number };
    }>('/api/system/capabilities'),

  getSettings: () => requestJson<AppSettings>('/api/settings'),

  updateSettings: (patch: Partial<AppSettings>) =>
    requestJson<AppSettings>('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  getMusicTracks: () => requestJson<MusicTrack[]>('/api/music'),

  getProjects: () => requestJson<ProjectRecord[]>('/api/projects'),

  getProject: (id: string) =>
    requestJson<ProjectRecord & { isRunning?: boolean }>(`/api/projects/${id}`),

  deleteProject: (id: string) =>
    requestJson<{ deleted: boolean }>(`/api/projects/${id}`, { method: 'DELETE' }),

  createSampleProject: (analysisConfig?: Partial<AnalysisConfig>) =>
    requestJson<ProjectRecord>('/api/projects/sample', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysisConfig }),
    }),

  startAnalysis: (
    projectId: string,
    analysisConfig?: Partial<AnalysisConfig>,
    restartHighlightsOnly = false
  ) =>
    requestJson<{ started: boolean; project: ProjectRecord }>(`/api/projects/${projectId}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ analysisConfig, restartHighlightsOnly }),
    }),

  updateClip: (projectId: string, clipId: string, patch: Partial<ClipRecord>) =>
    requestJson<ClipRecord>(`/api/projects/${projectId}/clips/${clipId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  applyCaptionsToAll: (projectId: string, clipId: string, captionStyle: ClipRecord['captionStyle']) =>
    requestJson<{ updatedCount: number; project: ProjectRecord }>(
      `/api/projects/${projectId}/clips/${clipId}/apply-captions-all`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ captionStyle }),
      }
    ),

  applyStyleToAll: (
    projectId: string,
    clipId: string,
    payload: {
      colorGrading: ClipRecord['colorGrading'];
      motionGraphics: ClipRecord['motionGraphics'];
      framing?: ClipRecord['framing'];
    }
  ) =>
    requestJson<{ updatedCount: number; project: ProjectRecord }>(
      `/api/projects/${projectId}/clips/${clipId}/apply-style-all`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    ),

  regenerateClip: (
    projectId: string,
    clipId: string,
    payload?: { targetDuration?: number; focusPrompt?: string }
  ) =>
    requestJson<ClipRecord>(`/api/projects/${projectId}/clips/${clipId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }),

  deleteClip: (projectId: string, clipId: string) =>
    requestJson<{ deleted: boolean }>(`/api/projects/${projectId}/clips/${clipId}`, {
      method: 'DELETE',
    }),

  exportClip: (projectId: string, clipId: string, options: Partial<ExportOptions>) =>
    requestJson<ExportJob>(`/api/projects/${projectId}/clips/${clipId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    }),

  exportBatch: (projectId: string, clipIds: string[], options: Partial<ExportOptions>) =>
    requestJson<{ jobs: ExportJob[] }>(`/api/projects/${projectId}/export-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clipIds, options }),
    }),

  getExports: (projectId?: string) =>
    requestJson<ExportJob[]>(projectId ? `/api/exports?projectId=${encodeURIComponent(projectId)}` : '/api/exports'),

  cancelUpload: (projectId: string) =>
    requestJson<{ cancelled: boolean }>(`/api/uploads/${projectId}/cancel`, { method: 'DELETE' }),
};

export interface ResumableUploadController {
  pause: () => void;
  resume: () => Promise<ProjectRecord | null>;
  cancel: () => Promise<void>;
  getProjectId: () => string | null;
}

export interface UploadProgressInfo {
  projectId: string;
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
  chunkIndex: number;
  totalChunks: number;
  speedBytesPerSec: number;
  state: 'uploading' | 'paused' | 'assembling' | 'completed' | 'cancelled' | 'error';
  error?: string;
  retryNotice?: string;
}

export const UPLOAD_CHUNK_SIZE = 2 * 1024 * 1024; // 2 MB proxy-safe chunks

/**
 * Resumable chunked uploader capable of streaming multi-GB / 5-hour videos reliably
 * in the background with pause, resume, offline recovery, automatic per-chunk retry,
 * automatic server-restart session recovery, and cancel support.
 */
export function createResumableUploader(params: {
  file: File;
  analysisConfig: Partial<AnalysisConfig>;
  onProgress: (info: UploadProgressInfo) => void;
}): ResumableUploadController {
  const { file, analysisConfig, onProgress } = params;
  const CHUNK_SIZE = UPLOAD_CHUNK_SIZE;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));

  let projectId: string | null = null;
  let nextChunk = 0;
  let paused = false;
  let cancelled = false;
  let cumulativeElapsedMs = 0;
  let runStartedAt = 0;
  let uploadedBytes = 0;
  let sessionRecoveries = 0;
  let activeAbort: AbortController | null = null;
  let inFlightPromise: Promise<ProjectRecord | null> | null = null;
  let wakeWaiter: (() => void) | null = null;

  const wakePendingWait = () => {
    const fn = wakeWaiter;
    wakeWaiter = null;
    if (fn) fn();
  };

  const getActiveElapsedSec = () => {
    const currentRunMs = runStartedAt > 0 ? Date.now() - runStartedAt : 0;
    return Math.max(0.25, (cumulativeElapsedMs + currentRunMs) / 1000);
  };

  const emit = (state: UploadProgressInfo['state'], error?: string, retryNotice?: string) => {
    const elapsedSec = getActiveElapsedSec();
    onProgress({
      projectId: projectId || '',
      fileName: file.name,
      uploadedBytes,
      totalBytes: file.size,
      percentage:
        state === 'completed'
          ? 100
          : Math.min(99, Math.round((uploadedBytes / Math.max(1, file.size)) * 100)),
      chunkIndex: nextChunk,
      totalChunks,
      speedBytesPerSec: uploadedBytes / elapsedSec,
      state,
      error,
      retryNotice,
    });
  };

  const sleepCancellable = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (cancelled || paused) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wakeWaiter = null;
        resolve();
      }, ms);
      wakeWaiter = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const waitForOnline = (): Promise<void> =>
    new Promise((resolve) => {
      if (cancelled || paused || typeof window === 'undefined' || navigator.onLine) {
        resolve();
        return;
      }
      const onOnline = () => {
        window.removeEventListener('online', onOnline);
        wakeWaiter = null;
        resolve();
      };
      window.addEventListener('online', onOnline);
      wakeWaiter = () => {
        window.removeEventListener('online', onOnline);
        resolve();
      };
    });

  const retryJsonCall = async <T,>(
    label: string,
    fn: () => Promise<T>,
    maxAttempts = 6
  ): Promise<T> => {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (cancelled || paused) {
        throw new Error(cancelled ? 'Upload cancelled' : 'Upload paused');
      }
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        emit('uploading', undefined, 'Network offline — waiting to reconnect automatically...');
        await waitForOnline();
        if (cancelled || paused) {
          throw new Error(cancelled ? 'Upload cancelled' : 'Upload paused');
        }
      }
      try {
        return await fn();
      } catch (err) {
        if (cancelled || paused) throw err;
        lastErr = err instanceof Error ? err : new Error(String(err));
        // Do not endlessly retry clear 400 validation errors
        if (
          lastErr.message.includes('Unsupported video format') ||
          lastErr.message.includes('exceeds the') ||
          lastErr.message.includes('could not be decoded')
        ) {
          throw lastErr;
        }
        if (attempt < maxAttempts) {
          const delay = Math.min(8000, 1000 * Math.pow(1.8, attempt - 1));
          emit('uploading', undefined, `${label} — retrying (${attempt}/${maxAttempts})...`);
          await sleepCancellable(delay);
        }
      }
    }
    throw lastErr || new Error(`${label} failed after ${maxAttempts} attempts.`);
  };

  const initSession = async (): Promise<void> => {
    const initRes = await retryJsonCall('Initializing upload', () =>
      requestJson<{ projectId: string; chunkSize: number }>('/api/uploads/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          fileSize: file.size,
          mimeType: file.type || 'video/mp4',
          totalChunks,
          analysisConfig,
        }),
      })
    );
    projectId = initRes.projectId;
  };

  const runLoop = async (): Promise<ProjectRecord | null> => {
    paused = false;
    runStartedAt = Date.now();

    try {
      if (!projectId) {
        emit('uploading');
        await initSession();
      }

      emit('uploading');

      while (nextChunk < totalChunks) {
        if (cancelled) return null;
        if (paused) {
          if (runStartedAt > 0) {
            cumulativeElapsedMs += Date.now() - runStartedAt;
            runStartedAt = 0;
          }
          emit('paused');
          return null;
        }

        const start = nextChunk * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const blob = file.slice(start, end);

        let chunkSuccess = false;
        let sessionResetNeeded = false;
        let lastErr: Error | null = null;
        const MAX_CHUNK_ATTEMPTS = 12;

        for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
          if (cancelled || paused) break;

          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            emit('uploading', undefined, 'Network offline — waiting to reconnect automatically...');
            await waitForOnline();
            if (cancelled || paused) break;
            emit('uploading', undefined, 'Reconnected — resuming upload...');
          }

          try {
            activeAbort = new AbortController();
            const res = await fetch(`/api/uploads/${projectId}/chunk/${nextChunk}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body: blob,
              signal: activeAbort.signal,
            });
            if (!res.ok) {
              const txt = await res.text();
              if (res.status === 404 && sessionRecoveries < 2) {
                sessionResetNeeded = true;
                break;
              }
              throw new Error(
                parseReadableError(res.status, txt, `Chunk ${nextChunk + 1} failed (${res.status})`)
              );
            }
            chunkSuccess = true;
            break;
          } catch (err) {
            if (cancelled || paused) break;
            lastErr = err instanceof Error ? err : new Error(String(err));
            if (attempt < MAX_CHUNK_ATTEMPTS) {
              const backoffMs = Math.min(10000, 1000 * Math.pow(1.6, attempt - 1));
              emit(
                'uploading',
                undefined,
                `Connection hiccup on chunk ${nextChunk + 1} — retrying (${attempt}/${MAX_CHUNK_ATTEMPTS})...`
              );
              await sleepCancellable(backoffMs);
            }
          }
        }

        if (cancelled) return null;
        if (paused) {
          if (runStartedAt > 0) {
            cumulativeElapsedMs += Date.now() - runStartedAt;
            runStartedAt = 0;
          }
          emit('paused');
          return null;
        }

        if (sessionResetNeeded) {
          sessionRecoveries++;
          projectId = null;
          nextChunk = 0;
          uploadedBytes = 0;
          emit('uploading', undefined, 'Server restarted — re-establishing upload session automatically...');
          await initSession();
          emit('uploading');
          continue;
        }

        if (!chunkSuccess) {
          throw lastErr || new Error(`Chunk ${nextChunk + 1} upload failed after multiple retries.`);
        }

        uploadedBytes = end;
        nextChunk++;
        emit('uploading');
      }

      emit('assembling');
      const completed = await retryJsonCall(
        'Finalizing video',
        () =>
          requestJson<ProjectRecord>(`/api/uploads/${projectId}/complete`, {
            method: 'POST',
          }),
        5
      );
      if (runStartedAt > 0) {
        cumulativeElapsedMs += Date.now() - runStartedAt;
        runStartedAt = 0;
      }
      emit('completed');
      return completed;
    } catch (err) {
      if (runStartedAt > 0) {
        cumulativeElapsedMs += Date.now() - runStartedAt;
        runStartedAt = 0;
      }
      if (cancelled) return null;
      if (paused) {
        emit('paused');
        return null;
      }
      const message = err instanceof Error ? err.message : 'Upload failed.';
      emit('error', message);
      throw err;
    }
  };

  return {
    pause: () => {
      paused = true;
      activeAbort?.abort();
      wakePendingWait();
      if (runStartedAt > 0) {
        cumulativeElapsedMs += Date.now() - runStartedAt;
        runStartedAt = 0;
      }
      emit('paused');
    },
    resume: () => {
      if (inFlightPromise) {
        return inFlightPromise;
      }
      const p = runLoop().finally(() => {
        if (inFlightPromise === p) {
          inFlightPromise = null;
        }
      });
      inFlightPromise = p;
      return p;
    },
    cancel: async () => {
      cancelled = true;
      paused = false;
      activeAbort?.abort();
      wakePendingWait();
      if (projectId) {
        try {
          await api.cancelUpload(projectId);
        } catch {
          // ignore cleanup errors on cancel
        }
      }
      emit('cancelled');
    },
    getProjectId: () => projectId,
  };
}

