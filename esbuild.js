const esbuild = require('esbuild');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// Native modules ship `.node` binaries that esbuild cannot bundle. They must be
// resolved at runtime from node_modules colocated with the .vsix, so we keep
// them external. Tree-sitter packages come in via `@zilliz/claude-context-core`;
// `@lancedb/lancedb` is dynamically loaded by the vendored LanceDB backend.
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
  '@lancedb/lancedb',
  '@lancedb/lancedb-darwin-arm64',
  '@lancedb/lancedb-darwin-x64',
  '@lancedb/lancedb-linux-x64-gnu',
  '@lancedb/lancedb-linux-x64-musl',
  '@lancedb/lancedb-linux-arm64-gnu',
  '@lancedb/lancedb-linux-arm64-musl',
  '@lancedb/lancedb-win32-x64-msvc',
  '@lancedb/lancedb-win32-arm64-msvc',
  // apache-arrow is a peer dep of @lancedb/lancedb. Keeping it external
  // mirrors how lancedb resolves it at runtime; it would otherwise be
  // duplicated by esbuild bundling and break instanceof checks.
  'apache-arrow',
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
