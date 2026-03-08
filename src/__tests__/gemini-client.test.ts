import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { callGemini } from '../infra/gemini/client.js';

import type { GeminiCallOptions } from '../infra/gemini/types.js';
import { getAllowedGeminiTools } from '../infra/gemini/types.js';
import { isFolderTrusted, addTrustedFolder } from '../infra/gemini/setup.js';

interface MockChildProcess extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: import('vitest').Mock;
}

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

vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mocked/home/dir'),
  tmpdir: vi.fn(() => '/mocked/tmp/dir'),
}));

vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));

vi.mock('../infra/gemini/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infra/gemini/types.js')>();
  return {
    ...actual,
    getAllowedGeminiTools: vi.fn(actual.getAllowedGeminiTools),
  };
});

vi.mock('../infra/gemini/setup.js', () => ({
  isFolderTrusted: vi.fn(),
  addTrustedFolder: vi.fn(),
}));

describe('Gemini Provider Stream Event Processing', () => {
  let onStreamMock: import('vitest').Mock;
  let options: GeminiCallOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    onStreamMock = vi.fn();
    options = {
      cwd: '/tmp',
      onStream: onStreamMock,
      sessionId: 'test-session',
    };
    vi.mocked(isFolderTrusted).mockReturnValue(true);
  });

  it('should accumulate content from multiple message events', async () => {
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    mockChildProcess.stdout.emit('data', `{"type":"message","delta":true,"content":"Hello,"}
`);
    mockChildProcess.stdout.emit('data', `{"type":"message","delta":true,"content":" world!"}
`);
    mockChildProcess.stdout.emit('data', `{"type":"message","delta":true,"content":" How are you?"}
`);

    mockChildProcess.emit('close', 0);

    const result = await promise;

    expect(result.status).toBe('done');
    expect(result.content).toBe('Hello, world! How are you?');
    expect(onStreamMock).toHaveBeenCalledTimes(4);
    expect(onStreamMock).toHaveBeenCalledWith({ type: 'text', data: { text: 'Hello,' } });
    expect(onStreamMock).toHaveBeenCalledWith({ type: 'text', data: { text: ' world!' } });
    expect(onStreamMock).toHaveBeenCalledWith({ type: 'text', data: { text: ' How are you?' } });
    expect(onStreamMock).toHaveBeenCalledWith({ type: 'result', data: { result: 'Hello, world! How are you?', success: true, sessionId: 'test-session' } });
  });

  it('should correctly process tool_use events', async () => {
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    mockChildProcess.stdout.emit('data', `{"type":"tool_use","tool_name":"list_directory","input":{},"tool_id":"123"}
`);

    mockChildProcess.emit('close', 0);

    const result = await promise;

    expect(result.status).toBe('done');
    expect(onStreamMock).toHaveBeenCalledWith({
      type: 'tool_use',
      data: { tool: 'list_directory', input: {}, id: '123' },
    });
  });

  it('should set status to error and content to error message on error event', async () => {
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    mockChildProcess.stdout.emit('data', `{"error":{"message":"API error occurred"},"type":"error"}
`);

    mockChildProcess.emit('close', 1);

    const result = await promise;

    expect(result.status).toBe('error');
    expect(result.content).toContain('API error occurred');
    expect(onStreamMock).toHaveBeenCalledWith({
      type: 'result',
      data: { result: '', success: false, error: 'Gemini CLI exited with code 1: API error occurred', sessionId: 'test-session' },
    });
  });

  it('should correctly process result event and provider usage', async () => {
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    mockChildProcess.stdout.emit('data', `{"type":"message","delta":true,"content":"Final response."}
`);
    mockChildProcess.stdout.emit('data', `{"type":"result","status":"success","stats":{"input_tokens":10,"output_tokens":20,"total_tokens":30,"cached":5}}
`);

    mockChildProcess.emit('close', 0);

    const result = await promise;

    expect(result.status).toBe('done');
    expect(result.content).toBe('Final response.');
    expect(result.providerUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 5,
      usageMissing: false,
    });
  });

  it('should handle general process error', async () => {
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    const errorMessage = 'spawn ENOENT';
    mockChildProcess.emit('error', new Error(errorMessage));
    mockChildProcess.emit('close', null, 'SIGKILL');

    const result = await promise;

    expect(result.status).toBe('error');
    expect(result.content).toContain('spawn ENOENT');
  });

  it('should handle non-zero exit code with stderr content', async () => {
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    mockChildProcess.stderr.emit('data', `Error from Gemini CLI
`);
    mockChildProcess.emit('close', 1, null);

    const result = await promise;

    expect(result.status).toBe('error');
    expect(result.content).toContain('Gemini CLI exited with code 1: Error from Gemini CLI');
  });

  it('should handle abort signal', async () => {
    const abortController = new AbortController();
    options.abortSignal = abortController.signal;

    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    abortController.abort();

    mockChildProcess.stdout.emit('data', `{"type":"message","delta":true,"content":"Partially sent."}
`);
    mockChildProcess.emit('close', null, 'SIGTERM');

    const result = await promise;

    expect(result.status).toBe('error');
    expect(result.content).toContain('Gemini execution aborted');
  });

  it('should handle AbortError reported in stderr from Gemini CLI', async () => {
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    mockChildProcess.stderr.emit('data', 'AbortError: The user aborted a request\n');
    mockChildProcess.emit('close', 1, null);

    const result = await promise;

    expect(result.status).toBe('error');
    expect(result.content).toBe('Gemini execution aborted');
  });

  it('should generate temporary TOML policy and append --admin-policy when allowedTools is specified', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    options.allowedTools = ['allowed_tool'];
    
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    mockChildProcess.emit('close', 0, null);
    await promise;

    const spawnCalls = vi.mocked(spawn).mock.calls;
    const lastCallArgs = spawnCalls[spawnCalls.length - 1]![1];
    
    expect(lastCallArgs).toContain('--admin-policy');
    expect(writeFileSync).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ mode: 0o600 }));
    expect(rmSync).toHaveBeenCalled();
  });

  it('should generate an allow-list TOML policy for requested tools', async () => {
    const { writeFileSync } = await import('node:fs');
    options.allowedTools = ['Read', 'Grep'];
    
    const promise = callGemini('test-agent', 'test-prompt', options);
    const mockChildProcess = vi.mocked(spawn).mock.results[0]?.value as unknown as MockChildProcess;

    mockChildProcess.emit('close', 0, null);
    await promise;

    expect(writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('toolName = ["read_file", "list_directory", "grep_search"]'),
      expect.any(Object)
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('decision = "allow"'),
      expect.any(Object)
    );
  });
});
