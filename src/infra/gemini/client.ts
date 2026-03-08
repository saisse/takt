/**
 * Gemini CLI integration for agent interactions
 */

import type { AgentResponse } from '../../core/models/index.js';
import { getErrorMessage } from '../../shared/utils/index.js';
import { type GeminiCallOptions, getAllowedGeminiTools } from './types.js';
import { classifyExecutionError, isGeminiExecError, createExecError } from './error.js';
import { execGemini } from './exec.js';
import { buildArgs } from './args.js';
import { createPolicyFile, cleanupPolicyFile } from './policy.js';

export type { GeminiCallOptions } from './types.js';

export class GeminiClient {
  async call(agentType: string, prompt: string, options: GeminiCallOptions): Promise<AgentResponse> {
    const allowedGeminiTools = getAllowedGeminiTools(options.allowedTools);
    let policyPath: string | undefined;

    try {
      if (options.allowedTools !== undefined) {
        policyPath = createPolicyFile(allowedGeminiTools);
      }

      const args = buildArgs(prompt, options, policyPath);

      const { finalContent, sessionId, providerUsage } = await execGemini(args, options);
      const resolvedSessionId = sessionId ?? options.sessionId;

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
      const error = isGeminiExecError(rawError) ? rawError : createExecError(getErrorMessage(rawError));
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
        providerUsage: error.providerUsage,
      };
    } finally {
      cleanupPolicyFile(policyPath);
    }
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
