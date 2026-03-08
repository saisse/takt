/**
 * Type definitions for Gemini CLI integration
 */

import type { StreamCallback } from '../../shared/types/provider.js';
import type { AskUserQuestionHandler } from '../../core/workflow/types.js';
import type { PermissionMode } from '../../core/models/index.js';
import type { ProviderImageAttachment } from '../providers/types.js';

export const BUILTIN_TOOL_MAP: Record<string, string[]> = {
  Read: ['read_file', 'list_directory'],
  Glob: ['glob'],
  Grep: ['grep_search'],
  Edit: ['replace'],
  Write: ['write_file'],
  Bash: ['run_shell_command'],
  WebSearch: ['google_web_search'],
  WebFetch: ['web_fetch'],
};

export const TAKT_MANAGED_GEMINI_TOOLS = Object.values(BUILTIN_TOOL_MAP).flat();

/**
 * Returns the list of Gemini tools that should be explicitly allowed
 * based on the provided allowedTools list from TAKT.
 */
export function getAllowedGeminiTools(allowedTools?: string[]): string[] {
  if (!allowedTools) {
    return [];
  }
  
  const allowedGeminiTools = new Set<string>();
  for (const tool of allowedTools) {
    const mapped = BUILTIN_TOOL_MAP[tool] ?? [tool];
    for (const t of mapped) {
      allowedGeminiTools.add(t);
    }
  }

  return Array.from(allowedGeminiTools);
}

/** Options for calling Gemini CLI */
export interface GeminiCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  onStream?: StreamCallback;
  onAskUserQuestion?: AskUserQuestionHandler;
  geminiApiKey?: string;
  bypassPermissions?: boolean;
  /** Custom path to gemini executable */
  geminiCliPath?: string;
  imageAttachments?: ProviderImageAttachment[];
}

/** Gemini CLI settings structure (minimal) */
export interface GeminiSettings {
  security?: {
    folderTrust?: {
      enabled?: boolean;
    };
  };
}

