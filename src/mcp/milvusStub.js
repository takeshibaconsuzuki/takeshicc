// Build-time stub for @zilliz/milvus2-sdk-node. claude-context-core eagerly
// requires the SDK from vectordb/milvus-vectordb.js at module load, even
// though we only ever use NullVectorDatabase. esbuild aliases the SDK to
// this file (see esbuild.js) so the require resolves without shipping the
// real native module. Any property access throws — if MilvusVectorDatabase
// is ever instantiated, the failure points back here instead of a vague
// "Cannot find module" at extension activation.
const handler = {
  get(_target, prop) {
    if (prop === '__esModule') return true;
    if (typeof prop === 'symbol') return undefined;
    throw new Error(
      'takeshicc: @zilliz/milvus2-sdk-node is stubbed at build time. ' +
        `Accessed "${String(prop)}" — a Milvus backend was likely instantiated. ` +
        'takeshicc does not ship the Milvus SDK; use NullVectorDatabase or ' +
        'restore the SDK to the bundle.'
    );
  },
};
module.exports = new Proxy({}, handler);
