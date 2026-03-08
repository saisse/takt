/**
 * Tests for Gemini provider implementation
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCallGemini,
  mockCallGeminiCustom,
} = vi.hoisted(() => ({
  mockCallGemini: vi.fn(),
  mockCallGeminiCustom: vi.fn(),
}));

const {
  mockResolveGeminiApiKey,
  mockResolveGeminiCliPath,
} = vi.hoisted(() => ({
  mockResolveGeminiApiKey: vi.fn(() => undefined),
  mockResolveGeminiCliPath: vi.fn(() => undefined),
}));

vi.mock('../infra/gemini/index.js', () => ({
  callGemini: mockCallGemini,
  callGeminiCustom: mockCallGeminiCustom,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveGeminiApiKey: mockResolveGeminiApiKey,
  resolveGeminiCliPath: mockResolveGeminiCliPath,
  loadProjectConfig: vi.fn(() => ({})),
}));

import { GeminiProvider } from '../infra/providers/gemini.js';
import { ProviderRegistry } from '../infra/providers/index.js';

function doneResponse(persona: string) {
  return {
    persona,
    status: 'done' as const,
    content: 'ok',
    timestamp: new Date(),
  };
}

describe('GeminiProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveGeminiApiKey.mockReturnValue(undefined);
    mockResolveGeminiCliPath.mockReturnValue(undefined);
  });

  it('should throw when claudeAgent is specified', () => {
    const provider = new GeminiProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeAgent: 'some-agent',
    })).toThrow('Claude Code agent calls are not supported by the Gemini provider');
  });

  it('should throw when claudeSkill is specified', () => {
    const provider = new GeminiProvider();

    expect(() => provider.setup({
      name: 'test',
      claudeSkill: 'some-skill',
    })).toThrow('Claude Code skill calls are not supported by the Gemini provider');
  });

  it('should pass model/session/permission and resolved gemini key to callGemini', async () => {
    mockResolveGeminiApiKey.mockReturnValue('resolved-key');
    mockCallGemini.mockResolvedValue(doneResponse('coder'));

    const provider = new GeminiProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      model: 'gemini-pro',
      sessionId: 'sess-1',
      permissionMode: 'full',
    });

    expect(mockCallGemini).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        cwd: '/tmp/work',
        model: 'gemini-pro',
        sessionId: 'sess-1',
        permissionMode: 'full',
        geminiApiKey: 'resolved-key',
      }),
    );
  });

  it('should prefer explicit geminiApiKey over resolver', async () => {
    mockResolveGeminiApiKey.mockReturnValue('resolved-key');
    mockCallGemini.mockResolvedValue(doneResponse('coder'));

    const provider = new GeminiProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', {
      cwd: '/tmp/work',
      geminiApiKey: 'explicit-key',
    });

    expect(mockCallGemini).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        geminiApiKey: 'explicit-key',
      }),
    );
  });

  it('should delegate to callGeminiCustom when systemPrompt is specified', async () => {
    mockCallGeminiCustom.mockResolvedValue(doneResponse('reviewer'));

    const provider = new GeminiProvider();
    const agent = provider.setup({
      name: 'reviewer',
      systemPrompt: 'You are a strict reviewer.',
    });

    await agent.call('review this', {
      cwd: '/tmp/work',
    });

    expect(mockCallGeminiCustom).toHaveBeenCalledWith(
      'reviewer',
      'review this',
      'You are a strict reviewer.',
      expect.objectContaining({ cwd: '/tmp/work' }),
    );
  });

  it('should pass resolved geminiCliPath to callGemini', async () => {
    mockResolveGeminiCliPath.mockReturnValue('/custom/bin/gemini-cli');
    mockCallGemini.mockResolvedValue(doneResponse('coder'));

    const provider = new GeminiProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', { cwd: '/tmp/work' });

    expect(mockCallGemini).toHaveBeenCalledWith(
      'coder',
      'implement',
      expect.objectContaining({
        geminiCliPath: '/custom/bin/gemini-cli',
      }),
    );
  });

  it('should pass undefined geminiCliPath when resolver returns undefined', async () => {
    mockResolveGeminiCliPath.mockReturnValue(undefined);
    mockCallGemini.mockResolvedValue(doneResponse('coder'));

    const provider = new GeminiProvider();
    const agent = provider.setup({ name: 'coder' });

    await agent.call('implement', { cwd: '/tmp/work' });

    const opts = mockCallGemini.mock.calls[0]?.[2];
    expect(opts.geminiCliPath).toBeUndefined();
  });
});

describe('ProviderRegistry with Gemini', () => {
  it('should return Gemini provider from registry', () => {
    ProviderRegistry.resetInstance();
    const registry = ProviderRegistry.getInstance();
    const provider = registry.get('gemini');

    expect(provider).toBeDefined();
    expect(provider).toBeInstanceOf(GeminiProvider);
  });
});
