import { describe, expect, it } from 'vitest';
import { normalizeSandboxCommand } from '../../src/execution/command';

describe('normalizeSandboxCommand', () => {
  it('wraps shell strings with bash -lc', () => {
    expect(normalizeSandboxCommand('echo hello')).toEqual([
      '/bin/bash',
      '-lc',
      'echo hello'
    ]);
  });

  it('passes argv commands through unchanged', () => {
    expect(normalizeSandboxCommand(['echo', 'hello'])).toEqual([
      'echo',
      'hello'
    ]);
  });

  it('rejects blank string commands', () => {
    expect(() => normalizeSandboxCommand('   ')).toThrow(
      'exec command must not be empty'
    );
  });

  it('rejects empty argv commands', () => {
    expect(() => normalizeSandboxCommand([])).toThrow(
      'exec argv must contain at least one item'
    );
  });

  it('rejects blank argv items', () => {
    expect(() => normalizeSandboxCommand(['echo', ''])).toThrow(
      'exec argv item at index 1 must not be empty'
    );
  });
});
