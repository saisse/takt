/**
 * Gemini CLI integration for agent interactions
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AgentResponse, ProviderUsageSnapshot } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { type GeminiCallOptions, getDeniedGeminiTools } from './types.js';

export type { GeminiCallOptions } from './types.js';

const log = createLogger('gemini-client');
const GEMINI_COMMAND = 'gemini';
const GEMINI_ABORTED_MESSAGE = 'Gemini execution aborted';
const GEMINI_FORCE_KILL_DELAY_MS_DEFAULT = 1_000;
const GEMINI_ERROR_DETAIL_MAX_LENGTH = 400;

/**
 * Ensure the given folder is added to ~/.gemini/trustedFolders.json
 * to prevent Gemini CLI from prompting for confirmation in non-interactive mode.
 */
function ensureTrustedFolder(folderPath: string): void {
  const trustPath = join(homedir(), '.gemini', 'trustedFolders.json');
  try {
    let trustMap: Record<string, string> = {};
    if (existsSync(trustPath)) {
      trustMap = JSON.parse(readFileSync(trustPath, 'utf-8'));
    }

    if (trustMap[folderPath] !== 'TRUST_FOLDER' && trustMap[folderPath] !== 'TRUST_PARENT') {
      trustMap[folderPath] = 'TRUST_FOLDER';
      const dir = dirname(trustPath);
      mkdirSync(dir, { recursive: true });

      const tempPath = `${trustPath}.${randomUUID()}.tmp`;
      writeFileSync(tempPath, JSON.stringify(trustMap, null, 2), 'utf-8');
      renameSync(tempPath, trustPath);

      log.debug('Added folder to trustedFolders.json:', folderPath);
    }
  } catch (e) {
    // We don't want to block execution if this fails, but it's good to log
    log.debug('Failed to update trustedFolders.json:', getErrorMessage(e));
  }
}

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

type GeminiExecError = Error & {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  sessionId?: string;
};

function buildPrompt(prompt: string, systemPrompt?: string): string {
  if (!systemPrompt) {
    return prompt;
  }
  return `${systemPrompt}${String.fromCharCode(10)}${String.fromCharCode(10)}${prompt}`;
}

function resolveApprovalMode(permissionMode?: GeminiCallOptions['permissionMode']): string {
  if (permissionMode === 'full' || permissionMode === 'edit') return 'yolo';
  return 'plan';
}

