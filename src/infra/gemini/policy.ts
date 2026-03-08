import { writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';

const log = createLogger('gemini-policy');

// Priority 900 ensures these allow rules take effect while leaving room for other overrides
export const ALLOW_RULE_PRIORITY = 900;

export function createPolicyFile(allowedTools: string[]): string | undefined {
  if (allowedTools.length === 0) return undefined;
  
  const toolList = allowedTools.map((t) => JSON.stringify(t)).join(', ');
  const rules = `[[rule]]\ntoolName = [${toolList}]\ndecision = "allow"\npriority = ${ALLOW_RULE_PRIORITY}`;

  const policyPath = join(tmpdir(), `takt-gemini-policy-${randomUUID()}.toml`);
  writeFileSync(policyPath, rules, { encoding: 'utf-8', mode: 0o600 });
  return policyPath;
}

export function cleanupPolicyFile(policyPath?: string): void {
  if (policyPath && existsSync(policyPath)) {
    try {
      rmSync(policyPath, { force: true });
    } catch (e) {
      log.debug(`Failed to clean up temporary policy file ${policyPath}`, getErrorMessage(e));
    }
  }
}
