// Single source of truth for this extension's command IDs. These must stay in
// sync with `contributes.commands` in package.json.

export const COMMANDS = {
  applyLayout: 'takeshicc.applyLayout',
  openConfig: 'takeshicc.openConfig',
  openServerLog: 'takeshicc.openServerLog',
  pasteFileRef: 'takeshicc.pasteFileRef',
} as const;
