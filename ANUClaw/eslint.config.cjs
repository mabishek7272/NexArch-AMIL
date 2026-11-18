// ESLint 9 flat config (plan F17). TypeScript via @typescript-eslint v8.
const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');

module.exports = [
  { ignores: ['dist/**', 'node_modules/**', 'dashboard/**', 'container/**', 'logs/**', 'groups/**', 'PaddleOCR-main/**'] },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Pre-existing codebase style, tracked as warnings rather than hidden:
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Safety-relevant: keep as errors.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'eqeqeq': ['error', 'smart'],
    },
  },
  {
    files: ['src/**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
];
