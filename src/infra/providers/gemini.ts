/**
 * Gemini provider implementation
 */

import { callGemini, callGeminiCustom, type GeminiCallOptions } from '../gemini/index.js';
import { resolveGeminiApiKey, resolveGeminiCliPath } from '../config/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const log = createLogger('gemini-provider');

function toGeminiOptions(options: ProviderCallOptions): GeminiCallOptions {
  if (options.allowedTools && options.allowedTools.length > 0) {
    log.info('Gemini provider does not support allowedTools; ignoring');
  }
  if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
    log.info('Gemini provider does not support mcpServers; ignoring');
  }
  if (options.outputSchema) {
    log.info('Gemini provider does not support outputSchema; ignoring');
  }

  return {
    cwd: options.cwd,
    abortSignal: options.abortSignal,
    sessionId: options.sessionId,
    model: options.model,
    permissionMode: options.permissionMode,
    onStream: options.onStream,
    geminiApiKey: options.geminiApiKey ?? resolveGeminiApiKey(),
    geminiCliPath: resolveGeminiCliPath(),
  };
}

/** Gemini provider — delegates to Gemini CLI */
export class GeminiProvider implements Provider {
  setup(config: AgentSetup): ProviderAgent {
    if (config.claudeAgent) {
      throw new Error('Claude Code agent calls are not supported by the Gemini provider');
    }
    if (config.claudeSkill) {
      throw new Error('Claude Code skill calls are not supported by the Gemini provider');
    }

    const { name, systemPrompt } = config;
    if (systemPrompt) {
      return {
        call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
          return callGeminiCustom(name, prompt, systemPrompt, toGeminiOptions(options));
        },
      };
    }

    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        return callGemini(name, prompt, toGeminiOptions(options));
      },
    };
  }
}
