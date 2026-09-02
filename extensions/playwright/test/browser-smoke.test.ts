import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chromium } from 'playwright';

import { PlaywrightBackend } from '../src/backend.mjs';

function browserAvailable(): boolean {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
}

async function waitForExit(pid: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`process ${pid} did not exit within ${timeoutMs}ms`);
}

test('real browser smoke: open -> AI ref snapshot -> click -> verified snapshot -> close', { skip: !browserAvailable(), timeout: 30_000 }, async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'pw-smoke-'));
  const backend = new PlaywrightBackend();
  try {
    const opened = await backend.handle('open', {
      sessionId: 'smoke', artifactDir,
      url: 'data:text/html,<title>Smoke</title><button id="go" onclick="document.body.dataset.done=\'yes\';this.textContent=\'Done\'">Smoke button</button>',
    });
    assert.equal(opened.headless, true);
    assert.equal(opened.isolated, true);
    assert.match(opened.observation.snapshot, /Smoke button/);
    const match = opened.observation.snapshot.match(/Smoke button.*\[ref=([^\]\s]+)\]/);
    assert.ok(match, `missing actionable ref in snapshot:\n${opened.observation.snapshot}`);

    const acted = await backend.handle('act', {
      sessionId: 'smoke', pageId: opened.observation.pageId,
      input: { kind: 'click', target: { ref: match[1], revision: opened.observation.revision } },
    });
    assert.match(acted.observation.snapshot, /Done/);

    const pids = await backend.handle('debug_pids', {});
    assert.equal(pids.browserPids.length, 1);
    await backend.handle('close', { scope: 'session', sessionId: 'smoke' });
    await waitForExit(pids.browserPids[0]);
  } finally {
    await backend.shutdown();
    await rm(artifactDir, { recursive: true, force: true });
  }
});
