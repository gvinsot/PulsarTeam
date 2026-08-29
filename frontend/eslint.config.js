// ESLint flat config for the SPA.
//
// Mirrors api/eslint.config.js — see the note there for the ratchet contract.
// The addition here is react-hooks, which catches the dependency-array and
// conditional-hook mistakes that produce stale closures and are otherwise
// invisible until something renders wrong in production.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'eslint.config.js'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      // The classic, high-signal pair. Not the whole `recommended` preset:
      // react-hooks 6 folds in the React Compiler rules (set-state-in-effect,
      // immutability, purity, preserve-manual-memoization — 55 errors here),
      // which describe how to make components compiler-optimisable rather than
      // correct. Worth adopting deliberately, as its own piece of work.
      'react-hooks/rules-of-hooks': 'error',

      // ── The ratchet ──────────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'warn',

      // ── Real bugs ────────────────────────────────────────────────────────
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'array-callback-return': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // Missing deps are the single most common source of stale-closure bugs
      // in this codebase's effect-heavy components, but there is a real
      // backlog of them — warn now, promote to error once the count is zero.
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'warn',

      // See api/eslint.config.js for why each of these is off.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
      'require-atomic-updates': 'off',
      '@typescript-eslint/no-namespace': 'off',
    },
  },
  {
    files: ['**/__tests__/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
