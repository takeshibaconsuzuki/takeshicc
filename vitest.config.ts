import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'test/_stubs/vscode.ts'),
    },
  },
});
