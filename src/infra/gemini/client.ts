/**
 * Gemini CLI integration for agent interactions
 */

import { spawn } from 'node:child_process';
import type { AgentResponse } from '../../core/models/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import type { GeminiCallOptions } from './types.js';

export type { GeminiCallOptions } from './types.js';

const GEMINI_COMMAND = 'gemini';
const GEMINI_ABORTED_MESSAGE = 'Gemini execution aborted';
const GEMINI_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const GEMINI_FORCE_KILL_DELAY_MS_DEFAULT = 1_000;
const GEMINI_ERROR_DETAIL_MAX_LENGTH = 400;

function resolveForceKillDelayMs(): number {
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

type GeminiExecResult = {
  stdout: string;
  stderr: string;
};

type GeminiExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `${systemPrompt}\n\n${prompt}`;
}

function resolveApprovalMode(permissionMode?: GeminiCallOptions['permissionMode']): string {
  if (permissionMode === 'full') return 'yolo';
  if (permissionMode === 'edit') return 'auto_edit';
  return 'plan';
}

function buildArgs(prompt: string, options: GeminiCallOptions): string[] {
  const args = [
    '-p',
    buildPrompt(prompt, options.systemPrompt),
    '-o',
    'json',
    '--approval-mode',
    resolveApprovalMode(options.permissionMode),
  ];

  if (options.model) {
    args.push('-m', options.model);
  }

  if (options.sessionId) {
    args.push('-r', options.sessionId);
  }

  return args;
}

function buildEnv(geminiApiKey?: string): NodeJS.ProcessEnv {
  if (!geminiApiKey) {
    return process.env;
  }

  return {
    ...process.env,
    GEMINI_API_KEY: geminiApiKey,
  };
}

function createExecError(
  message: string,
  params: {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals | null;
    name?: string;
  } = {},
): GeminiExecError {
  const error = new Error(message) as GeminiExecError;
  if (params.name) {
    error.name = params.name;
  }
  error.code = params.code;
  error.stdout = params.stdout;
  error.stderr = params.stderr;
  error.signal = params.signal;
  return error;
}

function execGemini(args: string[], options: GeminiCallOptions): Promise<GeminiExecResult> {
  return new Promise<GeminiExecResult>((resolve, reject) => {
    const child = spawn(options.geminiCliPath ?? GEMINI_COMMAND, args, {
      cwd: options.cwd,
      env: buildEnv(options.geminiApiKey),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;

    const abortHandler = (): void => {
      if (settled) return;
      child.kill('SIGTERM');
      const forceKillDelayMs = resolveForceKillDelayMs();
      abortTimer = setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, forceKillDelayMs);
      abortTimer.unref?.();
    };

    const cleanup = (): void => {
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
      }
      if (options.abortSignal) {
        options.abortSignal.removeEventListener('abort', abortHandler);
      }
    };

    const resolveOnce = (result: GeminiExecResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const rejectOnce = (error: GeminiExecError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const appendChunk = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      const byteLength = Buffer.byteLength(text);

      if (target === 'stdout') {
        stdoutBytes += byteLength;
        if (stdoutBytes > GEMINI_MAX_BUFFER_BYTES) {
          child.kill('SIGTERM');
          rejectOnce(createExecError('gemini stdout exceeded buffer limit', {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            stdout,
            stderr,
          }));
          return;
        }
        stdout += text;
        return;
      }

      stderrBytes += byteLength;
      if (stderrBytes > GEMINI_MAX_BUFFER_BYTES) {
        child.kill('SIGTERM');
        rejectOnce(createExecError('gemini stderr exceeded buffer limit', {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
          stdout,
          stderr,
        }));
        return;
      }
      stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer | string) => appendChunk('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => appendChunk('stderr', chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      rejectOnce(createExecError(error.message, {
        code: error.code,
        stdout,
        stderr,
      }));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;

      if (options.abortSignal?.aborted) {
        rejectOnce(createExecError(GEMINI_ABORTED_MESSAGE, {
          name: 'AbortError',
          stdout,
          stderr,
          signal,
        }));
        return;
      }

      if (code === 0) {
        resolveOnce({ stdout, stderr });
        return;
      }

      rejectOnce(createExecError(
        signal
          ? `gemini terminated by signal ${signal}`
          : `gemini exited with code ${code ?? 'unknown'}`,
        {
          code: code ?? undefined,
          stdout,
          stderr,
          signal,
        },
      ));
    });

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        abortHandler();
      } else {
        options.abortSignal.addEventListener('abort', abortHandler, { once: true });
      }
    }
  });
}

