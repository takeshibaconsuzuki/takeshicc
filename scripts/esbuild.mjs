// esbuild build script for both bundles.
//
// Produces three self-contained CJS bundles via esbuild's JS API:
//   - extension -> out/extension.js (vscode + better-sqlite3 external)
//   - server    -> out/server.js    (no externals; express folded in)
//   - reporter  -> out/reporter.js  (no externals; the UserPromptSubmit hook)
//
// Type-checking is integrated via @jgoz/esbuild-plugin-typecheck, which runs
// `tsc` in a worker against tsconfig.json — so every build/watch type-checks
// and emits in one step. There is no separate `typecheck` script.

import * as fs from 'fs';

// Repoint node_modules at this platform's slot BEFORE importing esbuild —
// esbuild resolves a native binary on import and aborts on a platform
// mismatch. This side-effect import runs to completion first; esbuild and the
// typecheck plugin are then imported dynamically so they resolve afterwards.
import './link-modules.mjs';

const esbuild = await import('esbuild');
const { typecheckPlugin } = await import('@jgoz/esbuild-plugin-typecheck');

const shared = {
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  bundle: true,
  sourcemap: true,
};

const configs = {
  ext: {
    ...shared,
    entryPoints: ['src/extension/extension.ts'],
    outfile: 'out/extension.js',
    // The host provides `vscode`; a `.node` binary cannot be bundled.
    external: ['vscode', 'better-sqlite3'],
  },
  server: {
    ...shared,
    entryPoints: ['src/server/server.ts'],
    outfile: 'out/server.js',
    external: [],
    // The Claude Agent SDK is ESM and runs `createRequire(import.meta.url)` at
    // load time; esbuild leaves `import.meta.url` empty in a CJS bundle, which
    // crashes that call. Point it at the bundle's own file URL — createRequire
    // only needs a valid base path, and after bundling that is out/server.js.
    define: { 'import.meta.url': '__importMetaUrl' },
    banner: {
      js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;",
    },
  },
  reporter: {
    ...shared,
    entryPoints: ['src/reporter/reporter.ts'],
    outfile: 'out/reporter.js',
    external: [],
  },
};

const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const which = argv.find((a) => !a.startsWith('--')) ?? 'all';

const selected = which === 'all' ? Object.keys(configs) : [which];

for (const name of selected) {
  if (!configs[name]) {
    console.error(
      `Unknown build target: ${name} (expected ext | server | reporter | all)`,
    );
    process.exit(1);
  }
}

async function run() {
  for (const name of selected) {
    const config = {
      ...configs[name],
      plugins: [typecheckPlugin({ watch, configFile: 'tsconfig.json' })],
    };
    if (watch) {
      const ctx = await esbuild.context(config);
      await ctx.watch();
      console.log(`[esbuild] watching ${name}...`);
    } else {
      await esbuild.build(config);
      console.log(`[esbuild] built ${name} -> ${configs[name].outfile}`);
    }
    // The Windows reporter is a PowerShell script, not bundled — copy it next
    // to the JS outputs so the extension can resolve it under out/.
    if (name === 'reporter') {
      fs.copyFileSync('src/reporter/reporter.ps1', 'out/reporter.ps1');
      console.log('[esbuild] copied reporter.ps1 -> out/reporter.ps1');
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
