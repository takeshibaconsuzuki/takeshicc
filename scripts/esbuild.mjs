// esbuild build script for both bundles.
//
// Produces two self-contained CJS bundles via esbuild's JS API:
//   - extension -> out/extension.js (vscode + better-sqlite3 external)
//   - server    -> out/server.js   (no externals; express folded in)
//
// Type-checking is integrated via @jgoz/esbuild-plugin-typecheck, which runs
// `tsc` in a worker against tsconfig.json — so every build/watch type-checks
// and emits in one step. There is no separate `typecheck` script.

import * as esbuild from 'esbuild';
import { typecheckPlugin } from '@jgoz/esbuild-plugin-typecheck';

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
  },
};

const argv = process.argv.slice(2);
const watch = argv.includes('--watch');
const which = argv.find((a) => !a.startsWith('--')) ?? 'all';

const selected = which === 'all' ? Object.keys(configs) : [which];

for (const name of selected) {
  if (!configs[name]) {
    console.error(
      `Unknown build target: ${name} (expected ext | server | all)`,
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
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
