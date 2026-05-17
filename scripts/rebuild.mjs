import { rebuild } from '@electron/rebuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CLI wrapper names we recognize, in preference order. VS Code installs
// `code`; Cursor (a VS Code fork) installs `cursor`. If a machine has both,
// `code` wins — override with TAKESHICC_ELECTRON_VERSION when that's wrong.
const EDITOR_CLIS = ['code', 'cursor'];

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function findEditorOnPath() {
  const PATH = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.cmd', '', '.exe'] : [''];
  // Outer loop on CLI name so an earlier name (code) anywhere on PATH beats
  // a later one (cursor), rather than letting PATH order decide.
  for (const name of EDITOR_CLIS) {
    for (const rawDir of PATH.split(sep).filter(Boolean)) {
      const dir = rawDir.replace(/^"|"$/g, '');
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

function hasElectronDep(pkgPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return !!(pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron);
  } catch {
    return false;
  }
}

// Walk up from the wrapper looking for VS Code's package.json. Handles:
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
        const candidate = path.join(
          dir,
          e.name,
          'resources',
          'app',
          'package.json',
        );
        if (fs.existsSync(candidate) && hasElectronDep(candidate))
          return candidate;
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
  const re = /([^"'\s%]*?[/\\]resources[/\\]app)(?=[/\\])/gi;
  for (const m of content.matchAll(re)) {
    let p = m[1];
    if (!p) continue;
    if (!path.isAbsolute(p)) p = path.resolve(scriptDir, p);
    const pkg = path.join(p, 'package.json');
    if (fs.existsSync(pkg) && hasElectronDep(pkg)) return pkg;
  }
  return null;
}

// macOS: the most reliable Electron version for a packaged editor is the
// bundled framework's own version. VS Code's Microsoft build and Cursor both
// strip `devDependencies.electron` from resources/app/package.json, so the
// package.json walk below finds nothing for them — but `<App>.app/Contents/
// Frameworks/Electron Framework.framework` always carries it. Walk up from the
// resolved wrapper to the enclosing `.app`, then read the framework plist.
function findElectronByMacBundle(start) {
  if (process.platform !== 'darwin') return null;
  let dir = path.dirname(start);
  let appRoot = null;
  for (let i = 0; i < 8; i++) {
    if (dir.endsWith('.app')) {
      appRoot = dir;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!appRoot) return null;
  const fw = path.join(
    appRoot,
    'Contents',
    'Frameworks',
    'Electron Framework.framework',
  );
  for (const plist of [
    path.join(fw, 'Resources', 'Info.plist'),
    path.join(fw, 'Versions', 'A', 'Resources', 'Info.plist'),
  ]) {
    if (!fs.existsSync(plist)) continue;
    // The Electron Framework stores its version in CFBundleVersion;
    // CFBundleShortVersionString is absent on at least Cursor/VS Code. Try
    // the short string first anyway in case a future build flips this.
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
      try {
        const v = execFileSync(
          'plutil',
          ['-extract', key, 'raw', '-o', '-', plist],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        if (/^\d+\.\d+\.\d+/.test(v))
          return { version: v, source: `${plist} (${key})` };
      } catch {
        // plutil missing or key absent; try the next key/candidate
      }
    }
  }
  return null;
}

function readElectronVersion(pkgPath) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const v = pkg?.devDependencies?.electron ?? pkg?.dependencies?.electron;
  return v ? v.replace(/^[\^~>=<\s]+/, '') : null;
}

function detect() {
  if (process.env.TAKESHICC_ELECTRON_VERSION) {
    return {
      version: process.env.TAKESHICC_ELECTRON_VERSION,
      source: 'TAKESHICC_ELECTRON_VERSION env var',
    };
  }
  const wrapper = findEditorOnPath();
  if (!wrapper) {
    throw new Error(
      `Could not find ${EDITOR_CLIS.map((n) => `'${n}'`).join(' or ')} on ` +
        'PATH. Set TAKESHICC_ELECTRON_VERSION=<x.y.z>.',
    );
  }
  let real;
  try {
    real = fs.realpathSync(wrapper);
  } catch {
    real = wrapper;
  }
  // On macOS the bundled framework is authoritative and works for editors
  // (Cursor, MS VS Code) whose package.json lacks an electron dep. Elsewhere,
  // fall back to the package.json walk / launcher-script parse.
  const byBundle = findElectronByMacBundle(real);
  if (byBundle) return byBundle;
  const pkg = findByParentWalk(real) ?? findByScriptParse(real);
  if (!pkg) {
    throw new Error(
      `Found '${path.basename(wrapper)}' at ${wrapper} but could not locate ` +
        "the editor's Electron version. Set TAKESHICC_ELECTRON_VERSION=<x.y.z>.",
    );
  }
  const version = readElectronVersion(pkg);
  if (!version) {
    throw new Error(
      `Read ${pkg} but found no electron dep. Set TAKESHICC_ELECTRON_VERSION=<x.y.z>.`,
    );
  }
  return { version, source: pkg };
}

const { version, source } = detect();
console.log(
  `Rebuilding better-sqlite3 for Electron ${version} (from ${source})`,
);

await rebuild({
  buildPath: PROJECT_ROOT,
  electronVersion: version,
  onlyModules: ['better-sqlite3'],
});

console.log('Rebuild complete');
