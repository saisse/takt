import { describe, it, expect, vi, beforeEach } from 'vitest';

const { logDebugMock } = vi.hoisted(() => ({
  logDebugMock: vi.fn(),
}));

// Mock path relative to the test file: src/__tests__/gemini-args.test.ts -> src/shared/utils/index.js
vi.mock('../shared/utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/utils/index.js')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: logDebugMock,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { buildArgs } from '../infra/gemini/args.js';

describe('Gemini CLI args', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildArgs', () => {
    it('should build basic args without system prompt or model', () => {
      const args = buildArgs('Hello world', { cwd: '/tmp' });
      expect(args).toEqual([
        '-p',
        'Hello world',
        '--output-format',
        'stream-json',
        '--approval-mode',
        'plan',
        '--include-directories',
        '.takt',
      ]);
    });

    it('should include model when provided', () => {
      const args = buildArgs('Hello world', { cwd: '/tmp', model: 'gemini-1.5-pro' });
      expect(args).toContain('-m');
      expect(args).toContain('gemini-1.5-pro');
    });

    it('should include session id when provided', () => {
      const args = buildArgs('Hello world', { cwd: '/tmp', sessionId: 'test-sess' });
      expect(args).toContain('-r');
      expect(args).toContain('test-sess');
    });

    it('should set YOLO approval mode when permission is full or edit', () => {
      const argsFull = buildArgs('Hello', { cwd: '/tmp', permissionMode: 'full' });
      expect(argsFull).toContain('yolo');
      
      const argsEdit = buildArgs('Hello', { cwd: '/tmp', permissionMode: 'edit' });
      expect(argsEdit).toContain('yolo');
    });

    it('should combine system prompt and prompt with newlines', () => {
      const args = buildArgs('Hello', { cwd: '/tmp', systemPrompt: 'System msg' });
      const pIndex = args.indexOf('-p');
      expect(args[pIndex + 1]).toBe('System msg\n\nHello');
    });

    it('should include admin policy path if provided', () => {
      const args = buildArgs('Hello', { cwd: '/tmp' }, '/tmp/policy.toml');
      expect(args).toContain('--admin-policy');
      expect(args).toContain('/tmp/policy.toml');
    });

    it('should mask API key in debug log', () => {
      buildArgs('Hello', { cwd: '/tmp', geminiApiKey: 'AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q' });
      
      expect(logDebugMock).toHaveBeenCalled();
      const callArgs = logDebugMock.mock.calls[0];
      const logOptions = callArgs?.[1];
      expect(logOptions.geminiApiKey).toBe('***');
    });

    it('should include image attachment paths in args and expand placeholders in prompt', () => {
      const args = buildArgs('Look at {{image:test.png}}', {
        cwd: '/tmp',
        imageAttachments: [{ placeholder: '{{image:test.png}}', path: '/abs/path/to/test.png' }],
      });

      // Prompt should be expanded
      const pIndex = args.indexOf('-p');
      expect(args[pIndex + 1]).toContain('{{image:test.png}} (`/abs/path/to/test.png`)');

      // Image path should be added as separate argument
      expect(args).toContain('/abs/path/to/test.png');
    });
  });
});
