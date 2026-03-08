import type { ProviderUsageSnapshot } from '../../core/models/index.js';
import type { GeminiCallOptions } from './types.js';
import { getErrorMessage } from '../../shared/utils/index.js';

export const GEMINI_ABORTED_MESSAGE = 'Gemini execution aborted';
export const GEMINI_CLI_USER_ABORTED_STDERR = 'AbortError: The user aborted a request';
export const GEMINI_ERROR_DETAIL_MAX_LENGTH = 400;

export class GeminiExecError extends Error {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  sessionId?: string;
  providerUsage?: ProviderUsageSnapshot;

  constructor(
    message: string,
    params: {
      code?: string | number;
      stdout?: string;
      stderr?: string;
      signal?: NodeJS.Signals | null;
      name?: string;
      sessionId?: string;
      providerUsage?: ProviderUsageSnapshot;
    } = {},
  ) {
    super(message);
    if (params.name) this.name = params.name;
    this.code = params.code;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.signal = params.signal;
    this.sessionId = params.sessionId;
    this.providerUsage = params.providerUsage;
  }
}

export function isGeminiExecError(error: unknown): error is GeminiExecError {
  return error instanceof GeminiExecError;
}

export function createExecError(
  message: string,
  params: {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals | null;
    name?: string;
    sessionId?: string;
    providerUsage?: ProviderUsageSnapshot;
  } = {},
): GeminiExecError {
  return new GeminiExecError(message, params);
}

export function trimDetail(value: string | undefined, fallback = ''): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return fallback;
  if (normalized.length <= GEMINI_ERROR_DETAIL_MAX_LENGTH) return normalized;
  const half = Math.floor(GEMINI_ERROR_DETAIL_MAX_LENGTH / 2) - 10;
  return `${normalized.slice(0, half)} ... [truncated] ... ${normalized.slice(-half)}`;
}

export function isAuthenticationError(error: GeminiExecError): boolean {
  const message = [error.message, error.stderr, error.stdout].filter(Boolean).join('\n').toLowerCase();
  const patterns = ['authentication', 'unauthorized', 'forbidden', 'api key', 'gemini_api_key', 'google_api_key', 'verify your account', 'login required', 'not logged in', 'sign in'];
  return patterns.some((pattern) => message.includes(pattern));
}

export function maskSensitiveData(text: string): string {
  return text.replace(/\bAIza[0-9A-Za-z-_]{35}\b/g, '***');
}

export function classifyExecutionError(error: GeminiExecError, options: GeminiCallOptions): string {
  if (
    options.abortSignal?.aborted ||
    error.name === 'AbortError' ||
    (error.stderr && error.stderr.includes(GEMINI_CLI_USER_ABORTED_STDERR))
  ) {
    return GEMINI_ABORTED_MESSAGE;
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Gemini CLI output exceeded buffer limit';
  if (error.code === 'ENOENT') return 'gemini binary not found. Install Gemini CLI and ensure `gemini` is in PATH.';
  if (isAuthenticationError(error)) return 'Gemini authentication failed. Run `gemini auth` or set TAKT_GEMINI_API_KEY/gemini_api_key.';
  const detail = maskSensitiveData(trimDetail(error.stderr, getErrorMessage(error)));
  if (error.code === undefined) {
    return detail;
  }
  return `Gemini CLI exited with code ${error.code}: ${detail}`;
}
