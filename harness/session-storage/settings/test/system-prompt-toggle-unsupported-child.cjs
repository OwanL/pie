'use strict';
require('tsx/cjs');
const fs = require('node:fs/promises');

// Deterministic unsupported-platform qualification for the store's storage
// gate. The mock is applied after the loader is installed and only the store's
// runtime lock observes the mocked identity: filesystem, path, and volume
// semantics keep the host platform, so failures stay reproducible on every
// host instead of depending on where the suite happens to run.
Object.defineProperty(process, 'platform', { value: 'linux' });
const store = require('../session-settings-store.ts');

process.on('message', message => {
  if (message.kind !== 'run') return;
  run(message).catch(error => process.send({ kind: 'failed', error: String(error && error.stack || error) }));
});

async function run(message) {
  await unsupportedLayout('missing', message.missingCurrent, message.missingLegacy);
  await unsupportedLayout('existing', message.existing, undefined);
  process.send({ kind: 'done' });
}

async function unsupportedLayout(name, currentDir, legacyDir) {
  process.env.PIE_SESSION_SETTINGS_DIR = currentDir;
  if (legacyDir) process.env.PIE_LEGACY_SESSION_SETTINGS_DIR = legacyDir;
  else delete process.env.PIE_LEGACY_SESSION_SETTINGS_DIR;
  process.send({ kind: 'available', name, value: store.isSystemPromptTogglePersistenceAvailable() });
  process.send({ kind: 'read', name, value: await store.readSystemPromptToggles() });
  try {
    await store.writeSystemPromptTogglesForSession('/sessions/one.jsonl', ['harness'], true);
    process.send({ kind: 'failed', error: name + ': strict persistence unexpectedly succeeded on an unsupported platform' });
    return;
  } catch (error) {
    process.send({ kind: 'strict-rejected', name, message: error && error.message });
  }
  // Best-effort persistence must complete without throwing so live in-memory
  // state is not blocked, while leaving no durable trace behind.
  await store.writeSystemPromptTogglesForSession('/sessions/two.jsonl', ['tools'], false);
  process.send({ kind: 'best-effort-completed', name });
}