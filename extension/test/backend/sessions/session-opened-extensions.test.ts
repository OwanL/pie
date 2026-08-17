import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveActiveExtensionIds, getLoadedExtensionIds, getPromptOptions } from '../../../src/backend/session-opened';

test('deriveActiveExtensionIds identifies local and package extensions from loaded paths', () => {
  assert.deepEqual(deriveActiveExtensionIds([
    'C:\\Users\\me\\.pi\\extensions\\ask-user\\index.ts',
    '/home/me/.pi/extensions/safeguard.ts',
    '/home/me/.pi/extensions/jsx-extension/index.jsx',
    'C:\\Users\\me\\AppData\\npm\\node_modules\\pi-web-access\\index.ts',
    '/store/node_modules/@vendor/pi-extra/dist/index.js',
    '<inline>',
    'C:\\Users\\me\\.pi\\extensions\\ask-user\\index.ts',
  ]), [
    '@vendor/pi-extra',
    'ask-user',
    'jsx-extension',
    'pi-web-access',
    'safeguard',
  ]);
});

test('getPromptOptions reports loaded extension paths independently of selected tools', () => {
  const options = getPromptOptions({
    _baseSystemPromptOptions: {
      cwd: '/workspace',
      selectedTools: ['session_changes'],
      activeExtensions: ['existing-extension'],
    },
    _extensionRunner: {
      getExtensionPaths: () => [
        '/home/me/.pi/extensions/subagent/index.ts',
        '/home/me/.pi/extensions/ask-user/index.ts',
      ],
    },
  });

  assert.deepEqual(options?.selectedTools, ['session_changes']);
  assert.deepEqual(options?.activeExtensions, [
    'ask-user',
    'existing-extension',
    'subagent',
  ]);
});

test('getLoadedExtensionIds reports extensions when prompt options are unavailable', () => {
  const session = {
    _extensionRunner: {
      getExtensionPaths: () => ['/home/me/.pi/extensions/skill-pruner/index.ts'],
    },
  };
  assert.deepEqual(getLoadedExtensionIds(session), ['skill-pruner']);
  assert.equal(getPromptOptions(session), undefined);
});
