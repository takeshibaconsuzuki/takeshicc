import * as vscode from 'vscode';
import type { SDKSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { formatRelativeTime } from './time';
import type { SessionStatus } from './statusResolver';

const MAX_TITLE_LEN = 40;

const STATUS_PREFIX: Record<SessionStatus, string> = {
  awaiting: '🟢 ',
  awaiting_permission: '🟡 ',
  busy: '🟠 ',
  inactive: '',
};

export class SessionTreeItem extends vscode.TreeItem {
  constructor(public readonly session: SDKSessionInfo, status: SessionStatus) {
    const rawTitle =
      session.customTitle?.trim() ||
      session.summary?.trim() ||
      session.sessionId.slice(0, 8);
    const truncated = truncate(rawTitle, MAX_TITLE_LEN);
    super(STATUS_PREFIX[status] + truncated, vscode.TreeItemCollapsibleState.None);

    this.description = formatRelativeTime(session.lastModified);
    this.iconPath = iconFor(status);

    const tooltipLines = [
      rawTitle,
      session.sessionId,
      new Date(session.lastModified).toLocaleString(),
    ];
    const statusLine = tooltipFor(status);
    if (statusLine) tooltipLines.push(statusLine);
    if (session.gitBranch) tooltipLines.push(`branch: ${session.gitBranch}`);
    if (session.cwd) tooltipLines.push(`cwd: ${session.cwd}`);
    this.tooltip = tooltipLines.join('\n');

    this.contextValue = `claudeSession:${status}`;
    this.command = {
      command: 'takeshicc.openSession',
      title: 'Open Session',
      arguments: [session.sessionId],
    };
  }
}

function iconFor(status: SessionStatus): vscode.ThemeIcon {
  // Status color lives in the emoji prefix on the label; icons stay plain so
  // they render identically whether a row is idle, hovered, or selected.
  // Keep the spinner for busy because animation is information the emoji
  // can't convey.
  if (status === 'busy') return new vscode.ThemeIcon('loading~spin');
  return new vscode.ThemeIcon('comment-discussion');
}

function tooltipFor(status: SessionStatus): string | null {
  switch (status) {
    case 'awaiting':
      return '🟢 awaiting your input';
    case 'awaiting_permission':
      return '🟡 awaiting permission';
    case 'busy':
      return '🟠 claude is working';
    default:
      return null;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}
