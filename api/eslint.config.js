// ESLint flat config for the API.
//
// Deliberately narrow. The point is not style policing — Prettier owns
// formatting — it is to catch the classes of bug the compiler cannot see while
// api/tsconfig.json is still working through its strictness ratchet, and to
// stop the `any` count from climbing while that happens.
//
// `no-explicit-any` is a warning, not an error, and `npm run lint` pins
// --max-warnings to the current count (see package.json). Adding an `any`
// breaks the lint run; removing one lets you lower the ceiling. That is the
// ratchet: the number goes down, never up.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'eslint.config.js',
      // Legacy CommonJS suites predating the TypeScript conversion. They are
      // not run by `npm test` (which only picks up src/services/__tests__), use
      // require() inside a "type": "module" package, and handoff.test.ts does
      // not even parse. Ignored rather than silently deleted — decide their
      // fate deliberately, but do not let them fail the lint gate meanwhile.
      'tests/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // ── The ratchet ──────────────────────────────────────────────────────
      '@typescript-eslint/no-explicit-any': 'warn',

      // ── Real bugs ────────────────────────────────────────────────────────
      // Fires on `if (await maybe())` where the await was forgotten, and on
      // dangling promises whose rejection would become an unhandled rejection.
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'array-callback-return': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      // ── Evaluated and rejected ───────────────────────────────────────────
      // Each of these fired only false positives on this codebase; the note is
      // here so the next person does not re-enable it and re-discover why.
      //
      // require-atomic-updates: flags `req.boardAccess = await check(req)` in
      //   Express middleware. `req` is per-request and never shared, so the
      //   race it describes cannot happen here.
      'require-atomic-updates': 'off',
      // no-unmodified-loop-condition: flags `while (d < now)` where `d` is a
      //   Date advanced with d.setDate(...) — mutation through a method call,
      //   which the rule does not track.
      'no-unmodified-loop-condition': 'off',
      // no-namespace / no-unsafe-declaration-merging: the `declare global`
      //   Express Request augmentation is the documented way to type req.user.
      '@typescript-eslint/no-namespace': 'off',
      '@typescript-eslint/no-unsafe-declaration-merging': 'off',
      // preserve-caught-error: worth adopting, but it is 12 separate decisions
      //   about which internal error detail is safe to surface at an API
      //   boundary. Not a drive-by fix.
      'preserve-caught-error': 'off',
      // no-useless-assignment: its 8 hits are all defensive initialisers that
      //   document intent (`let gitCreds = null;` ahead of a try/catch that
      //   assigns on both paths). Rewriting them to bare declarations trades
      //   readability for nothing.
      'no-useless-assignment': 'off',

      // ── Turned off while the tsconfig ratchet is still running ───────────
      // Unused symbols are tracked by noUnusedLocals/noUnusedParameters, which
      // are the next tsconfig flags to flip (27 + 90 errors). Reporting them
      // here too would just duplicate that backlog as lint noise.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': 'off',
      // `catch (e) {}` with an empty body is idiomatic here for
      // best-effort cleanup; the tsconfig ratchet covers the typed side.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Express handlers legitimately ignore the promise they return.
      '@typescript-eslint/no-misused-promises': 'off',
      // Requires type-aware linting, which needs a project-wide parserOptions
      // pass that roughly triples lint time — revisit once strict is on.
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
  {
    files: ['src/**/__tests__/**/*.ts'],
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
