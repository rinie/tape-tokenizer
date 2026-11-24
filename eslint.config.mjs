// ESLint flat config (ESLint 10): recommended rules, always semicolons,
// plus a few correctness rules that recommended leaves out. Same settings
// as rinie/pulsespaceindex, but ESM ("type": "module").
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';

export default [
  {
    // samples/ and openapi-exploration/ are scanner INPUT — deliberately
    // unbalanced or foreign code, not this project's source
    ignores: ['node_modules/', 'samples/', 'openapi-exploration/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      '@stylistic/semi': ['error', 'always'],
      '@stylistic/no-extra-semi': 'error',
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
];