function trimDetail(value: string | undefined, fallback = ''): string {
  const normalized = (value ?? '').trim();
  if (!normalized) {
    return fallback;
  }
  return normalized.length > GEMINI_ERROR_DETAIL_MAX_LENGTH
    ? `${normalized.slice(0, GEMINI_ERROR_DETAIL_MAX_LENGTH)}...`
    : normalized;
}

function isAuthenticationError(error: GeminiExecError): boolean {
  const message = [
    trimDetail(error.message),
    trimDetail(error.stderr),
    trimDetail(error.stdout),
  ].join('\n').toLowerCase();

  const patterns = [
    'authentication',
    'unauthorized',
    'forbidden',
    'api key',
    'gemini_api_key',
    'google_api_key',
    'verify your account',
    'login required',
    'not logged in',
    'sign in',
  ];
  return patterns.some((pattern) => message.includes(pattern));
}

function classifyExecutionError(error: GeminiExecError, options: GeminiCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return GEMINI_ABORTED_MESSAGE;
  }

  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return 'Gemini CLI output exceeded buffer limit';
  }

  if (error.code === 'ENOENT') {
    return 'gemini binary not found. Install Gemini CLI and ensure `gemini` is in PATH.';
  }

  if (isAuthenticationError(error)) {
    return 'Gemini authentication failed. Run `gemini auth` or set TAKT_GEMINI_API_KEY/gemini_api_key.';
  }

  if (typeof error.code === 'number') {
    const detail = trimDetail(error.stderr, trimDetail(error.stdout, getErrorMessage(error)));
    return `Gemini CLI exited with code ${error.code}: ${detail}`;
  }

  return getErrorMessage(error);
}

type ParsedGeminiOutput =
  | { content: string; sessionId?: string }
  | { error: string };

function parseGeminiOutput(stdout: string): ParsedGeminiOutput {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { error: 'gemini returned empty output' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      error: `Failed to parse gemini JSON output: ${trimDetail(trimmed, '<empty>')}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      error: `Unexpected gemini JSON output shape: ${trimDetail(trimmed, '<empty>')}`,
    };
  }

  const record = parsed as Record<string, unknown>;

  if (record.error && typeof record.error === 'object') {
    const err = record.error as Record<string, unknown>;
    const msg = typeof err.message === 'string' ? err.message : JSON.stringify(err);
    return { error: `gemini reported error: ${trimDetail(msg)}` };
  }

  const content = typeof record.response === 'string' ? record.response.trim() : undefined;
  if (!content) {
    return {
      error: `Failed to extract response from gemini JSON output: ${trimDetail(trimmed, '<empty>')}`,
    };
  }

  const sessionId = typeof record.session_id === 'string' && record.session_id.trim()
    ? record.session_id.trim()
    : undefined;

  return { content, sessionId };
}

/**
 * Client for Gemini CLI interactions.
 */
export class GeminiClient {
  async call(agentType: string, prompt: string, options: GeminiCallOptions): Promise<AgentResponse> {
    const args = buildArgs(prompt, options);

    try {
      const { stdout } = await execGemini(args, options);
      const parsed = parseGeminiOutput(stdout);
      if ('error' in parsed) {
        return {
          persona: agentType,
          status: 'error',
          content: parsed.error,
          timestamp: new Date(),
          sessionId: options.sessionId,
        };
      }

      const sessionId = parsed.sessionId ?? options.sessionId;
      if (options.onStream) {
        options.onStream({ type: 'text', data: { text: parsed.content } });
        options.onStream({
          type: 'result',
          data: {
            result: parsed.content,
            success: true,
            sessionId: sessionId ?? '',
          },
        });
      }

      return {
        persona: agentType,
        status: 'done',
        content: parsed.content,
        timestamp: new Date(),
        sessionId,
      };
    } catch (rawError) {
      const error = rawError as GeminiExecError;
      const message = classifyExecutionError(error, options);
      if (options.onStream) {
        options.onStream({
          type: 'result',
          data: {
            result: '',
            success: false,
            error: message,
            sessionId: options.sessionId ?? '',
          },
        });
      }
      return {
        persona: agentType,
        status: 'error',
        content: message,
        timestamp: new Date(),
        sessionId: options.sessionId,
      };
    }
  }

  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: GeminiCallOptions,
  ): Promise<AgentResponse> {
    return this.call(agentName, prompt, {
      ...options,
      systemPrompt,
    });
  }
}

const defaultClient = new GeminiClient();

export async function callGemini(
  agentType: string,
  prompt: string,
  options: GeminiCallOptions,
): Promise<AgentResponse> {
  return defaultClient.call(agentType, prompt, options);
}

export async function callGeminiCustom(
  agentName: string,
  prompt: string,
  systemPrompt: string,
  options: GeminiCallOptions,
): Promise<AgentResponse> {
  return defaultClient.callCustom(agentName, prompt, systemPrompt, options);
}
