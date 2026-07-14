import assert from 'node:assert/strict';
import test from 'node:test';

import { installDom } from '../../_helpers/dom';
installDom();

const sent: unknown[] = [];
(globalThis as typeof globalThis & { acquireVsCodeApi?: () => unknown }).acquireVsCodeApi = () => ({
  postMessage(message: unknown) {
    sent.push(message);
  },
  getState: () => undefined,
  setState: () => undefined,
});

// panel.tsx is Vite's entrypoint and imports its stylesheet. Node's focused
// webview tests execute the TypeScript module directly, so make that asset a
// no-op before loading the entrypoint.
(require as NodeRequire).extensions['.css'] = () => undefined;
const panel: typeof import('../../../src/webview/panel/panel') = require('../../../src/webview/panel/panel');

function setGenerationMeta(value: string | null): void {
  document.querySelector('meta[name="pie-view-generation"]')?.remove();
  if (value === null) return;
  const meta = document.createElement('meta');
  meta.name = 'pie-view-generation';
  meta.content = value;
  document.head.appendChild(meta);
}

test('reads the host-stamped view generation and rejects malformed values', () => {
  setGenerationMeta('42');
  assert.equal(panel.getViewGeneration(), 42);
  setGenerationMeta('-1');
  assert.equal(panel.getViewGeneration(), undefined);
  setGenerationMeta('not-a-generation');
  assert.equal(panel.getViewGeneration(), undefined);
});

test('ready, refresh, and snapshot requests carry the stamped generation', () => {
  setGenerationMeta('42');
  const handshakes = [
    panel.withHandshakeMetadata({ type: 'ready' }),
    panel.withHandshakeMetadata({ type: 'refreshState' }),
    panel.withHandshakeMetadata({ type: 'requestSnapshot', sessionPath: '/session/a' }),
  ];
  assert.deepEqual(handshakes.map((message) => ('viewGeneration' in message ? message.viewGeneration : undefined)), [42, 42, 42]);
  const snapshot = handshakes[2] as Extract<typeof handshakes[number], { type: 'requestSnapshot' }>;
  assert.equal(snapshot.type, 'requestSnapshot');
  assert.equal(snapshot.sessionPath, '/session/a');
  assert.equal(sent.length, 0, 'metadata construction must not post by itself');
});

test('ordinary control messages carry the stamped generation', () => {
  setGenerationMeta('43');
  assert.deepEqual(panel.withViewGeneration({ type: 'newSession' }), {
    type: 'newSession',
    viewGeneration: 43,
  });
});
