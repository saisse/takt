import { describe, it, expect } from 'vitest';
import { classifyExecutionError, isGeminiExecError, createExecError, trimDetail, maskSensitiveData } from '../infra/gemini/error.js';
import type { GeminiCallOptions } from '../infra/gemini/types.js';

describe('Gemini CLI sensitive data masking', () => {
  it('should mask API keys', () => {
    const text = 'Using key AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q and another AIzaSyX1Y2Z3A4B5C6D7E8F9G0H1I2J3K4L5M6N';
    const masked = maskSensitiveData(text);
    expect(masked).toBe('Using key *** and another ***');
  });

  it('should not mask non-key strings', () => {
    const text = 'This is a normal string AIza and short AIza123';
    expect(maskSensitiveData(text)).toBe(text);
  });
});

describe('Gemini CLI error detail trimming', () => {
  it('should trim string exactly at boundary and beyond', () => {
    const shortStr = 'a'.repeat(300);
    expect(trimDetail(shortStr)).toBe(shortStr);

    const longStr = 'a'.repeat(500);
    const trimmed = trimDetail(longStr);
    expect(trimmed).toContain(' ... [truncated] ... ');
    expect(trimmed.length).toBeLessThan(450);
  });
});

describe('Gemini CLI error classification', () => {
  it('should identify aborts via name', () => {
    const err = createExecError('aborted', { name: 'AbortError' });
    expect(classifyExecutionError(err, {} as GeminiCallOptions)).toBe('Gemini execution aborted');
  });

  it('should identify aborts via signal', () => {
    const err = createExecError('aborted');
    expect(classifyExecutionError(err, { abortSignal: { aborted: true } as unknown as AbortSignal } as GeminiCallOptions)).toBe('Gemini execution aborted');
  });

  it('should identify aborts via stderr output', () => {
    const err = createExecError('failed', { stderr: 'AbortError: The user aborted a request' });
    expect(classifyExecutionError(err, {} as GeminiCallOptions)).toBe('Gemini execution aborted');
  });

  it('should identify auth errors', () => {
    const authKeywords = [
      'authentication', 'unauthorized', 'forbidden', 'api key',
      'gemini_api_key', 'google_api_key', 'verify your account',
      'login required', 'not logged in', 'sign in'
    ];
    for (const keyword of authKeywords) {
      const err = createExecError('failed', { stderr: `Error: ${keyword}` });
      expect(classifyExecutionError(err, {} as GeminiCallOptions)).toContain('Gemini authentication failed');
    }
  });

  it('should return default exit code message', () => {
    const err = createExecError('failed', { code: 123, stderr: 'Something else broke' });
    expect(classifyExecutionError(err, {} as GeminiCallOptions)).toBe('Gemini CLI exited with code 123: Something else broke');
  });

  it('should mask sensitive data in classified error', () => {
    const err = createExecError('failed', { code: 1, stderr: 'Error with key AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q' });
    expect(classifyExecutionError(err, {} as GeminiCallOptions)).toBe('Gemini CLI exited with code 1: Error with key ***');
  });

  it('should return detail only if no code is present', () => {
    const err = createExecError('failed');
    expect(classifyExecutionError(err, {} as GeminiCallOptions)).toBe('failed');
  });

  it('should correctly identify GeminiExecError instance', () => {
    const err = createExecError('failed');
    expect(isGeminiExecError(err)).toBe(true);
    expect(isGeminiExecError(new Error('normal error'))).toBe(false);
  });
});
