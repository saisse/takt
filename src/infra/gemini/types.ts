/**
 * Type definitions for Gemini CLI integration
 */

import type { StreamCallback } from '../claude/index.js';
import type { PermissionMode } from '../../core/models/index.js';

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
 * Returns the list of TAKT-managed Gemini tools that should be explicitly denied
 * based on the provided allowedTools list.
 */
export function getDeniedGeminiTools(allowedTools?: string[]): string[] {
  if (!allowedTools) {
    // If undefined, do not deny anything
    return [];
  }
  
  const allowedGeminiTools = new Set<string>();
  for (const tool of allowedTools) {
    const mapped = BUILTIN_TOOL_MAP[tool] ?? [tool];
    for (const t of mapped) {
      allowedGeminiTools.add(t);
    }
  }

  // Deny any managed tool that is not in the allowed list
  return TAKT_MANAGED_GEMINI_TOOLS.filter((tool) => !allowedGeminiTools.has(tool));
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
  geminiApiKey?: string;
  /** Custom path to gemini executable */
  geminiCliPath?: string;
}
