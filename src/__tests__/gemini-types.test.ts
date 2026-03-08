import { describe, it, expect } from 'vitest';
import { getAllowedGeminiTools } from '../infra/gemini/types.js';

describe('Gemini CLI types', () => {
  describe('getAllowedGeminiTools', () => {
    it('should return empty array when allowedTools is undefined', () => {
      expect(getAllowedGeminiTools(undefined)).toEqual([]);
    });

    it('should map TAKT tool groups to specific Gemini commands', () => {
      const allowed = ['Read', 'Grep'];
      const result = getAllowedGeminiTools(allowed);
      
      expect(result).toContain('read_file');
      expect(result).toContain('list_directory');
      expect(result).toContain('grep_search');
      
      expect(result).not.toContain('write_file');
      expect(result).not.toContain('run_shell_command');
    });

    it('should pass through unknown tool names as-is', () => {
      const allowed = ['custom_mcp_tool'];
      const result = getAllowedGeminiTools(allowed);
      expect(result).toEqual(['custom_mcp_tool']);
    });

    it('should return all mapped commands when all groups are allowed', () => {
      const allowed = ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch'];
      const result = getAllowedGeminiTools(allowed);
      
      expect(result).toContain('read_file');
      expect(result).toContain('write_file');
      expect(result).toContain('run_shell_command');
      expect(result).toContain('replace');
      expect(result).toContain('google_web_search');
    });

    it('should handle raw Gemini command names in the allowed list', () => {
      const allowed = ['read_file', 'write_file'];
      const result = getAllowedGeminiTools(allowed);
      expect(result).toContain('read_file');
      expect(result).toContain('write_file');
    });
  });
});
