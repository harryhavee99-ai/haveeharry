import { useSyncExternalStore } from 'react';
import type { AnalysisConfig, ProjectRecord } from '../../shared/types.ts';
import {
  createResumableUploader,
  UPLOAD_CHUNK_SIZE,
  type ResumableUploadController,
  type UploadProgressInfo,
} from './api.ts';

export interface BackgroundUploadState {
  file: File | null;
  fileName: string | null;
  info: UploadProgressInfo | null;
  completedProject: ProjectRecord | null;
  error: string | null;
  bannerDismissed: boolean;
  autoAnalyze: boolean;
  savedConfig: AnalysisConfig | null;
  savedDurationPreset: string | null;
  savedCustomDurationSec: number | null;
}

type Listener = () => void;
type ProjectCompletedHandler = (project: ProjectRecord) => void;

let state: BackgroundUploadState = {
  file: null,
  fileName: null,
  info: null,
  completedProject: null,
  error: null,
  bannerDismissed: false,
  autoAnalyze: true,
  savedConfig: null,
  savedDurationPreset: null,
  savedCustomDurationSec: null,
};

let activeController: ResumableUploadController | null = null;
const listeners = new Set<Listener>();
let onProjectCompleted: ProjectCompletedHandler | null = null;
let globalHooksAttached = false;

function emitChange() {
  for (const listener of listeners) {
    listener();
  }
}

function setState(patch: Partial<BackgroundUploadState>) {
  state = { ...state, ...patch };
  emitChange();
}

function isActivelyUploading(): boolean {
  const s = state.info?.state;
  return s === 'uploading' || s === 'verifying' || s === 'assembling';
}

function ensureGlobalHooks() {
  if (globalHooksAttached || typeof window === 'undefined') return;
  globalHooksAttached = true;

  // Warn only if the user tries to close/reload the whole browser tab mid-upload.
  // Navigating between pages inside the app NEVER triggers this and NEVER interrupts the upload.
  window.addEventListener('beforeunload', (e) => {
    if (isActivelyUploading()) {
      e.preventDefault();
      e.returnValue = 'A video upload is currently in progress. Leaving will stop the upload.';
    }
  });

  // Auto-resume automatically if network dropped into error state and then came back online
  window.addEventListener('online', () => {
    if (activeController && state.info?.state === 'error') {
      void uploadManager.resumeUpload();
    }
  });
}

export const uploadManager = {
  getSnapshot(): BackgroundUploadState {
    return state;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },

  setOnProjectCompleted(handler: ProjectCompletedHandler | null) {
    onProjectCompleted = handler;
  },

  saveFormDraft(draft: {
    config: AnalysisConfig;
    durationPreset: string;
    customDurationSec: number;
  }) {
    state = {
      ...state,
      savedConfig: draft.config,
      savedDurationPreset: draft.durationPreset,
      savedCustomDurationSec: draft.customDurationSec,
    };
    // Silent update without forcing re-render cascades across unrelated pages
  },

  clearError() {
    if (state.error) {
      setState({ error: null });
    }
  },

  dismissBanner() {
    setState({ bannerDismissed: true });
  },

  setAutoAnalyze(enabled: boolean) {
    setState({ autoAnalyze: enabled });
  },

  startUpload(file: File, analysisConfig: Partial<AnalysisConfig>, autoAnalyzeOverride?: boolean) {
    ensureGlobalHooks();

    // Never drop an in-flight upload accidentally
    if (isActivelyUploading()) {
      setState({
        error: 'An upload is already running in the background. Wait for it to finish or cancel it first.',
      });
      return;
    }

    const shouldAutoAnalyze = autoAnalyzeOverride ?? state.autoAnalyze;

    const controller = createResumableUploader({
      file,
      analysisConfig,
      autoAnalyze: shouldAutoAnalyze,
      onProgress: (info) => {
        // Only apply progress events from the currently active controller
        if (activeController !== controller) return;
        setState({
          info,
          error: info.state === 'error' ? info.error || 'Upload interrupted.' : null,
        });
      },
    });

    activeController = controller;
    setState({
      file,
      fileName: file.name,
      completedProject: null,
      error: null,
      bannerDismissed: false,
      info: {
        projectId: '',
        fileName: file.name,
        uploadedBytes: 0,
        totalBytes: file.size,
        percentage: 0,
        chunkIndex: 0,
        totalChunks: Math.max(1, Math.ceil(file.size / UPLOAD_CHUNK_SIZE)),
        speedBytesPerSec: 0,
        state: 'uploading',
      },
    });

    void controller
      .resume()
      .then((completed) => {
        if (activeController !== controller) return;
        if (completed) {
          activeController = null;
          setState({
            completedProject: completed,
            error: null,
            bannerDismissed: false,
          });
          onProjectCompleted?.(completed);
        }
      })
      .catch((err) => {
        if (activeController !== controller) return;
        setState({
          error: err instanceof Error ? err.message : 'Upload failed.',
        });
      });
  },

  pauseUpload() {
    if (!activeController || state.info?.state !== 'uploading') return;
    activeController.pause();
  },

  async resumeUpload() {
    const controller = activeController;
    if (!controller) return;
    if (state.info?.state !== 'paused' && state.info?.state !== 'error') return;

    setState({ error: null, bannerDismissed: false });
    try {
      const completed = await controller.resume();
      if (activeController !== controller) return;
      if (completed) {
        activeController = null;
        setState({
          completedProject: completed,
          error: null,
          bannerDismissed: false,
        });
        onProjectCompleted?.(completed);
      }
    } catch (err) {
      if (activeController !== controller) return;
      setState({
        error: err instanceof Error ? err.message : 'Resume failed.',
      });
    }
  },

  async cancelUpload() {
    const controller = activeController;
    activeController = null;
    if (controller) {
      await controller.cancel();
    }
    setState({
      file: null,
      fileName: null,
      info: null,
      completedProject: null,
      error: null,
      bannerDismissed: false,
    });
  },

  setCompletedProject(project: ProjectRecord) {
    activeController = null;
    setState({
      file: null,
      fileName: project.originalFilename,
      info: null,
      completedProject: project,
      error: null,
      bannerDismissed: true,
    });
    onProjectCompleted?.(project);
  },

  resetForNewUpload() {
    if (isActivelyUploading()) return;
    activeController = null;
    setState({
      file: null,
      fileName: null,
      info: null,
      completedProject: null,
      error: null,
      bannerDismissed: false,
    });
  },

  clearCompletedProjectIfId(projectId: string) {
    if (state.completedProject?.id === projectId) {
      setState({
        completedProject: null,
        bannerDismissed: true,
      });
    }
  },
};

export function useUploadManager(): BackgroundUploadState {
  return useSyncExternalStore(uploadManager.subscribe, uploadManager.getSnapshot);
}
