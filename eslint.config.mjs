// Flat ESLint config (ESLint 10 + typescript-eslint). Scoped to the TypeScript
// sources; build glue and artifacts are ignored. `prettier` is last so it
// disables every stylistic rule that would fight the formatter.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['out/**', 'node_modules/**', '.vscode-test/**', 'scripts/**', '**/*.vsix'] },
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `import x = require('…')` is the deliberate interop for CJS-only deps
      // (express, better-sqlite3) in the CommonJS esbuild bundle.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  prettier,
);
