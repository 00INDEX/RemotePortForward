import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'artifacts/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', fetch: 'readonly', AbortSignal: 'readonly' },
    },
  },
];
