import { rebuild } from '@electron/rebuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// VS Code-based editors whose CLI wrapper we know how to find. Cursor is a
// VS Code fork: same install layout, its own Electron version, CLI named
// `cursor`. TAKESHICC_EDITOR=<name> forces one wrapper when several editors
// are on PATH (its Electron must match the editor running the Extension Host).
const EDITOR_WRAPPERS = ['code', 'cursor'];

function editorWrappers() {
  const forced = process.env.TAKESHICC_EDITOR;
  return forced ? [forced] : EDITOR_WRAPPERS;
}

function findWrapperOnPath(names) {
  const PATH = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.cmd', '', '.exe'] : [''];
  for (const rawDir of PATH.split(sep).filter(Boolean)) {
    const dir = rawDir.replace(/^"|"$/g, '');
    for (const name of names) {
      for (const ext of exts) {
        const candidate = path.join(dir, name + ext);
        try {
          if (fs.statSync(candidate).isFile()) return candidate;
        } catch {
          // not present in this dir; keep looking
        }
      }
    }
  }
  return null;
}

// Deepest `.app` ancestor of a path (the bundle root), e.g.
// /Applications/Cursor.app/Contents/Resources/app/bin/code -> /Applications/Cursor.app.
// Matches a basename of exactly `*.app` so the nested `Resources/app` dir
// (basename `app`) is not mistaken for the bundle.
function appBundleRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (path.basename(dir).endsWith('.app')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Packaged VS Code / Cursor on macOS do not list electron in any package.json
// (resources/app/package.json holds only the editor's own version). The real
// Electron version is the bundled framework's CFBundleVersion.
function findElectronVersionInAppBundle(start) {
  if (process.platform !== 'darwin') return null;
  const appRoot = appBundleRoot(start);
  if (!appRoot) return null;
  const plist = path.join(
    appRoot,
    'Contents/Frameworks/Electron Framework.framework/Resources/Info.plist',
  );
  let xml;
  try {
    xml = fs.readFileSync(plist, 'utf8');
  } catch {
    return null;
  }
  const m = xml.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
  if (m) return { version: m[1].trim(), plist };
  // Some Electron builds ship a binary Info.plist; plutil reads either form.
  try {
    const v = execFileSync('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', plist], {
      encoding: 'utf8',
    }).trim();
    if (v) return { version: v, plist };
  } catch {
    // plutil missing / extraction failed; fall through
  }
  return null;
}

function hasElectronDep(pkgPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return !!(pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron);
  } catch {
    return false;
  }
}

// Walk up from the wrapper looking for the editor's package.json. Handles:
//   - macOS bundle:  <app>/Contents/Resources/app/bin/code  →  ../package.json
//   - Linux/system:  <prefix>/resources/app/package.json    one parent up
//   - Windows:       <install>/<hash>/resources/app/...     scan one level
function findByParentWalk(start) {
  let dir = path.dirname(start);
  for (let i = 0; i < 6; i++) {
    const here = path.join(dir, 'package.json');
    if (fs.existsSync(here) && hasElectronDep(here)) return here;
    const sub = path.join(dir, 'resources', 'app', 'package.json');
    if (fs.existsSync(sub) && hasElectronDep(sub)) return sub;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const candidate = path.join(dir, e.name, 'resources', 'app', 'package.json');
        if (fs.existsSync(candidate) && hasElectronDep(candidate)) return candidate;
      }
    } catch {
      // unreadable dir; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Fallback for shells like Linux's /usr/bin/code that hardcode an absolute
// install path and live nowhere near the resources dir.
function findByScriptParse(scriptPath) {
  let content;
  try {
    content = fs.readFileSync(scriptPath, 'utf8');
  } catch {
    return null;
  }
  const scriptDir = path.dirname(scriptPath);
  const re = /([^"'\s%]*?[\/\\]resources[\/\\]app)(?=[\/\\])/gi;
  for (const m of content.matchAll(re)) {
    let p = m[1];
    if (!p) continue;
    if (!path.isAbsolute(p)) p = path.resolve(scriptDir, p);
    const pkg = path.join(p, 'package.json');
    if (fs.existsSync(pkg) && hasElectronDep(pkg)) return pkg;
  }
  return null;
}

function readElectronVersion(pkgPath) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const v = pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron;
  return v ? v.replace(/^[\^~>=<\s]+/, '') : null;
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// Resolve the Electron version for any path inside an editor install, by the
// most reliable means available: the macOS .app bundle's Electron Framework
// (packaged builds), else a package.json carrying an electron dep (source
// checkouts / older or non-mac layouts).
function electronVersionFor(p) {
  const bundle = findElectronVersionInAppBundle(p);
  if (bundle) return { version: bundle.version, source: bundle.plist };
  const pkg = findByParentWalk(p) ?? findByScriptParse(p);
  if (pkg) {
    const v = readElectronVersion(pkg);
    if (v) return { version: v, source: pkg };
  }
  return null;
}

function detect() {
  if (process.env.TAKESHICC_ELECTRON_VERSION) {
    return {
      version: process.env.TAKESHICC_ELECTRON_VERSION,
      source: 'TAKESHICC_ELECTRON_VERSION env var',
    };
  }

  // The integrated terminal of VS Code / Cursor exports these, pointing into
  // the *running* editor's install — the most reliable source, since it pins
  // the ABI to the exact editor whose Extension Host will load
  // better-sqlite3, even when several editors are on PATH. Present whenever
  // the built-in Git extension is active (the default).
  for (const v of [process.env.VSCODE_GIT_ASKPASS_MAIN, process.env.VSCODE_GIT_ASKPASS_NODE]) {
    if (!v) continue;
    const found = electronVersionFor(realpath(v));
    if (found) return found;
  }

  const names = editorWrappers();
  const wrapper = findWrapperOnPath(names);
  if (!wrapper) {
    throw new Error(
      `Could not find ${names.map((n) => `'${n}'`).join(' or ')} on PATH. ` +
        'Set TAKESHICC_ELECTRON_VERSION=<x.y.z>.'
    );
  }
  const found = electronVersionFor(realpath(wrapper));
  if (!found) {
    throw new Error(
      `Found '${path.basename(wrapper)}' at ${wrapper} but could not determine its ` +
        'Electron version. Set TAKESHICC_ELECTRON_VERSION=<x.y.z>.'
    );
  }
  return found;
}

const { version, source } = detect();
console.log(`Rebuilding better-sqlite3 for Electron ${version} (from ${source})`);

await rebuild({
  buildPath: PROJECT_ROOT,
  electronVersion: version,
  onlyModules: ['better-sqlite3'],
});

console.log('Rebuild complete');
