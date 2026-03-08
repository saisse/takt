/**
 * Tests for Gemini CLI client
 */

import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

import { callGemini } from '../infra/gemini/client.js';

type SpawnScenario = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Partial<NodeJS.ErrnoException> & { message: string };
};

type MockChildProcess = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockChildProcess(): MockChildProcess {
  const child = new EventEmitter() as MockChildProcess;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

function mockSpawnWithScenario(scenario: SpawnScenario): void {
  mockSpawn.mockImplementation((_cmd: string, _args: string[], _options: object) => {
    const child = createMockChildProcess();

    queueMicrotask(() => {
      if (scenario.stdout) {
        child.stdout.emit('data', Buffer.from(scenario.stdout, 'utf-8'));
      }
      if (scenario.stderr) {
        child.stderr.emit('data', Buffer.from(scenario.stderr, 'utf-8'));
      }

      if (scenario.error) {
        const error = Object.assign(new Error(scenario.error.message), scenario.error);
        child.emit('error', error);
        return;
      }

      child.emit('close', scenario.code ?? 0, scenario.signal ?? null);
    });

    return child;
  });
}

describe('callGemini', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_API_KEY;
  });

  it('should invoke gemini with required args and map model/session/permission', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ response: 'done output', session_id: 'sess-new' }),
      code: 0,
    });

    const result = await callGemini('coder', 'implement feature', {
      cwd: '/repo',
      model: 'gemini-2.5-pro',
      sessionId: 'sess-prev',
      permissionMode: 'full',
      geminiApiKey: 'gemini-key',
    });

    expect(result.status).toBe('done');
    expect(result.content).toBe('done output');
    expect(result.sessionId).toBe('sess-new');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv; stdio?: unknown }];

    expect(command).toBe('gemini');
    expect(args).toContain('-p');
    expect(args).toContain('implement feature');
    expect(args).toContain('-o');
    expect(args).toContain('json');
    expect(args).toContain('-m');
    expect(args).toContain('gemini-2.5-pro');
    expect(args).toContain('-r');
    expect(args).toContain('sess-prev');
    expect(args).toContain('--approval-mode');
    expect(args).toContain('yolo');
    expect(options.env?.GEMINI_API_KEY).toBe('gemini-key');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('should use auto_edit approval mode for edit permission', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ response: 'result' }),
      code: 0,
    });

    await callGemini('coder', 'task', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const approvalModeIndex = args.indexOf('--approval-mode');
    expect(approvalModeIndex).toBeGreaterThanOrEqual(0);
    expect(args[approvalModeIndex + 1]).toBe('auto_edit');
  });

  it('should use plan approval mode for readonly permission', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ response: 'result' }),
      code: 0,
    });

    await callGemini('coder', 'task', {
      cwd: '/repo',
      permissionMode: 'readonly',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const approvalModeIndex = args.indexOf('--approval-mode');
    expect(args[approvalModeIndex + 1]).toBe('plan');
  });

  it('should not inject GEMINI_API_KEY when geminiApiKey is undefined', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ response: 'done' }),
      code: 0,
    });

    await callGemini('coder', 'task', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    const [, , options] = mockSpawn.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(options.env?.GEMINI_API_KEY).toBeUndefined();
  });

  it('should return error status when gemini returns error field in JSON', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ error: { message: 'Quota exceeded', type: 'QuotaError' } }),
      code: 0,
    });

    const result = await callGemini('coder', 'task', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('Quota exceeded');
  });

  it('should return error status when gemini exits with non-zero code', async () => {
    mockSpawnWithScenario({
      stderr: 'fatal error',
      code: 1,
    });

    const result = await callGemini('coder', 'task', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('1');
  });

  it('should return error status when gemini binary is not found', async () => {
    mockSpawnWithScenario({
      error: { message: 'spawn gemini ENOENT', code: 'ENOENT' },
    });

    const result = await callGemini('coder', 'task', {
      cwd: '/repo',
      permissionMode: 'edit',
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('gemini binary not found');
  });

  it('should use custom geminiCliPath when specified', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ response: 'done' }),
      code: 0,
    });

    await callGemini('coder', 'task', {
      cwd: '/repo',
      permissionMode: 'edit',
      geminiCliPath: '/custom/path/gemini',
    });

    const [command] = mockSpawn.mock.calls[0] as [string];
    expect(command).toBe('/custom/path/gemini');
  });

  it('should prepend system prompt to user prompt', async () => {
    mockSpawnWithScenario({
      stdout: JSON.stringify({ response: 'done' }),
      code: 0,
    });

    await callGemini('coder', 'user task', {
      cwd: '/repo',
      permissionMode: 'edit',
      systemPrompt: 'You are a coder.',
    });

    const [, args] = mockSpawn.mock.calls[0] as [string, string[]];
    const promptIndex = args.indexOf('-p');
    const prompt = args[promptIndex + 1];
    expect(prompt).toContain('You are a coder.');
    expect(prompt).toContain('user task');
  });

  it('should handle abort signal', async () => {
    const controller = new AbortController();

    mockSpawn.mockImplementation(() => {
      const child = createMockChildProcess();
      // Emit close after kill (simulates OS killing the process)
      child.kill = vi.fn(() => {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        return true;
      });
      return child;
    });

    controller.abort();

    const result = await callGemini('coder', 'task', {
      cwd: '/repo',
      permissionMode: 'edit',
      abortSignal: controller.signal,
    });

    expect(result.status).toBe('error');
    expect(result.content).toContain('aborted');
  });
});
