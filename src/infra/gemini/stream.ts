import type { ProviderUsageSnapshot } from '../../core/models/index.js';
import type { GeminiCallOptions } from './types.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const log = createLogger('gemini-stream');

export interface StreamState {
  finalContent: string;
  sessionId?: string;
  hasError: boolean;
  providerUsage?: ProviderUsageSnapshot;
}

export interface GeminiStreamEvent {
  type?: string;
  session_id?: string;
  delta?: boolean;
  content?: string;
  tool_name?: string;
  input?: Record<string, unknown>;
  tool_id?: string;
  output?: string;
  status?: string;
  error?: { message?: string } | string;
  stats?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cached?: number;
  };
}

export function geminiStreamToStreamEvent(
  line: string,
  callback: GeminiCallOptions['onStream'] | undefined,
  streamState: StreamState,
): void {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line) as GeminiStreamEvent;
    const type = event.type;

    if (event.session_id) {
      streamState.sessionId = event.session_id as string;
    }

    if (type === 'message' && event.delta) {
      const text = event.content ?? '';
      streamState.finalContent += text;
      if (callback) callback({ type: 'text', data: { text } });
    } else if (type === 'tool_use' && event.tool_name) {
      if (callback) callback({
        type: 'tool_use',
        data: { tool: event.tool_name, input: event.input ?? {}, id: event.tool_id ?? '' },
      });
    } else if (type === 'tool_result') {
      if (callback) callback({
        type: 'tool_result',
        data: { content: event.output ?? '', isError: event.status === 'error' },
      });
    } else if (event.error) {
      const errorMsg = typeof event.error === 'string' ? event.error : (event.error.message || JSON.stringify(event.error));
      streamState.finalContent = errorMsg;
      streamState.hasError = true;
      if (callback) callback({ type: 'error', data: { message: errorMsg } });
    } else if (type === 'result' && event.status === 'success' && event.stats) {
      const stats = event.stats;
      streamState.providerUsage = {
        inputTokens: stats.input_tokens,
        outputTokens: stats.output_tokens,
        totalTokens: stats.total_tokens,
        cachedInputTokens: stats.cached,
        usageMissing: false,
      };
    }
  } catch (e) {
    log.debug('Failed to parse Gemini stream event line, ignoring.', { line, error: getErrorMessage(e) });
  }
}
