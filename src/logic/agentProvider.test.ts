import { describe, expect, it } from 'vitest';
import { providerFromTitle } from './agentProvider';

describe('providerFromTitle', () => {
  it('detects a bare command', () => {
    expect(providerFromTitle('claude')).toBe('claude');
    expect(providerFromTitle('codex')).toBe('codex');
    expect(providerFromTitle('opencode')).toBe('opencode');
  });

  it('detects a Windows executable name, which is what wezterm reports', () => {
    expect(providerFromTitle('claude.exe')).toBe('claude');
    expect(providerFromTitle('CODEX.EXE')).toBe('codex');
    expect(providerFromTitle('claude.cmd')).toBe('claude');
  });

  it('detects the command among arguments', () => {
    expect(providerFromTitle('codex exec')).toBe('codex');
    expect(providerFromTitle('node -- claude --resume')).toBe('claude');
  });

  // A shell titled with its cwd must not be taken for an agent: the panel would
  // offer Approve, which types `y` and Enter into someone's shell.
  it('never treats a directory component as a provider', () => {
    expect(providerFromTitle('/Users/alice/.codex')).toBeNull();
    expect(providerFromTitle('/work/claude/config')).toBeNull();
    expect(providerFromTitle('C:\\Users\\alice\\codex')).toBeNull();
    expect(providerFromTitle('~/src/opencode')).toBeNull();
    expect(providerFromTitle('cd /work/claude')).toBeNull();
  });

  it('does not match a name inside a longer word', () => {
    expect(providerFromTitle('claude-config')).toBeNull();
    expect(providerFromTitle('myclaude')).toBeNull();
    expect(providerFromTitle('codexes')).toBeNull();
  });

  it('is null for ordinary shells and empty titles', () => {
    expect(providerFromTitle('cmd.exe')).toBeNull();
    expect(providerFromTitle('zsh')).toBeNull();
    expect(providerFromTitle('')).toBeNull();
  });

  // Documented cost of skipping path-bearing tokens: a command invoked by
  // absolute path goes undetected. Safe direction to be wrong in.
  it('misses a command written as an absolute path', () => {
    expect(providerFromTitle('/usr/bin/claude')).toBeNull();
  });
});
