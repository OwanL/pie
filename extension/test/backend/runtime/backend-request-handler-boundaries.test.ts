import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BACKEND_REQUEST_METHODS } from '../../../src/backend/request-handler';
import { MESSAGE_REQUEST_HANDLERS } from '../../../src/backend/request-handler-message';
import { SESSION_REQUEST_HANDLERS } from '../../../src/backend/request-handler-session';

const EXPECTED_SESSION_ROUTES = [
  'session.list',
  'session.create',
  'session.open',
  'session.viewed',
  'session.duplicate',
  'session.preload',
  'session.forget',
  'session.loadTranscriptPage',
  'session.loadDetail',
  'session.truncateAfter',
  'session.title.generate',
] as const;

const EXPECTED_MESSAGE_ROUTES = [
  'message.send',
  'operation.status',
  'message.continue',
  'message.compact',
  'message.interrupt',
  'message.clearQueue',
  'message.replaceQueue',
] as const;

const EXPECTED_BACKEND_ROUTES = [
  'app.ping',
  'mcp.list',
  'mcp.setServerEnabled',
  'mcp.setSessionServerEnabled',
  'runtimePrefs.set',
  ...EXPECTED_SESSION_ROUTES,
  ...EXPECTED_MESSAGE_ROUTES,
  'extension_ui.response',
  'openTabs.set',
  'models.list',
  'settings.get',
  'settings.set',
  'systemPromptToggles.set',
  'provider_gate.metrics',
  'liveTurn.checkpoint',
  'diagnostics.livePipeline.setEnabled',
] as const;

const backendSourceDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/backend',
);

async function readBackendSource(fileName: string): Promise<string> {
  return await fs.readFile(path.join(backendSourceDir, fileName), 'utf8');
}

test('request-handler domain route catalogs preserve exact route membership and order', () => {
  assert.deepEqual(Object.keys(SESSION_REQUEST_HANDLERS), EXPECTED_SESSION_ROUTES);
  assert.deepEqual(Object.keys(MESSAGE_REQUEST_HANDLERS), EXPECTED_MESSAGE_ROUTES);
  assert.deepEqual(BACKEND_REQUEST_METHODS, EXPECTED_BACKEND_ROUTES);
  assert.equal(new Set(BACKEND_REQUEST_METHODS).size, BACKEND_REQUEST_METHODS.length);
});

test('request-handler facade retains dispatch ownership while domain modules stay acyclic', async () => {
  const [facade, shared, sessions, messages] = await Promise.all([
    readBackendSource('request-handler.ts'),
    readBackendSource('request-handler-shared.ts'),
    readBackendSource('request-handler-session.ts'),
    readBackendSource('request-handler-message.ts'),
  ]);

  assert.match(facade, /\.\.\.SESSION_REQUEST_HANDLERS/);
  assert.match(facade, /\.\.\.MESSAGE_REQUEST_HANDLERS/);
  assert.match(facade, /export async function handleBackendRequest/);
  assert.doesNotMatch(facade, /async function handleSession(?:Create|Open|Duplicate|TruncateAfter)/);
  assert.doesNotMatch(facade, /async function handleMessage(?:Send|Continue|Compact|Interrupt)/);

  assert.doesNotMatch(shared, /request-handler-(?:session|message)/);
  assert.doesNotMatch(sessions, /request-handler-message/);
  assert.doesNotMatch(messages, /request-handler-session/);
});
