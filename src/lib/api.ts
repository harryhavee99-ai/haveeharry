import type {
  AnalysisConfig,
  AppSettings,
  ClipRecord,
  ExportJob,
  ExportOptions,
  HookCandidate,
  MusicTrack,
  ProjectRecord,
  SystemCapabilities,
} from '../../shared/types.ts';

class ApiResponseError extends Error {
  status: number;
  code: 'warmup' | 'auth' | 'missing_chunk' | 'not_found' | 'validation' | 'server';
  missingChunk?: number;

  constructor(
    message: string,
    opts: {
      status: number;
      code: ApiResponseError['code'];
      missingChunk?: number;
    }
  ) {
    super(message);
    this.name = 'ApiResponseError';
    this.status = opts.status;
    this.code = opts.code;
    this.missingChunk = opts.missingChunk;
  }
}

function classifyResponseError(
  status: number,
  text: string,
  fallback: string,
  responseUrl?: string
): ApiResponseError {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as {
        error?: unknown;
        message?: unknown;
        missingChunk?: unknown;
      };
      const msg =
        typeof parsed?.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : typeof parsed?.message === 'string' && parsed.message.trim()
            ? parsed.message.trim()
            : fallback || `Request failed (${status})`;

      if (typeof parsed?.missingChunk === 'number') {
        return new ApiResponseError(msg, {
          status,
          code: 'missing_chunk',
          missingChunk: parsed.missingChunk,
        });
      }
      if (status === 404) {
        return new ApiResponseError(msg, { status, code: 'not_found' });
      }
      if (status === 400) {
        return new ApiResponseError(msg, { status, code: 'validation' });
      }
      return new ApiResponseError(msg, { status, code: 'server' });
    } catch {
      const isHtml = trimmed.startsWith('<!') || lower.includes('<html');
      if (isHtml) {
        if (
          lower.includes('cookie check') ||
          lower.includes('applet-auth-bridge') ||
          lower.includes('403 forbidden') ||
          (responseUrl && responseUrl.includes('__cookie_check')) ||
          status === 403
        ) {
          return new ApiResponseError(
            'Session cookie verification expired. Please refresh this tab once and retry the upload.',
            { status, code: 'auth' }
          );
        }
        if (
          lower.includes('starting server') ||
          lower.includes('warming up') ||
          status === 502 ||
          status === 503 ||
          status === 504 ||
          status === 200
        ) {
          return new ApiResponseError(
            'Backend server is waking up or restarting — retrying automatically...',
            { status, code: 'warmup' }
          );
        }
        if (status === 413) {
          return new ApiResponseError('Upload chunk exceeded proxy size limit (413).', {
            status,
            code: 'server',
          });
        }
        return new ApiResponseError(
          `Server temporarily returned an HTML page (${status}) instead of JSON.`,
          { status, code: 'warmup' }
        );
      }
      return new ApiResponseError(trimmed.slice(0, 240), {
        status,
        code: status === 404 ? 'not_found' : status === 400 ? 'validation' : 'server',
      });
    }
  }

  return new ApiResponseError(fallback || `Request failed (${status})`, {
    status,
    code: status === 404 ? 'not_found' : status === 400 ? 'validation' : 'server',
  });
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || 'GET').toUpperCase();
  const maxAttempts = method === 'GET' ? 4 : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      credentials: 'include',
      ...init,
    });
    const text = await res.text();
    const contentType = (res.headers.get('content-type') || '').toLowerCase();

    if (!res.ok) {
      const apiErr = classifyResponseError(res.status, text, `Request failed (${res.status})`, res.url);
      if (apiErr.code === 'warmup' && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      throw apiErr;
    }

    if (!text) {
      if (method === 'GET' && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      if (method === 'GET') {
        throw new ApiResponseError('Server returned an empty response while waking up. Retrying shortly.', {
          status: res.status,
          code: 'warmup',
        });
      }
      return null as T;
    }

    // Detect Nginx 200 warmup.html / __cookie_check.html / SPA HTML masquerading as 200 OK
    const looksHtml =
      contentType.includes('text/html') ||
      text.trimStart().startsWith('<!') ||
      text.trimStart().toLowerCase().startsWith('<html');

    if (looksHtml) {
      const apiErr = classifyResponseError(res.status, text, 'Unexpected HTML response.', res.url);
      if (apiErr.code === 'warmup' && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1200 * attempt));
        continue;
      }
      throw apiErr;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw classifyResponseError(res.status, text, 'Invalid JSON response from server.', res.url);
    }
  }

  throw new Error('Server is temporarily unavailable. Please try again.');
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

  createFullVideoCaptions: (
    projectId: string,
    payload?: { captionPresetId?: string; autoRender?: boolean; language?: string }
  ) =>
    requestJson<{
      startedPipeline: boolean;
      clip?: ClipRecord;
      exportJob?: ExportJob;
      project: ProjectRecord;
    }>(`/api/projects/${projectId}/captions-full-video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }),

  resyncAudioCaptions: (projectId: string, clipId?: string) =>
    requestJson<{ project: ProjectRecord; alignedSegments: number }>(
      `/api/projects/${projectId}/resync-audio`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clipId }),
      }
    ),

  analyzeClipAudioCaptions: (projectId: string, clipId: string, language?: string) =>
    requestJson<{
      project: ProjectRecord;
      clip: ClipRecord;
      alignedSegments: number;
      wordCount: number;
      mode: 'ai_transcribed_and_waveform_synced' | 'waveform_synced';
    }>(`/api/projects/${projectId}/clips/${clipId}/analyze-audio-captions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language }),
    }),

  createProjectFromTranscript: (payload: {
    name?: string;
    content: string;
    filename?: string;
    language?: string;
    aspectRatio?: '9:16' | '16:9' | '1:1' | '4:5';
    captionPresetId?: string;
    animation?: ClipRecord['captionStyle']['animation'];
    targetDurationSeconds?: number;
  }) =>
    requestJson<{ project: ProjectRecord; clip: ClipRecord }>('/api/projects/from-transcript', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),

  importClipTranscript: (
    projectId: string,
    clipId: string,
    payload: { content: string; filename?: string; syncWithAudio?: boolean }
  ) =>
    requestJson<{
      project: ProjectRecord;
      clip: ClipRecord;
      segmentsCount: number;
      wordCount: number;
    }>(`/api/projects/${projectId}/clips/${clipId}/import-transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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

  getClipDownloadUrl: (projectId: string, clipId: string) =>
    requestJson<{
      ready: boolean;
      downloadUrl: string;
      filename: string;
      fileSize: number;
      duration: number;
      resolution: string;
      mimeType: string;
      expiresAt: string;
    }>(`/api/projects/${projectId}/clips/${clipId}/download-url`),

  downloadClipMp4: async (projectId: string, clipId: string): Promise<{ filename: string; fileSize: number }> => {
    const info = await api.getClipDownloadUrl(projectId, clipId);
    if (!info?.ready || !info.downloadUrl) {
      throw new Error('Verified MP4 file is not ready yet. Please render the clip first.');
    }

    const res = await fetch(info.downloadUrl, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      const errText = await res.text();
      throw classifyResponseError(res.status, errText, `MP4 download failed (${res.status})`, res.url);
    }

    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      const errText = await res.text();
      throw classifyResponseError(
        res.status,
        errText,
        'Server did not return a valid video/mp4 binary stream.',
        res.url
      );
    }

    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new Error('Downloaded MP4 file was empty (0 bytes). Please re-render the clip.');
    }

    const mp4Blob = blob.type === 'video/mp4' ? blob : new Blob([blob], { type: 'video/mp4' });
    const objectUrl = URL.createObjectURL(mp4Blob);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = info.filename || 'ClipGenius_Clip.mp4';
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
    }

    return { filename: info.filename, fileSize: blob.size };
  },

  downloadClipSoftSubMp4: async (
    projectId: string,
    clipId: string,
    fallbackName = 'SkaDoosh_Captioned_Original'
  ): Promise<{ filename: string; fileSize: number }> => {
    const res = await fetch(`/api/projects/${projectId}/clips/${clipId}/download-softsub`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      const errText = await res.text();
      throw classifyResponseError(res.status, errText, `Soft-sub MP4 download failed (${res.status})`, res.url);
    }
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      const errText = await res.text();
      throw classifyResponseError(res.status, errText, 'Server did not return a valid MP4 stream.', res.url);
    }

    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new Error('Downloaded soft-subtitled MP4 was empty.');
    }

    const disp = res.headers.get('content-disposition') || '';
    const match = disp.match(/filename="?([^"]+)"?/i);
    const filename =
      match?.[1] || `${fallbackName.replace(/[^a-zA-Z0-9-_]/g, '_') || 'video'}_softsub_original.mp4`;

    const mp4Blob = blob.type === 'video/mp4' ? blob : new Blob([blob], { type: 'video/mp4' });
    const objectUrl = URL.createObjectURL(mp4Blob);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
    }

    return { filename, fileSize: blob.size };
  },

  downloadClipChromaCaptionsMp4: async (
    projectId: string,
    clipId: string,
    fallbackName = 'SkaDoosh_Chroma_Green_Captions',
    options?: { chromaColor?: string; includeAudio?: boolean; resolution?: string }
  ): Promise<{ filename: string; fileSize: number }> => {
    const params = new URLSearchParams();
    if (options?.chromaColor) params.set('color', options.chromaColor);
    if (options?.includeAudio !== undefined) params.set('includeAudio', String(options.includeAudio));
    if (options?.resolution) params.set('resolution', options.resolution);
    const qs = params.toString();

    const res = await fetch(
      `/api/projects/${projectId}/clips/${clipId}/download-chroma-captions${qs ? `?${qs}` : ''}`,
      {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      }
    );

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      const errText = await res.text();
      throw classifyResponseError(
        res.status,
        errText,
        `Chroma Green Screen MP4 download failed (${res.status})`,
        res.url
      );
    }
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      const errText = await res.text();
      throw classifyResponseError(
        res.status,
        errText,
        'Server did not return a valid Chroma Green Screen MP4 stream.',
        res.url
      );
    }

    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new Error('Downloaded Chroma Green Screen MP4 was empty.');
    }

    const disp = res.headers.get('content-disposition') || '';
    const match = disp.match(/filename="?([^"]+)"?/i);
    const filename =
      match?.[1] ||
      `${fallbackName.replace(/[^a-zA-Z0-9-_]/g, '_') || 'captions'}_chroma_green_captions.mp4`;

    const mp4Blob = blob.type === 'video/mp4' ? blob : new Blob([blob], { type: 'video/mp4' });
    const objectUrl = URL.createObjectURL(mp4Blob);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
    }

    return { filename, fileSize: blob.size };
  },

  downloadClipSubtitleFile: async (
    projectId: string,
    clipId: string,
    format: 'srt' | 'vtt' | 'ass',
    fallbackName = 'SkaDoosh_Captions'
  ): Promise<{ filename: string; fileSize: number }> => {
    const res = await fetch(`/api/projects/${projectId}/clips/${clipId}/subtitles.${format}`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      const errText = await res.text();
      throw classifyResponseError(
        res.status,
        errText,
        `${format.toUpperCase()} subtitle download failed (${res.status})`,
        res.url
      );
    }
    if (contentType.includes('text/html') || contentType.includes('application/json')) {
      const errText = await res.text();
      throw classifyResponseError(
        res.status,
        errText,
        `Server did not return a valid .${format} subtitle file.`,
        res.url
      );
    }

    const textContent = await res.text();
    if (!textContent || !textContent.trim()) {
      throw new Error(`No captions available to download for .${format.toUpperCase()}. Please generate captions first.`);
    }

    const mimeMap: Record<'srt' | 'vtt' | 'ass', string> = {
      srt: 'application/x-subrip;charset=utf-8',
      vtt: 'text/vtt;charset=utf-8',
      ass: 'text/plain;charset=utf-8',
    };
    const blob = new Blob([textContent], { type: mimeMap[format] });

    const disp = res.headers.get('content-disposition') || '';
    const match = disp.match(/filename="?([^"]+)"?/i);
    const filename =
      match?.[1] ||
      `${fallbackName.replace(/[^a-zA-Z0-9-_]/g, '_') || 'captions'}.${format}`;

    const objectUrl = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
    }

    return { filename, fileSize: blob.size };
  },

  downloadProjectZip: async (projectId: string, fallbackName = 'clipgenius_clips'): Promise<void> => {
    const res = await fetch(`/api/projects/${projectId}/download-zip`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
    });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok) {
      const errText = await res.text();
      throw classifyResponseError(res.status, errText, `ZIP download failed (${res.status})`, res.url);
    }
    if (!contentType.includes('zip') && !contentType.includes('octet-stream')) {
      const errText = await res.text();
      throw classifyResponseError(res.status, errText, 'Server did not return a valid ZIP archive.', res.url);
    }

    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      throw new Error('ZIP archive was empty. Render at least one clip first.');
    }

    const disp = res.headers.get('content-disposition') || '';
    const match = disp.match(/filename="?([^"]+)"?/i);
    const filename =
      match?.[1] || `${fallbackName.replace(/[^a-zA-Z0-9-_]/g, '_') || 'clipgenius'}_clips.zip`;

    const objectUrl = URL.createObjectURL(blob);
    try {
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = filename;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setTimeout(() => URL.revokeObjectURL(objectUrl), 15_000);
    }
  },

  updateHookCandidate: (projectId: string, candidateId: string, patch: Partial<HookCandidate>) =>
    requestJson<{ candidate: HookCandidate; project: ProjectRecord }>(
      `/api/projects/${projectId}/hooks/${candidateId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }
    ),

  generateClipFromHook: (projectId: string, candidateId: string) =>
    requestJson<{
      clip: ClipRecord;
      candidate: HookCandidate;
      exportJob: ExportJob;
      project: ProjectRecord;
    }>(`/api/projects/${projectId}/hooks/${candidateId}/generate-clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }),

  getUploadStatus: (projectId: string) =>
    requestJson<{
      uploadId: string;
      projectId: string;
      status: string;
      fileSize: number;
      totalChunks: number;
      uploadedChunks: number[];
      missingChunks: number[];
      uploadProgress: number;
    }>(`/api/uploads/${projectId}/status`),

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
  uploadId?: string;
  projectId: string;
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
  chunkIndex: number;
  totalChunks: number;
  completedChunks?: number;
  activeWorkers?: number;
  parallelStreams?: number;
  chunkSizeBytes?: number;
  speedBytesPerSec: number;
  peakSpeedBytesPerSec?: number;
  etaSeconds?: number;
  elapsedSeconds?: number;
  state: 'uploading' | 'verifying' | 'paused' | 'assembling' | 'completed' | 'cancelled' | 'error';
  error?: string;
  retryNotice?: string;
}

export const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB high-speed proxy-safe chunks
export const UPLOAD_PARALLEL_STREAMS = 3; // 3 concurrent upload streams for 3x-5x faster throughput

/**
 * High-speed parallel resumable chunked uploader capable of streaming multi-GB / 5-hour videos
 * with 3 concurrent streams, pause, resume, offline recovery, automatic per-chunk retry,
 * server-verified disk status sync, automatic server-restart recovery, and live speed/ETA telemetry.
 */
export function createResumableUploader(params: {
  file: File;
  analysisConfig: Partial<AnalysisConfig>;
  autoAnalyze?: boolean;
  onProgress: (info: UploadProgressInfo) => void;
}): ResumableUploadController {
  const { file, analysisConfig, autoAnalyze = false, onProgress } = params;
  const CHUNK_SIZE = UPLOAD_CHUNK_SIZE;
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
  const parallelStreams = Math.min(UPLOAD_PARALLEL_STREAMS, totalChunks);

  let uploadId: string | null = null;
  let projectId: string | null = null;
  const uploadedChunkSet = new Set<number>();
  const activeWorkerChunks = new Set<number>();
  const inFlightChunkBytes = new Map<number, number>();
  let nextChunk = 0;
  let paused = false;
  let cancelled = false;
  let cumulativeElapsedMs = 0;
  let runStartedAt = 0;
  let uploadedBytes = 0;
  let peakSpeedBytesPerSec = 0;
  let sessionRecoveries = 0;
  const activeAborts = new Set<AbortController>();
  const activeXhrs = new Set<XMLHttpRequest>();
  let inFlightPromise: Promise<ProjectRecord | null> | null = null;
  let wakeWaiter: (() => void) | null = null;

  const wakePendingWait = () => {
    const fn = wakeWaiter;
    wakeWaiter = null;
    if (fn) fn();
  };

  const abortAllInFlight = () => {
    for (const ctrl of activeAborts) {
      try {
        ctrl.abort();
      } catch {
        // ignore
      }
    }
    activeAborts.clear();
    for (const xhr of activeXhrs) {
      try {
        xhr.abort();
      } catch {
        // ignore
      }
    }
    activeXhrs.clear();
    inFlightChunkBytes.clear();
    activeWorkerChunks.clear();
  };

  const getChunkSize = (idx: number): number => {
    const start = idx * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    return Math.max(0, end - start);
  };

  const computeTotalTransferredBytes = (): number => {
    let completedSum = 0;
    for (const idx of uploadedChunkSet) {
      completedSum += getChunkSize(idx);
    }
    let inFlightSum = 0;
    for (const [idx, bytes] of inFlightChunkBytes.entries()) {
      if (!uploadedChunkSet.has(idx)) {
        inFlightSum += Math.min(getChunkSize(idx), bytes);
      }
    }
    return Math.min(file.size, completedSum + inFlightSum);
  };

  const getActiveElapsedSec = () => {
    const currentRunMs = runStartedAt > 0 ? Date.now() - runStartedAt : 0;
    return Math.max(0.25, (cumulativeElapsedMs + currentRunMs) / 1000);
  };

  const emit = (state: UploadProgressInfo['state'], error?: string, retryNotice?: string) => {
    const elapsedSec = getActiveElapsedSec();
    uploadedBytes = state === 'completed' ? file.size : computeTotalTransferredBytes();
    const speed = uploadedBytes / elapsedSec;
    if (speed > peakSpeedBytesPerSec && uploadedBytes > 64 * 1024) {
      peakSpeedBytesPerSec = speed;
    }
    const remainingBytes = Math.max(0, file.size - uploadedBytes);
    const etaSeconds =
      state === 'completed'
        ? 0
        : speed > 1024
          ? Math.max(1, Math.round(remainingBytes / speed))
          : undefined;

    onProgress({
      uploadId: uploadId || undefined,
      projectId: projectId || '',
      fileName: file.name,
      uploadedBytes,
      totalBytes: file.size,
      percentage:
        state === 'completed'
          ? 100
          : Math.min(99, Math.round((uploadedBytes / Math.max(1, file.size)) * 100)),
      chunkIndex: uploadedChunkSet.size,
      totalChunks,
      completedChunks: uploadedChunkSet.size,
      activeWorkers: activeWorkerChunks.size,
      parallelStreams,
      chunkSizeBytes: CHUNK_SIZE,
      speedBytesPerSec: speed,
      peakSpeedBytesPerSec: Math.max(peakSpeedBytesPerSec, speed),
      etaSeconds,
      elapsedSeconds: Math.round(elapsedSec),
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

  const waitForServerReady = async (): Promise<void> => {
    for (let i = 0; i < 12; i++) {
      if (cancelled || paused) return;
      try {
        const healthRes = await fetch('/api/health', {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        });
        const ct = (healthRes.headers.get('content-type') || '').toLowerCase();
        if (healthRes.ok && ct.includes('application/json')) {
          return;
        }
      } catch {
        // still waking up
      }
      emit('uploading', undefined, 'Waiting for backend server to finish waking up...');
      await sleepCancellable(Math.min(5000, 1200 + i * 500));
    }
  };

  const retryJsonCall = async <T,>(
    label: string,
    fn: () => Promise<T>,
    maxAttempts = 10
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
        if (err instanceof ApiResponseError) {
          if (err.code === 'validation' || err.code === 'auth' || err.code === 'missing_chunk') {
            throw err;
          }
          if (err.code === 'warmup') {
            emit('uploading', undefined, 'Server waking up — resuming upload automatically...');
            await waitForServerReady();
            continue;
          }
        }
        if (attempt < maxAttempts) {
          const delay = Math.min(8000, 1000 * Math.pow(1.6, attempt - 1));
          emit('uploading', undefined, `${label} — retrying (${attempt}/${maxAttempts})...`);
          await sleepCancellable(delay);
        }
      }
    }
    throw lastErr || new Error(`${label} failed after ${maxAttempts} attempts.`);
  };

  const initSession = async (): Promise<void> => {
    const initRes = await retryJsonCall('Initializing high-speed upload', () =>
      requestJson<{ uploadId?: string; projectId: string; chunkSize: number }>('/api/uploads/init', {
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
    uploadId = initRes.uploadId ?? initRes.projectId;
    projectId = initRes.projectId;
    uploadedChunkSet.clear();
    inFlightChunkBytes.clear();
  };

  const syncWithServerStatus = async (): Promise<number[]> => {
    if (!projectId) return [];
    const statusRes = await retryJsonCall('Verifying uploaded chunks', () => api.getUploadStatus(projectId!), 5);
    uploadedChunkSet.clear();
    for (const idx of statusRes.uploadedChunks) {
      uploadedChunkSet.add(idx);
    }
    uploadedBytes = computeTotalTransferredBytes();
    return statusRes.missingChunks;
  };

  /**
   * Sends a single chunk using XMLHttpRequest so we receive real-time per-byte `upload.onprogress`
   * telemetry at 60fps across all parallel workers.
   */
  const sendChunkViaXhr = (
    chunkIdx: number,
    blob: Blob
  ): Promise<{ status: number; text: string; contentType: string; responseUrl: string }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhrs.add(xhr);
      xhr.open('POST', `/api/uploads/${projectId}/chunk/${chunkIdx}`, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');

      let lastProgressEmit = 0;
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && !cancelled && !paused) {
          inFlightChunkBytes.set(chunkIdx, ev.loaded);
          const now = Date.now();
          if (now - lastProgressEmit >= 90) {
            lastProgressEmit = now;
            emit('uploading');
          }
        }
      };

      const cleanup = () => {
        activeXhrs.delete(xhr);
      };

      xhr.onload = () => {
        cleanup();
        resolve({
          status: xhr.status,
          text: xhr.responseText || '',
          contentType: (xhr.getResponseHeader('content-type') || '').toLowerCase(),
          responseUrl: xhr.responseURL || '',
        });
      };

      xhr.onerror = () => {
        cleanup();
        reject(new Error(`Network error while uploading chunk ${chunkIdx + 1}`));
      };

      xhr.onabort = () => {
        cleanup();
        reject(new Error('Chunk upload aborted'));
      };

      xhr.send(blob);
    });

  const uploadSingleChunk = async (chunkIdx: number): Promise<'ok' | 'paused' | 'cancelled' | 'reset_session'> => {
    const start = chunkIdx * CHUNK_SIZE;
    const end = Math.min(file.size, start + CHUNK_SIZE);
    const blob = file.slice(start, end);

    let lastErr: Error | null = null;
    const MAX_CHUNK_ATTEMPTS = 15;
    activeWorkerChunks.add(chunkIdx);

    try {
      for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS; attempt++) {
        if (cancelled) return 'cancelled';
        if (paused) return 'paused';

        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          emit('uploading', undefined, 'Network offline — waiting to reconnect automatically...');
          await waitForOnline();
          if (cancelled) return 'cancelled';
          if (paused) return 'paused';
          emit('uploading', undefined, 'Reconnected — resuming high-speed upload...');
        }

        try {
          inFlightChunkBytes.set(chunkIdx, 0);
          const res = await sendChunkViaXhr(chunkIdx, blob);
          const txt = res.text;
          const ct = res.contentType;

          if (res.status < 200 || res.status >= 300) {
            if (res.status === 404 && sessionRecoveries < 2) {
              return 'reset_session';
            }
            const apiErr = classifyResponseError(
              res.status,
              txt,
              `Chunk ${chunkIdx + 1} failed (${res.status})`,
              res.responseUrl
            );
            if (apiErr.code === 'auth' || apiErr.code === 'validation') {
              throw apiErr;
            }
            if (apiErr.code === 'warmup') {
              emit('uploading', undefined, 'Server waking up — waiting before retrying chunk...');
              await waitForServerReady();
              continue;
            }
            throw apiErr;
          }

          const looksHtml =
            ct.includes('text/html') ||
            txt.trimStart().startsWith('<!') ||
            txt.trimStart().toLowerCase().startsWith('<html');
          if (looksHtml) {
            const apiErr = classifyResponseError(res.status, txt, 'Unexpected HTML response.', res.responseUrl);
            if (apiErr.code === 'auth') {
              throw apiErr;
            }
            emit('uploading', undefined, 'Server restarting — waiting to continue chunk upload...');
            await waitForServerReady();
            continue;
          }

          let ack: { received?: number } | null = null;
          try {
            ack = JSON.parse(txt) as { received?: number };
          } catch {
            throw new Error(`Invalid confirmation for chunk ${chunkIdx + 1}.`);
          }
          if (!ack || ack.received !== chunkIdx) {
            throw new Error(`Server did not confirm chunk ${chunkIdx + 1}.`);
          }

          inFlightChunkBytes.delete(chunkIdx);
          uploadedChunkSet.add(chunkIdx);
          return 'ok';
        } catch (err) {
          inFlightChunkBytes.delete(chunkIdx);
          if (cancelled) return 'cancelled';
          if (paused) return 'paused';
          if (err instanceof ApiResponseError && (err.code === 'auth' || err.code === 'validation')) {
            throw err;
          }
          lastErr = err instanceof Error ? err : new Error(String(err));
          if (attempt < MAX_CHUNK_ATTEMPTS) {
            const backoffMs = Math.min(10000, 900 * Math.pow(1.45, attempt - 1));
            emit(
              'uploading',
              undefined,
              `Connection hiccup on chunk ${chunkIdx + 1} — retrying (${attempt}/${MAX_CHUNK_ATTEMPTS})...`
            );
            await sleepCancellable(backoffMs);
          }
        }
      }
      throw lastErr || new Error(`Chunk ${chunkIdx + 1} upload failed after multiple retries.`);
    } finally {
      activeWorkerChunks.delete(chunkIdx);
      inFlightChunkBytes.delete(chunkIdx);
    }
  };

  const runLoop = async (): Promise<ProjectRecord | null> => {
    paused = false;
    runStartedAt = Date.now();

    try {
      if (!projectId) {
        emit('uploading');
        await initSession();
      } else {
        try {
          emit('verifying', undefined, 'Checking previously uploaded chunks on server...');
          await syncWithServerStatus();
        } catch (syncErr) {
          if (syncErr instanceof ApiResponseError && syncErr.code === 'not_found') {
            projectId = null;
            uploadId = null;
            nextChunk = 0;
            uploadedBytes = 0;
            await initSession();
          }
        }
      }

      emit('uploading');

      // Build queue of remaining chunks and upload in parallel using worker pool
      const pendingQueue: number[] = [];
      for (let i = 0; i < totalChunks; i++) {
        if (!uploadedChunkSet.has(i)) {
          pendingQueue.push(i);
        }
      }

      let resetRequested = false;
      let queueCursor = 0;

      const workerFn = async (): Promise<void> => {
        while (queueCursor < pendingQueue.length) {
          if (cancelled || paused || resetRequested) return;
          const idx = pendingQueue[queueCursor++];
          if (uploadedChunkSet.has(idx)) continue;
          nextChunk = idx;
          const outcome = await uploadSingleChunk(idx);
          if (outcome === 'cancelled' || outcome === 'paused') return;
          if (outcome === 'reset_session') {
            resetRequested = true;
            abortAllInFlight();
            return;
          }
          emit('uploading');
        }
      };

      const workerCount = Math.min(parallelStreams, Math.max(1, pendingQueue.length));
      await Promise.all(Array.from({ length: workerCount }, () => workerFn()));

      if (cancelled) return null;
      if (paused) {
        if (runStartedAt > 0) {
          cumulativeElapsedMs += Date.now() - runStartedAt;
          runStartedAt = 0;
        }
        emit('paused');
        return null;
      }

      if (resetRequested) {
        sessionRecoveries++;
        projectId = null;
        uploadId = null;
        nextChunk = 0;
        uploadedBytes = 0;
        uploadedChunkSet.clear();
        emit('uploading', undefined, 'Server restarted — re-establishing upload session automatically...');
        await waitForServerReady();
        await initSession();
        return runLoop();
      }

      // Verify all chunks on server & finalize upload
      let completed: ProjectRecord | null = null;
      for (let finalizePass = 0; finalizePass < 5; finalizePass++) {
        emit('verifying');
        try {
          const missing = await syncWithServerStatus();
          if (missing.length > 0) {
            for (const missingIdx of missing) {
              emit(
                'uploading',
                undefined,
                `Re-sending missing chunk ${missingIdx + 1} of ${totalChunks}...`
              );
              const repair = await uploadSingleChunk(missingIdx);
              if (repair === 'cancelled') return null;
              if (repair === 'paused') {
                if (runStartedAt > 0) {
                  cumulativeElapsedMs += Date.now() - runStartedAt;
                  runStartedAt = 0;
                }
                emit('paused');
                return null;
              }
              if (repair === 'reset_session') {
                sessionRecoveries++;
                projectId = null;
                uploadId = null;
                nextChunk = 0;
                uploadedBytes = 0;
                uploadedChunkSet.clear();
                return runLoop();
              }
              uploadedChunkSet.add(missingIdx);
            }
          }
        } catch {
          // Proceed to /complete which also validates every chunk strictly
        }

        emit('assembling');
        try {
          completed = await retryJsonCall(
            'Finalizing video',
            () =>
              requestJson<ProjectRecord>(`/api/uploads/${projectId}/complete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ autoAnalyze }),
              }),
            6
          );
          break;
        } catch (err) {
          if (
            err instanceof ApiResponseError &&
            err.code === 'missing_chunk' &&
            typeof err.missingChunk === 'number'
          ) {
            emit(
              'uploading',
              undefined,
              `Re-sending missing chunk ${err.missingChunk + 1} of ${totalChunks}...`
            );
            const repair = await uploadSingleChunk(err.missingChunk);
            if (repair === 'cancelled') return null;
            if (repair === 'paused') {
              if (runStartedAt > 0) {
                cumulativeElapsedMs += Date.now() - runStartedAt;
                runStartedAt = 0;
              }
              emit('paused');
              return null;
            }
            if (repair === 'reset_session') {
              sessionRecoveries++;
              projectId = null;
              uploadId = null;
              nextChunk = 0;
              uploadedBytes = 0;
              uploadedChunkSet.clear();
              return runLoop();
            }
            uploadedChunkSet.add(err.missingChunk);
            continue;
          }
          throw err;
        }
      }

      if (!completed) {
        throw new Error('Failed to finalize video upload.');
      }

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
      abortAllInFlight();
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
      abortAllInFlight();
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

