import { rebuild } from '@electron/rebuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function findCodeOnPath() {
  const PATH = process.env.PATH || '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.cmd', '', '.exe'] : [''];
  for (const rawDir of PATH.split(sep).filter(Boolean)) {
    const dir = rawDir.replace(/^"|"$/g, '');
    for (const ext of exts) {
      const candidate = path.join(dir, 'code' + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not present in this dir; keep looking
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
  const wrapper = findCodeOnPath();
  if (!wrapper) {
    throw new Error(
      "Could not find 'code' on PATH. Set TAKESHICC_ELECTRON_VERSION=<x.y.z>.",
    );
  }
  let real;
  try {
    real = fs.realpathSync(wrapper);
  } catch {
    real = wrapper;
  }
  const pkg = findByParentWalk(real) ?? findByScriptParse(real);
  if (!pkg) {
    throw new Error(
      `Found 'code' at ${wrapper} but could not locate VS Code's package.json. ` +
        'Set TAKESHICC_ELECTRON_VERSION=<x.y.z>.',
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
