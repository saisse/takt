import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { AskUserQuestionHandler } from '../../core/workflow/types.js';

import { loadEffectiveGeminiSettings } from './settings-loader.js';

const log = createLogger('gemini-setup');

function getTrustPath(): string {
  return process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH ?? join(homedir(), '.gemini', 'trustedFolders.json');
}

/**
 * Checks if folder trust is enabled in Gemini CLI settings.
 * Defaults to true if not specified.
 */
export function isFolderTrustEnabled(cwd: string): boolean {
  const settings = loadEffectiveGeminiSettings(cwd);
  // Gemini CLI schema: security.folderTrust.enabled (defaults to true)
  return settings?.security?.folderTrust?.enabled !== false;
}

/**
 * Checks if the given folder is already trusted by Gemini CLI.
 */
export function isFolderTrusted(folderPath: string): boolean {
  const trustPath = getTrustPath();
  try {
    if (!existsSync(trustPath)) return false;
    const trustMap = JSON.parse(readFileSync(trustPath, 'utf-8')) as Record<string, string>;
    return trustMap[folderPath] === 'TRUST_FOLDER' || trustMap[folderPath] === 'TRUST_PARENT';
  } catch (e) {
    log.debug('Failed to read trustedFolders.json for check:', getErrorMessage(e));
    return false;
  }
}

/**
 * Explicitly adds a folder to ~/.gemini/trustedFolders.json.
 */
export function addTrustedFolder(folderPath: string): void {
  const trustPath = getTrustPath();
  try {
    const trustMap: Record<string, string> = Object.create(null);
    if (existsSync(trustPath)) {
      const parsed = JSON.parse(readFileSync(trustPath, 'utf-8')) as Record<string, string>;
      Object.assign(trustMap, parsed);
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
    log.debug('Failed to update trustedFolders.json:', getErrorMessage(e));
    throw new Error(`Failed to authorize folder for Gemini CLI: ${getErrorMessage(e)}`);
  }
}

/**
 * Ensures the folder is authorized for Gemini CLI, prompting the user if necessary.
 * This should be called during the setup phase.
 */
export async function ensureFolderAuthorized(
  folderPath: string,
  onAskUserQuestion?: AskUserQuestionHandler,
  bypassPermissions?: boolean,
): Promise<void> {
  // If folder trust is disabled in Gemini CLI settings, we don't need to do anything.
  if (!isFolderTrustEnabled(folderPath)) {
    return;
  }

  if (isFolderTrusted(folderPath)) {
    return;
  }

  // If permissions are bypassed (e.g. CI), we don't need to manually authorize
  // because we'll pass the --skip-trust flag to the Gemini CLI.
  if (bypassPermissions) {
    return;
  }

  if (!onAskUserQuestion) {
    throw new Error(
      `Gemini CLI needs permission to access "${folderPath}". Run \`gemini list\` in that directory once to authorize it manually, or provide an interactive session.`,
    );
  }

  const question = `Gemini CLI needs permission to access files in "${folderPath}". Allow this folder?`;
  const answers = await onAskUserQuestion({
    questions: [
      {
        header: 'Security',
        question,
        options: [
          { label: 'Allow', description: 'Add to Gemini trusted folders' },
          { label: 'Deny', description: 'Abort execution' },
        ],
      },
    ],
  });

  if (answers[question] === 'Allow') {
    addTrustedFolder(folderPath);
  } else {
    throw new Error(`Execution aborted: Folder "${folderPath}" is not trusted by Gemini CLI.`);
  }
}

