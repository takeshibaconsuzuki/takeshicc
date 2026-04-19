import { describe, it, expect } from 'vitest';
import { parseClaudeCommand } from '../src/parseClaudeCommand';

const UUID = '0193b3a1-4f2c-7e4d-a9e5-abc123456789';

describe('parseClaudeCommand', () => {
  it('returns null for non-claude commands', () => {
    expect(parseClaudeCommand('ls')).toBeNull();
    expect(parseClaudeCommand('npm install')).toBeNull();
    expect(parseClaudeCommand('claude-ish')).toBeNull();
  });

  it('bare `claude` is a new session', () => {
    expect(parseClaudeCommand('claude')).toEqual({ kind: 'new' });
    expect(parseClaudeCommand('  claude  ')).toEqual({ kind: 'new' });
  });

  it('claude with an ad-hoc initial prompt counts as new session', () => {
    expect(parseClaudeCommand('claude say hello')).toEqual({ kind: 'new' });
  });

  it('claude --resume <uuid>', () => {
    expect(parseClaudeCommand(`claude --resume ${UUID}`)).toEqual({
      kind: 'resume',
      sessionId: UUID,
    });
  });

  it('claude -r <uuid>', () => {
    expect(parseClaudeCommand(`claude -r ${UUID}`)).toEqual({
      kind: 'resume',
      sessionId: UUID,
    });
  });

  it('claude --resume=<uuid>', () => {
    expect(parseClaudeCommand(`claude --resume=${UUID}`)).toEqual({
      kind: 'resume',
      sessionId: UUID,
    });
  });

  it('rejects resume with non-uuid arg', () => {
    expect(parseClaudeCommand('claude --resume latest')).toBeNull();
    expect(parseClaudeCommand('claude --resume 1234')).toBeNull();
  });

  it('ignores help/version/subcommands', () => {
    expect(parseClaudeCommand('claude --help')).toBeNull();
    expect(parseClaudeCommand('claude -h')).toBeNull();
    expect(parseClaudeCommand('claude --version')).toBeNull();
    expect(parseClaudeCommand('claude config list')).toBeNull();
    expect(parseClaudeCommand('claude mcp list')).toBeNull();
    expect(parseClaudeCommand('claude update')).toBeNull();
    expect(parseClaudeCommand('claude doctor')).toBeNull();
  });
});
