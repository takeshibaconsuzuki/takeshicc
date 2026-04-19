export type ClaudeInvocation =
  | { kind: 'new' }
  | { kind: 'resume'; sessionId: string }
  | null;

const UUID_ISH = /[0-9a-f][0-9a-f-]{7,}[0-9a-f]/i;

export function parseClaudeCommand(cmd: string): ClaudeInvocation {
  const trimmed = cmd.trim();
  if (!/^claude(?:\s|$)/.test(trimmed)) return null;

  const resumeMatch = trimmed.match(
    /^claude\s+(?:--resume|-r)(?:\s+|=)(\S+)/i
  );
  if (resumeMatch) {
    const id = resumeMatch[1].replace(/^["']|["']$/g, '');
    if (UUID_ISH.test(id)) return { kind: 'resume', sessionId: id };
    return null;
  }

  // Bare `claude` or `claude <prompt...>` with no --resume means new session.
  // Reject help/version/config subcommands where no interactive session is created.
  if (
    /^claude(\s+(--help|-h|--version|-v|help|config|mcp|update|doctor)\b)/.test(
      trimmed
    )
  ) {
    return null;
  }

  return { kind: 'new' };
}
