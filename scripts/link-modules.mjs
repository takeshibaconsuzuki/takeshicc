// Keeps a per-platform node_modules so a single repo checkout can be used from
// both Windows and macOS/Linux.
//
// node_modules holds platform-specific native binaries — esbuild's prebuilt
// binary and better-sqlite3's compiled, Electron-ABI-rebuilt addon — that
// cannot be shared across OSes. So, like Node itself (.node.win / .node.posix),
// install is kept per-platform. node_modules itself is always a real directory
// (npm will not install into a symlinked one); the inactive platform's tree is
// parked in a slot:
//
//   node_modules        — the install for whichever OS is running now
//   node_modules.win/   — parked Windows install   (when running on posix)
//   node_modules.posix/ — parked macOS/Linux install (when running on Windows)
//
// On each run this swaps trees so node_modules belongs to the current OS:
// renames within one filesystem, so the swap is O(1). It runs as the npm
// `preinstall` hook (before npm writes packages) and is imported for side
// effect at the top of esbuild.mjs (before esbuild's native binary is
// resolved). Idempotent; Node built-ins only — it must work even when
// node_modules currently holds the wrong platform's packages.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT = process.platform === 'win32' ? 'win' : 'posix';
const slotName = (k) =>
  k === 'win' ? 'node_modules.win' : 'node_modules.posix';
const slotPath = (k) => path.join(ROOT, slotName(k));
const live = path.join(ROOT, 'node_modules');

function lstat(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

// Which platform a node_modules tree was installed for — read from esbuild's
// platform-tagged binary package, always present in a complete install.
function platformOf(dir) {
  try {
    const names = fs.readdirSync(path.join(dir, '@esbuild'));
    if (names.some((n) => n.startsWith('win32'))) return 'win';
    if (names.some((n) => n.startsWith('linux') || n.startsWith('darwin')))
      return 'posix';
  } catch {
    // no @esbuild dir — indeterminate
  }
  return null;
}

let st = lstat(live);

if (st && st.isDirectory()) {
  // node_modules holds some platform's install. If we cannot tell which,
  // assume it is ours — an `npm install` reconciles it either way.
  const active = platformOf(live) ?? CURRENT;
  if (active !== CURRENT) {
    fs.rmSync(slotPath(active), { recursive: true, force: true });
    fs.renameSync(live, slotPath(active));
    console.log(`[link-modules] parked ${slotName(active)} install`);
    st = null;
  }
} else if (st) {
  // A symlink or plain file where node_modules should be — refuse to clobber.
  throw new Error(
    `[link-modules] ${live} exists and is not a directory — remove it and retry.`,
  );
}

if (!st) {
  // Bring this platform's parked slot in as node_modules, if one exists.
  if (lstat(slotPath(CURRENT))) {
    fs.renameSync(slotPath(CURRENT), live);
    console.log(
      `[link-modules] activated ${slotName(CURRENT)} -> node_modules`,
    );
  } else {
    console.log(
      '[link-modules] no node_modules for this platform yet — run `npm install`',
    );
  }
} else if (lstat(slotPath(CURRENT))) {
  // node_modules is already ours; discard a stale parked copy if one lingers.
  fs.rmSync(slotPath(CURRENT), { recursive: true, force: true });
}
