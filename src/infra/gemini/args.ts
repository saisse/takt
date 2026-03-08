import type { GeminiCallOptions } from './types.js';
import { createLogger } from '../../shared/utils/index.js';
import { expandImageAttachmentPlaceholders } from '../providers/imageAttachmentPrompt.js';

const log = createLogger('gemini-args');

function buildPrompt(prompt: string, options: GeminiCallOptions): string {
  const expandedPrompt = expandImageAttachmentPlaceholders(prompt, options.imageAttachments);
  if (!options.systemPrompt) {
    return expandedPrompt;
  }
  return `${options.systemPrompt}\n\n${expandedPrompt}`;
}

function resolveApprovalMode(permissionMode?: GeminiCallOptions['permissionMode']): string {
  if (permissionMode === 'full' || permissionMode === 'edit') return 'yolo';
  return 'plan';
}

export function buildArgs(prompt: string, options: GeminiCallOptions, policyPath?: string): string[] {
  log.debug('Building args with final options:', { ...options, geminiApiKey: options.geminiApiKey ? '***' : undefined });

  const args = [
    '-p',
    buildPrompt(prompt, options),
    '--output-format',
    'stream-json',
    '--approval-mode',
    resolveApprovalMode(options.permissionMode),
    '--include-directories',
    '.takt',
  ];
  if (options.imageAttachments) {
    for (const attachment of options.imageAttachments) {
      args.push(attachment.path);
    }
  }
  if (options.model) {
    args.push('-m', options.model);
  }
  if (options.sessionId) {
    args.push('-r', options.sessionId);
  }
  if (options.bypassPermissions) {
    args.push('--skip-trust');
  }
  if (policyPath) {
    args.push('--admin-policy', policyPath);
  }
  return args;
}
