/**
 * Gemini provider implementation
 */

import { callGemini, type GeminiCallOptions, ensureFolderAuthorized } from '../gemini/index.js';
import { resolveGeminiApiKey, resolveGeminiCliPath } from '../config/index.js';
import { createLogger } from '../../shared/utils/index.js';
import type { AgentResponse } from '../../core/models/index.js';
import type { AgentSetup, Provider, ProviderAgent, ProviderCallOptions } from './types.js';

const log = createLogger('gemini-provider');

function toGeminiOptions(options: ProviderCallOptions): GeminiCallOptions {
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
    allowedTools: options.providerOptions?.gemini?.allowedTools ?? options.allowedTools,
    onStream: options.onStream,
    geminiApiKey: options.geminiApiKey ?? resolveGeminiApiKey(),
    bypassPermissions: options.bypassPermissions,
    geminiCliPath: resolveGeminiCliPath(),
    imageAttachments: options.imageAttachments,
  };
}

/** Gemini provider — delegates to Gemini CLI */
export class GeminiProvider implements Provider {
  readonly supportsStructuredOutput = false;
  readonly supportsNativeImageInput = true;

  async preflight(options: ProviderCallOptions): Promise<void> {
    await ensureFolderAuthorized(options.cwd, options.onAskUserQuestion, options.bypassPermissions);
  }

  setup(config: AgentSetup): ProviderAgent {
    const { name, systemPrompt } = config;
    return {
      call: async (prompt: string, options: ProviderCallOptions): Promise<AgentResponse> => {
        const geminiOptions = toGeminiOptions(options);
        if (systemPrompt) {
          geminiOptions.systemPrompt = systemPrompt;
        }
        return callGemini(name, prompt, geminiOptions);
      },
    };
  }
}
