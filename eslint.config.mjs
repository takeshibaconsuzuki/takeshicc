import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Nothing here is hand-written source — skip build output, deps and bundles.
  {
    ignores: ['out/', 'node_modules*/', '.node*/', '.vscode-test/', '*.vsix'],
  },

  // TypeScript sources: extension host + standalone server.
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Node build scripts (plain ESM, no TypeScript).
  {
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Must stay last: turns off rules that would conflict with Prettier.
  eslintConfigPrettier,
);
