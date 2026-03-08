import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import type { GeminiSettings } from './types.js';

const log = createLogger('gemini-settings');

/**
 * Merges source into target recursively (simple deep merge for GeminiSettings)
 */
function deepMerge<T>(target: T | undefined | null, source: Partial<T> | undefined | null): T {
  if (!source) return (target || {}) as T;
  if (!target) return source as T;

  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source)) {
    const sourceValue = (source as Record<string, unknown>)[key];
    const targetValue = result[key];

    if (
      sourceValue instanceof Object &&
      !Array.isArray(sourceValue) &&
      targetValue instanceof Object &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue,
        sourceValue
      );
    } else {
      result[key] = sourceValue;
    }
  }
  return result as T;
}

/**
 * Finds the project-level settings.json by searching upwards from cwd.
 */
function findProjectSettingsPath(cwd: string): string | undefined {
  let current = cwd;
  while (true) {
    const p = join(current, '.gemini', 'settings.json');
    if (existsSync(p)) return p;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

/**
 * Reads a settings file if it exists.
 */
function readSettingsFile(path: string): GeminiSettings | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    log.debug(`Failed to read settings from ${path}:`, getErrorMessage(e));
    return undefined;
  }
}

/**
 * Loads effective Gemini CLI settings by merging configurations from multiple layers
 * according to the precedence rules (System Overrides > Project > User > System Defaults).
 */
export function loadEffectiveGeminiSettings(cwd: string): GeminiSettings {
  const isMac = process.platform === 'darwin';
  
  const systemPath = isMac
    ? '/Library/Application Support/GeminiCli/settings.json'
    : '/etc/gemini-cli/settings.json';
    
  const systemDefaultPath = isMac
    ? '/Library/Application Support/GeminiCli/system-defaults.json'
    : '/etc/gemini-cli/system-defaults.json';
    
  const userPath = join(homedir(), '.gemini', 'settings.json');
  const projectPath = findProjectSettingsPath(cwd);

  // Lowest precedence to highest
  let settings: GeminiSettings = {};

  // 1. System Defaults
  const systemDefaults = readSettingsFile(systemDefaultPath);
  if (systemDefaults) settings = deepMerge(settings, systemDefaults);

  // 2. User Settings
  const userSettings = readSettingsFile(userPath);
  if (userSettings) settings = deepMerge(settings, userSettings);

  // 3. Project Settings
  if (projectPath) {
    const projectSettings = readSettingsFile(projectPath);
    if (projectSettings) settings = deepMerge(settings, projectSettings);
  }

  // 4. System Overrides
  const systemOverrides = readSettingsFile(systemPath);
  if (systemOverrides) settings = deepMerge(settings, systemOverrides);

  return settings;
}
