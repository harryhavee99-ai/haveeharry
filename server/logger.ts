import fs from 'fs';
import path from 'path';
import { DATA_ROOT } from './store.ts';

export const LOGS_DIR = path.join(DATA_ROOT, 'logs');
export const ERROR_LOG_PATH = path.join(LOGS_DIR, 'errors.log');

export interface BackendErrorLogContext {
  uploadId?: string;
  projectId?: string;
  jobId?: string;
  stage?: string;
  httpStatus?: number;
  route?: string;
  error: unknown;
}

/**
 * Strips any potential secrets, bearer tokens, API keys, or stack internals
 * before returning an error message to the browser frontend.
 */
export function sanitizeErrorMessage(err: unknown, fallback = 'An unexpected server error occurred.'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!raw.trim()) return fallback;

  // Unwrap Google API JSON error envelopes into readable user-facing messages
  let clean = raw;
  try {
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) {
      const parsed = JSON.parse(raw.slice(jsonStart)) as {
        error?: { code?: number; message?: string; status?: string };
      };
      if (parsed?.error?.message) {
        const status = parsed.error.status ? ` (${parsed.error.status})` : '';
        clean = `AI service error${status}: ${parsed.error.message}`;
      }
    }
  } catch {
    // not JSON, keep raw text
  }

  // Redact any API key or token patterns
  clean = clean
    .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
    .replace(/key=[A-Za-z0-9\-_]+/gi, 'key=[REDACTED]')
    .replace(/\/app\/applet\/[^\s"']+/g, '[server-path]');

  // Map common Gemini / FFmpeg errors into actionable safe messages
  if (clean.includes('API_KEY_INVALID') || clean.includes('PERMISSION_DENIED') || clean.includes('403')) {
    return 'Gemini API authentication failed (403). Please verify your GEMINI_API_KEY in Settings > Secrets.';
  }
  if (clean.includes('RESOURCE_EXHAUSTED') || clean.includes('429')) {
    return 'AI rate limit reached (429). Please wait a moment and click Retry Processing to resume from the last checkpoint.';
  }
  if (clean.includes('ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
    return 'Video processing output buffer overflowed. Please click Retry Processing to continue.';
  }

  return clean.slice(0, 400);
}

/**
 * Records full diagnostic error details server-side (stderr + persistent JSONL log file)
 * without leaking stack traces or credentials to the client.
 */
export function logBackendError(ctx: BackendErrorLogContext): string {
  const timestamp = new Date().toISOString();
  const actualMessage =
    ctx.error instanceof Error
      ? ctx.error.message
      : typeof ctx.error === 'string'
        ? ctx.error
        : JSON.stringify(ctx.error);
  const stack = ctx.error instanceof Error ? ctx.error.stack : undefined;

  const entry = {
    timestamp,
    uploadId: ctx.uploadId ?? null,
    projectId: ctx.projectId ?? null,
    jobId: ctx.jobId ?? null,
    stage: ctx.stage ?? null,
    httpStatus: ctx.httpStatus ?? 500,
    route: ctx.route ?? null,
    message: actualMessage,
    stack: stack ?? null,
  };

  console.error(
    `[ClipGenius Error] ${timestamp} | route=${entry.route ?? '-'} | stage=${entry.stage ?? '-'} | status=${entry.httpStatus} | project=${entry.projectId ?? '-'} | upload=${entry.uploadId ?? '-'} | job=${entry.jobId ?? '-'} | msg=${actualMessage}`
  );
  if (stack) {
    console.error(stack);
  }

  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(ERROR_LOG_PATH, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {
    // Never throw inside error logger
  }

  return sanitizeErrorMessage(ctx.error);
}
