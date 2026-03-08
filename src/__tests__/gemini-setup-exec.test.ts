import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveForceKillDelayMs, execGemini } from '../infra/gemini/exec.js';
import { isFolderTrusted, addTrustedFolder } from '../infra/gemini/setup.js';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { GeminiCallOptions } from '../infra/gemini/types.js';

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: import('vitest').Mock;
}

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = new EventEmitter() as MockChildProcess;
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();
    return child;
  }),
}));

describe('Gemini CLI setup & exec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveForceKillDelayMs', () => {
    it('should return default when env is not set', () => {
      vi.stubEnv('TAKT_GEMINI_FORCE_KILL_DELAY_MS', undefined as unknown as string);
      expect(resolveForceKillDelayMs()).toBe(1000);
    });

    it('should return parsed number when env is set', () => {
      vi.stubEnv('TAKT_GEMINI_FORCE_KILL_DELAY_MS', '2500');
      expect(resolveForceKillDelayMs()).toBe(2500);
    });

    it('should return default when env is invalid', () => {
      vi.stubEnv('TAKT_GEMINI_FORCE_KILL_DELAY_MS', 'invalid');
      expect(resolveForceKillDelayMs()).toBe(1000);
    });
  });

  describe('isFolderTrusted', () => {
    it('should return true if folder is TRUST_FOLDER', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ '/my/project': 'TRUST_FOLDER' }));
      expect(isFolderTrusted('/my/project')).toBe(true);
    });

    it('should return true if folder is TRUST_PARENT', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ '/my/project': 'TRUST_PARENT' }));
      expect(isFolderTrusted('/my/project')).toBe(true);
    });

    it('should return false if folder is not trusted', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ '/other/project': 'TRUST_FOLDER' }));
      expect(isFolderTrusted('/my/project')).toBe(false);
    });

    it('should return false if file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(isFolderTrusted('/my/project')).toBe(false);
    });
  });

  describe('addTrustedFolder', () => {
    it('should add folder to trustedFolders.json', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      addTrustedFolder('/my/project');
      
      expect(fs.mkdirSync).toHaveBeenCalled();
      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(fs.renameSync).toHaveBeenCalled();
      
      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
      expect(writeCall).toBeDefined();
      if (writeCall) {
        const content = JSON.parse(writeCall[1] as string);
        expect(content['/my/project']).toBe('TRUST_FOLDER');
      }
    });
  });

  describe('execGemini', () => {
    it('should spawn process and resolve on close', async () => {
      const options: GeminiCallOptions = { cwd: '/tmp', onStream: vi.fn() };
      const promise = execGemini(['-p', 'hello'], options);
      const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

      mockChildProcess.stdout.emit('data', '{"type":"message","delta":true,"content":"world"}\n');
      mockChildProcess.emit('close', 0, null);

      const result = await promise;
      expect(result.finalContent).toBe('world');
    });

    it('should reject on process error', async () => {
      const options: GeminiCallOptions = { cwd: '/tmp', onStream: vi.fn() };
      const promise = execGemini(['-p', 'hello'], options);
      const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

      const error = new Error('spawn failed') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockChildProcess.emit('error', error);

      await expect(promise).rejects.toThrow('spawn failed');
    });
  });
});
