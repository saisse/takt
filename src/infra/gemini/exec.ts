import type { ChildProcess } from 'node:child_process';
import { crossSpawn } from '../../shared/utils/index.js';
import type { ProviderUsageSnapshot } from '../../core/models/index.js';
import type { GeminiCallOptions } from './types.js';
import { createExecError, GEMINI_ABORTED_MESSAGE } from './error.js';
import { geminiStreamToStreamEvent, type StreamState } from './stream.js';

export const GEMINI_COMMAND = 'gemini';
const GEMINI_FORCE_KILL_DELAY_MS_DEFAULT = 1_000;

export type ExecGeminiResult = {
  finalContent: string;
  sessionId?: string;
  stderr: string;
  providerUsage?: ProviderUsageSnapshot;
};

export function resolveForceKillDelayMs(): number {
  const raw = process.env.TAKT_GEMINI_FORCE_KILL_DELAY_MS;
  if (!raw) {
    return GEMINI_FORCE_KILL_DELAY_MS_DEFAULT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return GEMINI_FORCE_KILL_DELAY_MS_DEFAULT;
  }
  return parsed;
}

function buildEnv(geminiApiKey?: string): NodeJS.ProcessEnv {
  if (!geminiApiKey) {
    return process.env;
  }
  return { ...process.env, GEMINI_API_KEY: geminiApiKey };
}

function setupStreamHandlers(
  child: ChildProcess,
  options: GeminiCallOptions,
  streamState: StreamState,
  onStderr: (data: string) => void,
): { getBuffer: () => string } {
  let buffer = '';

  child.stdout?.on('data', (chunk: Buffer | string) => {
    const chunkStr = chunk.toString('utf-8');
    buffer += chunkStr;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (line.trim()) {
        geminiStreamToStreamEvent(line, options.onStream, streamState);
      }
    }
  });

  child.stderr?.on('data', (chunk: Buffer | string) => {
    onStderr(chunk.toString('utf-8'));
  });

  return { getBuffer: () => buffer };
}

function setupProcessLifecycle(
  child: ChildProcess,
  options: GeminiCallOptions,
  streamState: StreamState,
  getBuffer: () => string,
  getStderr: () => string,
  resolve: (value: ExecGeminiResult) => void,
  reject: (reason?: unknown) => void,
): void {
  let settled = false;
  let abortTimer: NodeJS.Timeout | undefined;

  const abortHandler = (): void => {
    if (settled) return;
    child.kill('SIGTERM');
    const forceKillDelayMs = resolveForceKillDelayMs();
    abortTimer = setTimeout(() => {
      if (!settled) child.kill('SIGKILL');
    }, forceKillDelayMs);
    abortTimer.unref?.();
  };

  const cleanup = (): void => {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    if (options.abortSignal) options.abortSignal.removeEventListener('abort', abortHandler);
  };

  const resolveOnce = (result: ExecGeminiResult): void => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve(result);
  };

  const rejectOnce = (error: Error): void => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };

  child.on('error', (error: NodeJS.ErrnoException) => {
    rejectOnce(createExecError(error.message, { code: error.code, stderr: getStderr(), sessionId: streamState.sessionId }));
  });

  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (settled) return;
    const buffer = getBuffer();
    if (buffer.trim()) geminiStreamToStreamEvent(buffer, options.onStream, streamState);
    if (options.abortSignal?.aborted) {
      rejectOnce(createExecError(GEMINI_ABORTED_MESSAGE, { name: 'AbortError', stderr: getStderr(), signal, sessionId: streamState.sessionId }));
      return;
    }
    if (code === 0 && !streamState.hasError) {
      resolveOnce({
        finalContent: streamState.finalContent,
        sessionId: streamState.sessionId ?? options.sessionId,
        stderr: getStderr(),
        providerUsage: streamState.providerUsage,
      });
    } else {
      const errorMessage = streamState.hasError ? streamState.finalContent : getStderr();
      rejectOnce(
        createExecError(signal ? `gemini terminated by signal ${signal}` : (code === null ? 'gemini exited without code' : `gemini exited with code ${code}`), {
          code: code ?? undefined,
          stderr: errorMessage,
          signal,
          sessionId: streamState.sessionId ?? options.sessionId,
          providerUsage: streamState.providerUsage,
        }),
      );
    }
  });

  if (options.abortSignal) {
    if (options.abortSignal.aborted) abortHandler();
    else options.abortSignal.addEventListener('abort', abortHandler, { once: true });
  }
}

export function execGemini(
  args: string[],
  options: GeminiCallOptions,
): Promise<ExecGeminiResult> {
  return new Promise<ExecGeminiResult>((resolve, reject) => {
    const child = crossSpawn(options.geminiCliPath ?? GEMINI_COMMAND, args, {
      cwd: options.cwd,
      env: buildEnv(options.geminiApiKey),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const streamState: StreamState = { finalContent: '', hasError: false, sessionId: options.sessionId };
    let stderr = '';

    const { getBuffer } = setupStreamHandlers(child, options, streamState, (data) => {
      stderr += data;
    });

    setupProcessLifecycle(child, options, streamState, getBuffer, () => stderr, resolve, reject);
  });
}
