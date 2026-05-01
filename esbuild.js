const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Native modules ship `.node` binaries that esbuild cannot bundle. They must be
// resolved at runtime from node_modules colocated with the .vsix, so we keep
// them external. Pull in via `@zilliz/claude-context-core`.
const NATIVE_EXTERNALS = [
  'tree-sitter',
  'tree-sitter-c-sharp',
  'tree-sitter-cpp',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-javascript',
  'tree-sitter-python',
  'tree-sitter-rust',
  'tree-sitter-scala',
  'tree-sitter-typescript',
];

// claude-context-core eagerly requires @zilliz/milvus2-sdk-node and faiss-node
// at module load. We only use NullVectorDatabase, so neither SDK ever runs —
// alias both to a stub so the .vsix doesn't need to ship the native packages.
const STUB = path.resolve(__dirname, 'src/mcp/milvusStub.js');
const STUBBED_BACKENDS = {
  '@zilliz/milvus2-sdk-node': STUB,
  'faiss-node': STUB,
};

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode', ...NATIVE_EXTERNALS],
    alias: STUBBED_BACKENDS,
    logLevel: 'info',
    target: 'node18',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
