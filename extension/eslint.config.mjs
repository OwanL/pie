import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      '.tmp/**',
      '.pie-sdk-*/**',
      '*.vsix',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,cts,mts}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  {
    files: ['test/**/*.{ts,tsx,cts,mts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // ─── Architectural boundary: core/ must stay pure ───────────────────────
  // The arch reducer and its supporting types may only import from themselves
  // (./events, ./effects, ./commands) and from ../../shared/. Never from
  // store/, session-service/, sidebar/, or extension-host.
  {
    files: ['src/host/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/store/*', '**/store'], message: 'core/ must not import from store/ — reducer must remain pure and decoupled from Redux.' },
          { group: ['**/session-service/*', '**/session-service'], message: 'core/ must not import from session-service/ — reducer must remain pure.' },
          { group: ['**/sidebar/*', '**/sidebar'], message: 'core/ must not import from sidebar/.' },
          { group: ['**/extension-host*'], message: 'core/ must not import from extension-host.' },
        ],
      }],
    },
  },

  // ─── Architectural boundary: store/ must not reach into core/ ───────────
  // The transcript-slice receives pre-resolved data from the effect executor.
  // It must never import the arch reducer, events, or effects directly.
  {
    files: ['src/host/store/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/core/*', '**/core'], message: 'store/ must not import from core/ — it receives pre-resolved data via effect execution.' },
          { group: ['**/sidebar/*', '**/sidebar'], message: 'store/ must not import from sidebar/.' },
          { group: ['**/extension-host*'], message: 'store/ must not import from extension-host.' },
        ],
      }],
    },
  },

  // ─── Architectural boundary: webview/ is passive ────────────────────────
  // The webview may only import from shared/ (protocol types). It must never
  // reach into any host-side module.
  {
    files: ['src/webview/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/host/*', '**/host/**'], message: 'webview/ must not import host-side code — it is a passive renderer of projected state.' },
        ],
      }],
    },
  },

  // ─── Protocol boundary integrity: shared types must not use unsafe casts ──
  // Prevent `as any` and `@ts-ignore` in shared protocol and state projection
  // code. These suppress the exact type errors that cause runtime render crashes.
  {
    files: [
      'src/shared/**/*.ts',
      'src/host/store/index.ts',
      'src/webview/panel/hooks/use-host-sync.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', {
        'ts-ignore': true,
        'ts-expect-error': 'allow-with-description',
      }],
    },
  },
);
