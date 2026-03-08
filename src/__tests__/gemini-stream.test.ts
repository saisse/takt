import { describe, it, expect, vi } from 'vitest';
import { geminiStreamToStreamEvent, type StreamState } from '../infra/gemini/stream.js';

describe('Gemini CLI stream parsing', () => {
  it('should handle text delta events', () => {
    const state: StreamState = { finalContent: '', hasError: false };
    const cb = vi.fn();
    
    geminiStreamToStreamEvent(JSON.stringify({ type: 'message', delta: true, content: 'test' }), cb, state);
    
    expect(state.finalContent).toBe('test');
    expect(cb).toHaveBeenCalledWith({ type: 'text', data: { text: 'test' } });
  });

  it('should handle tool_use events', () => {
    const state: StreamState = { finalContent: '', hasError: false };
    const cb = vi.fn();
    
    geminiStreamToStreamEvent(JSON.stringify({ type: 'tool_use', tool_name: 'testTool', input: { a: 1 }, tool_id: 't1' }), cb, state);
    
    expect(cb).toHaveBeenCalledWith({ type: 'tool_use', data: { tool: 'testTool', input: { a: 1 }, id: 't1' } });
  });

  it('should handle tool_result events', () => {
    const state: StreamState = { finalContent: '', hasError: false };
    const cb = vi.fn();
    
    geminiStreamToStreamEvent(JSON.stringify({ type: 'tool_result', output: 'result data', status: 'success' }), cb, state);
    
    expect(cb).toHaveBeenCalledWith({ type: 'tool_result', data: { content: 'result data', isError: false } });
  });

  it('should handle tool_result events with error', () => {
    const state: StreamState = { finalContent: '', hasError: false };
    const cb = vi.fn();
    
    geminiStreamToStreamEvent(JSON.stringify({ type: 'tool_result', output: 'error message', status: 'error' }), cb, state);
    
    expect(cb).toHaveBeenCalledWith({ type: 'tool_result', data: { content: 'error message', isError: true } });
  });

  it('should handle error events', () => {
    const state: StreamState = { finalContent: '', hasError: false };
    const cb = vi.fn();
    
    geminiStreamToStreamEvent(JSON.stringify({ type: 'error', error: { message: 'Something went wrong' } }), cb, state);
    
    expect(state.hasError).toBe(true);
    expect(state.finalContent).toBe('Something went wrong');
    expect(cb).toHaveBeenCalledWith({ type: 'error', data: { message: 'Something went wrong' } });
  });

  it('should handle session_id in events', () => {
    const state: StreamState = { finalContent: '', hasError: false };
    const cb = vi.fn();
    
    geminiStreamToStreamEvent(JSON.stringify({ type: 'message', delta: true, content: 'test', session_id: 'new-session' }), cb, state);
    
    expect(state.sessionId).toBe('new-session');
  });

  it('should handle result events and parse stats', () => {
    const state: StreamState = { finalContent: '', hasError: false };
    const cb = vi.fn();
    
    geminiStreamToStreamEvent(JSON.stringify({
      type: 'result',
      status: 'success',
      stats: { input_tokens: 10, output_tokens: 20, total_tokens: 30, cached: 5 }
    }), cb, state);
    
    expect(state.providerUsage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cachedInputTokens: 5,
      usageMissing: false,
    });
  });

  it('should safely ignore unparseable lines', () => {
    const state: StreamState = { finalContent: '', hasError: false };
    const cb = vi.fn();
    
    expect(() => geminiStreamToStreamEvent('invalid json', cb, state)).not.toThrow();
  });
});
