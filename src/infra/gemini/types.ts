/**
 * Type definitions for Gemini CLI integration
 */

import type { StreamCallback } from '../claude/index.js';
import type { PermissionMode } from '../../core/models/index.js';

/** Options for calling Gemini CLI */
export interface GeminiCallOptions {
  cwd: string;
  abortSignal?: AbortSignal;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: PermissionMode;
  onStream?: StreamCallback;
  geminiApiKey?: string;
  /** Custom path to gemini executable */
  geminiCliPath?: string;
}
