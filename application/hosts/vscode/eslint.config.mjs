import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'application/hosts/vscode/out/**',
      'application/hosts/vscode/.tmp/**',
      'application/hosts/vscode/.pie-sdk-*/**',
      'application/hosts/vscode/*.vsix',
    ],
  },
  {
    files: ['application/hosts/vscode/**/*.{js,mjs,cjs}'],
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
    files: ['application/hosts/vscode/**/*.{ts,tsx,cts,mts}', 'extension/{src,test}/**/*.{ts,tsx,cts,mts}', 'application/{frontend,backend,hosts,lib}/**/*.{ts,tsx,cts,mts}', 'harness/agent-instructions/**/*.{ts,tsx,cts,mts}', 'harness/tool-and-skill-selection/**/*.{ts,tsx,cts,mts}', 'harness/tools/**/*.{ts,tsx,cts,mts}', 'harness/model-providers/**/*.{ts,tsx,cts,mts}', 'harness/session-storage/**/*.{ts,tsx,cts,mts}', 'harness/agent-processes/**/*.{ts,tsx,cts,mts}', 'test/integration/**/*.{ts,tsx,cts,mts}', 'analytics/**/*.{ts,tsx,cts,mts}'],
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
    files: ['extension/test/**/*.{ts,tsx,cts,mts}', 'application/frontend/test/**/*.{ts,tsx,cts,mts}', 'application/backend/test/**/*.{ts,tsx,cts,mts}', 'application/backend/*/test/**/*.{ts,tsx,cts,mts}', 'application/hosts/*/test/**/*.{ts,tsx,cts,mts}', 'application/hosts/**/test/**/*.{ts,tsx,cts,mts}', 'application/lib/*/test/**/*.{ts,tsx,cts,mts}', 'application/lib/**/test/**/*.{ts,tsx,cts,mts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },

  // ─── Architectural boundary: core/ must stay pure ───────────────────────
  // The arch reducer and its supporting types may only import from themselves
  // (./events, ./effects, ./commands) and from ../../shared/. Never from
  // store/, session-service/, sidebar/, or extension-host.
  {
    files: ['extension/src/host/core/**/*.ts', 'application/backend/conversation-state/**/*.ts'],
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
    files: ['extension/src/host/store/**/*.ts'],
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

  // ─── Architectural boundary: frontend/ is passive ──────────────────────
  // The webview frontend may only import from application/lib and residual
  // shared facades. It must never reach into host-side modules.
  {
    files: ['application/frontend/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/host/*', '**/host/**'], message: 'frontend/ must not import host-side code — it is a passive renderer of projected state.' },
        ],
      }],
    },
  },

  // ─── Protocol boundary integrity: shared types must not use unsafe casts ──
  // Prevent `as any` and `@ts-ignore` in shared protocol and state projection
  // code. These suppress the exact type errors that cause runtime render crashes.
  {
    files: [
      'extension/src/shared/**/*.ts',
      'application/lib/protocol/**/*.ts',
      'application/lib/validation/**/*.ts',
      'extension/src/host/store/index.ts',
      'application/frontend/lib/hooks/use-host-sync.ts',
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