function buildArgs(prompt: string, options: GeminiCallOptions): string[] {
  log.debug('Building args with final options:', options);

  const args = [
    '-p',
    buildPrompt(prompt, options.systemPrompt),
    '--output-format',
    'stream-json',
    '--approval-mode',
    resolveApprovalMode(options.permissionMode),
    '--include-directories',
    '.takt',
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
  return { ...process.env, GEMINI_API_KEY: geminiApiKey };
}

function createExecError(
  message: string,
  params: {
    code?: string | number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals | null;
    name?: string;
    sessionId?: string;
  } = {},
): GeminiExecError {
  const error = new Error(message) as GeminiExecError;
  if (params.name) error.name = params.name;
  error.code = params.code;
  error.stdout = params.stdout;
  error.stderr = params.stderr;
  error.signal = params.signal;
  error.sessionId = params.sessionId;
  return error;
}

function execGemini(
  args: string[],
  options: GeminiCallOptions,
): Promise<ExecGeminiResult> {
  if (options.cwd) {
    ensureTrustedFolder(options.cwd);
  }

  return new Promise<ExecGeminiResult>((resolve, reject) => {
    const child = spawn(options.geminiCliPath ?? GEMINI_COMMAND, args, {
      cwd: options.cwd,
      env: buildEnv(options.geminiApiKey),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buffer = '';
    let stderr = '';
    const streamState: StreamState = { finalContent: '', hasError: false, sessionId: options.sessionId };
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

    const rejectOnce = (error: GeminiExecError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      const chunkStr = chunk.toString('utf-8');
      // process.stderr.write(`[RAW_STDOUT_CHUNK]: ${chunkStr}${String.fromCharCode(10)}`);
      buffer += chunkStr;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf(String.fromCharCode(10))) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim()) {
          geminiStreamToStreamEvent(line, options.onStream, streamState);
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      rejectOnce(createExecError(error.message, { code: error.code, stderr, sessionId: streamState.sessionId }));
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      if (buffer.trim()) geminiStreamToStreamEvent(buffer, options.onStream, streamState);
      if (options.abortSignal?.aborted) {
        rejectOnce(createExecError(GEMINI_ABORTED_MESSAGE, { name: 'AbortError', stderr, signal, sessionId: streamState.sessionId }));
        return;
      }
      if (code === 0 && !streamState.hasError) {
        resolveOnce({
          finalContent: streamState.finalContent,
          sessionId: streamState.sessionId ?? options.sessionId,
          stderr,
          hasError: false,
          providerUsage: streamState.providerUsage,
        });
      } else {
        const errorMessage = streamState.hasError ? streamState.finalContent : stderr;
        rejectOnce(
          createExecError(signal ? `gemini terminated by signal ${signal}` : `gemini exited with code ${code ?? 'unknown'}`, {
            code: code ?? 1,
            stderr: errorMessage,
            signal,
            sessionId: streamState.sessionId ?? options.sessionId,
          }),
        );
      }
    });

    if (options.abortSignal) {
      if (options.abortSignal.aborted) abortHandler();
      else options.abortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  });
}

function trimDetail(value: string | undefined, fallback = ''): string {
  const normalized = (value ?? '').trim();
  if (!normalized) return fallback;
  if (normalized.length <= GEMINI_ERROR_DETAIL_MAX_LENGTH) return normalized;
  const half = Math.floor(GEMINI_ERROR_DETAIL_MAX_LENGTH / 2) - 10;
  return `${normalized.slice(0, half)} ... [truncated] ... ${normalized.slice(-half)}`;
}

function isAuthenticationError(error: GeminiExecError): boolean {
  const message = [error.message, error.stderr, error.stdout].filter(Boolean).join(String.fromCharCode(10)).toLowerCase();
  const patterns = ['authentication', 'unauthorized', 'forbidden', 'api key', 'gemini_api_key', 'google_api_key', 'verify your account', 'login required', 'not logged in', 'sign in'];
  return patterns.some((pattern) => message.includes(pattern));
}

function classifyExecutionError(error: GeminiExecError, options: GeminiCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') return GEMINI_ABORTED_MESSAGE;
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Gemini CLI output exceeded buffer limit';
  if (error.code === 'ENOENT') return 'gemini binary not found. Install Gemini CLI and ensure `gemini` is in PATH.';
  if (isAuthenticationError(error)) return 'Gemini authentication failed. Run `gemini auth` or set TAKT_GEMINI_API_KEY/gemini_api_key.';
  const detail = trimDetail(error.stderr, getErrorMessage(error));
  return `Gemini CLI exited with code ${error.code ?? 'unknown'}: ${detail}`;
}

export class GeminiClient {
  async call(agentType: string, prompt: string, options: GeminiCallOptions): Promise<AgentResponse> {
    const args = buildArgs(prompt, options);
    const deniedTools = getDeniedGeminiTools(options.allowedTools);
    let policyPath: string | undefined;

    try {
      if (options.allowedTools !== undefined && deniedTools.length > 0) {
        // Generate a dynamic TOML policy to block specified tools
        const rules = deniedTools.map((toolName) => (
          `[[rule]]\ntoolName = "${toolName}"\ndecision = "deny"\npriority = 998`
        )).join('\n\n');
        
        policyPath = join(tmpdir(), `takt-gemini-policy-${randomUUID()}.toml`);
        writeFileSync(policyPath, rules, 'utf-8');
        args.push('--admin-policy', policyPath);
      }

      const { finalContent, sessionId, hasError, providerUsage } = await execGemini(args, options);
      const resolvedSessionId = sessionId ?? options.sessionId;

      if (hasError) {
        return {
          persona: agentType,
          status: 'error',
          content: finalContent,
          timestamp: new Date(),
          sessionId: resolvedSessionId,
          providerUsage,
        };
      }
      if (options.onStream) {
        options.onStream({
          type: 'result',
          data: {
            result: finalContent,
            success: true,
            sessionId: resolvedSessionId ?? '',
          },
        });
      }
      return {
        persona: agentType,
        status: 'done',
        content: finalContent,
        timestamp: new Date(),
        sessionId: resolvedSessionId,
        providerUsage,
      };
    } catch (rawError) {
      const error = rawError as GeminiExecError;
      const message = classifyExecutionError(error, options);
      const resolvedSessionId = error.sessionId ?? options.sessionId;
      if (options.onStream) {
        options.onStream({
          type: 'result',
          data: { result: '', success: false, error: message, sessionId: resolvedSessionId ?? '' },
        });
      }
      return {
        persona: agentType,
        status: 'error',
        content: message,
        timestamp: new Date(),
        sessionId: resolvedSessionId,
      };
    } finally {
      if (policyPath && existsSync(policyPath)) {
        try {
          rmSync(policyPath, { force: true });
        } catch (e) {
          log.debug(`Failed to clean up temporary policy file ${policyPath}`, getErrorMessage(e));
        }
      }
    }
  }

  async callCustom(
    agentName: string,
    prompt: string,
    systemPrompt: string,
    options: GeminiCallOptions,
  ): Promise<AgentResponse> {
    return this.call(agentName, prompt, { ...options, systemPrompt });
  }
}

type ExecGeminiResult = {
  finalContent: string;
  sessionId?: string;
  stderr: string;
  hasError: boolean;
  providerUsage?: ProviderUsageSnapshot;
};

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

interface StreamState {
  finalContent: string;
  sessionId?: string;
  hasError: boolean;
  providerUsage?: ProviderUsageSnapshot;
}

function geminiStreamToStreamEvent(
  line: string,
  callback: GeminiCallOptions['onStream'] | undefined,
  streamState: StreamState,
): void {
  if (!callback || !line.trim()) return;
  try {
    const event = JSON.parse(line);
    const type = event.type;

    if (event.session_id) {
      streamState.sessionId = event.session_id as string;
    }

    if (type === 'init' && event.session_id) {
      // Handled by common session_id check above
    } else if (type === 'message' && event.delta) {
      const text = event.content ?? '';
      streamState.finalContent += text;
      callback({ type: 'text', data: { text } });
    } else if (type === 'tool_use' && event.tool_name) {
      callback({
        type: 'tool_use',
        data: { tool: event.tool_name, input: event.input ?? {}, id: event.tool_id ?? '' },
      });
    } else if (type === 'tool_result') {
      callback({
        type: 'tool_result',
        data: { content: event.output ?? '', isError: event.status === 'error' },
      });
    } else if (event.error) {
      const errorMsg = (event.error.message || JSON.stringify(event.error)) as string;
      streamState.finalContent = errorMsg;
      streamState.hasError = true;
      callback({ type: 'result', data: { result: '', success: false, error: errorMsg, sessionId: streamState.sessionId as string } });
    } else if (type === 'result' && event.status === 'success' && event.stats) {
      const stats = event.stats;
      streamState.providerUsage = {
        inputTokens: stats.input_tokens,
        outputTokens: stats.output_tokens,
        totalTokens: stats.total_tokens,
        cachedInputTokens: stats.cached,
        cacheCreationInputTokens: stats.cached,
        cacheReadInputTokens: stats.cached,
        usageMissing: false,
      };
    }
  } catch (e) {
    log.debug('Failed to parse Gemini stream event line, ignoring.', { line, error: getErrorMessage(e) });
  }
}
