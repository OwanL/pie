import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { chromium } from 'playwright';

import { PlaywrightBackend } from '../src/backend.mjs';
import { encodeSidecarRecord } from '../src/sidecar-core.mjs';

function browserAvailable(): boolean {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
}
const HAS_BROWSER = browserAvailable();

let server: Server;
let baseUrl = '';
let fixtureHtml = '';
let downloadText = '';

before(async () => {
  if (!HAS_BROWSER) return;
  const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
  fixtureHtml = await readFile(path.join(fixtures, 'browser-fixture.html'), 'utf8');
  downloadText = await readFile(path.join(fixtures, 'download.txt'), 'utf8');
  server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname === '/index.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(fixtureHtml); return;
    }
    if (url.pathname === '/page2') {
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end('<title>Fixture page 2</title><h1>Fixture page 2</h1><div id="p2-marker">second</div>'); return;
    }
    if (url.pathname === '/download') {
      response.setHeader('content-type', 'text/plain'); response.setHeader('content-disposition', 'attachment; filename="fixture-download.txt"'); response.end(downloadText); return;
    }
    if (url.pathname === '/download-big') {
      response.setHeader('content-type', 'application/octet-stream'); response.setHeader('content-disposition', 'attachment; filename="big.bin"'); response.end(Buffer.alloc(4096, 7)); return;
    }
    if (url.pathname === '/dense') {
      const rows = Array.from({ length: 400 }, (_, index) => `<li><button>Dense row ${index}</button></li>`).join('');
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(`<title>Dense fixture</title><h1>Dense fixture</h1><ul>${rows}</ul>`); return;
    }
    if (url.pathname === '/huge') {
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(`<title>Huge fixture</title><input value="${'A'.repeat(100_000)}">`); return;
    }
    if (url.pathname === '/long-line') {
      response.setHeader('content-type', 'text/html; charset=utf-8'); response.end(`<title>Long line fixture</title><input value="${'L'.repeat(8_000)}">`); return;
    }
    response.statusCode = 404; response.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function withBackend(
  run: (backend: any, artifactDir: string) => Promise<void>,
  options: Record<string, unknown> = {},
): Promise<void> {
  const artifactDir = await mkdtemp(path.join(tmpdir(), 'pw-backend-'));
  const backend = new PlaywrightBackend(options);
  try { await run(backend, artifactDir); }
  finally { await backend.shutdown(); await rm(artifactDir, { recursive: true, force: true }); }
}

function refFor(snapshot: string, linePattern: RegExp): string {
  const line = snapshot.split('\n').find((candidate) => linePattern.test(candidate));
  const match = line?.match(/\[ref=([^\]\s]+)\]/);
  assert.ok(match, `missing ref on line ${linePattern}:\n${snapshot}`);
  return match[1];
}

function errorCode(error: unknown, code: string): boolean {
  return (error as { code?: string }).code === code;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition timed out');
}

test('open/observe/ref actions verify changed snapshots and isolate browser state', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    const opened = await backend.handle('open', { sessionId: 'one', artifactDir: path.join(artifactDir, 'one'), url: `${baseUrl}/` });
    assert.equal(opened.headless, true); assert.equal(opened.isolated, true);
    assert.match(opened.observation.snapshot, /Fixture home/);
    assert.match(opened.observation.snapshot, /Frame button/);
    const pageId = opened.observation.pageId;
    const emailRef = refFor(opened.observation.snapshot, /textbox "Email"/);
    const oldSubmitRef = refFor(opened.observation.snapshot, /button "Submit"/);

    const filled = await backend.handle('act', {
      sessionId: 'one', pageId,
      input: { kind: 'fill', target: { ref: emailRef, revision: opened.observation.revision }, value: 'user@example.test' },
    });
    assert.ok(filled.observation.revision > opened.observation.revision);
    await assert.rejects(
      () => backend.handle('act', { sessionId: 'one', pageId, input: { kind: 'click', target: { ref: oldSubmitRef, revision: opened.observation.revision } } }),
      (error: unknown) => errorCode(error, 'STALE_REF'),
    );
    const submitRef = refFor(filled.observation.snapshot, /button "Submit"/);
    const submitted = await backend.handle('act', {
      sessionId: 'one', pageId,
      input: { kind: 'click', target: { ref: submitRef, revision: filled.observation.revision } },
    });
    assert.match(submitted.observation.snapshot, /submitted:user@example\.test/);

    const state = await backend.handle('run_code', {
      sessionId: 'one', code: "return await page.evaluate(() => ({ local: localStorage.getItem('fixture-email'), cookie: document.cookie }));",
      observation: { mode: 'none' },
    });
    assert.match(state.runCode.text, /user@example\.test/);

    await backend.handle('open', { sessionId: 'two', artifactDir: path.join(artifactDir, 'two'), url: `${baseUrl}/` });
    const isolated = await backend.handle('run_code', {
      sessionId: 'two', code: "return await page.evaluate(() => ({ local: localStorage.getItem('fixture-email'), cookie: document.cookie }));", observation: { mode: 'none' },
    });
    assert.match(isolated.runCode.text, /"local": null/);
    assert.doesNotMatch(isolated.runCode.text, /fixture_email/);

    await backend.handle('close', { scope: 'session', sessionId: 'one' });
    const stillAlive = await backend.handle('observe', { sessionId: 'two' });
    assert.match(stillAlive.observation.snapshot, /Fixture home/);
  });
});

test('complete typed v1 element actions, waits, uploads, and targeted observations', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    const opened = await backend.handle('open', { sessionId: 'actions', artifactDir, url: `${baseUrl}/` });
    const pageId = opened.observation.pageId;
    await backend.handle('act', { sessionId: 'actions', input: { kind: 'fill', target: { selector: '#email' }, value: '' } });
    await backend.handle('act', { sessionId: 'actions', input: { kind: 'type', target: { selector: '#email' }, text: 'typed@example.test' } });
    await backend.handle('act', { sessionId: 'actions', input: { kind: 'press', target: { selector: '#email' }, key: 'End' } });

    const checked = await backend.handle('act', { sessionId: 'actions', input: { kind: 'check', target: { selector: '#agree' } } });
    assert.match(checked.observation.snapshot, /agree:true/);
    const unchecked = await backend.handle('act', { sessionId: 'actions', input: { kind: 'uncheck', target: { selector: '#agree' } } });
    assert.match(unchecked.observation.snapshot, /agree:false/);
    const selected = await backend.handle('act', { sessionId: 'actions', input: { kind: 'select', target: { selector: '#color' }, values: ['blue'] } });
    assert.match(selected.observation.snapshot, /color:blue/);
    const hovered = await backend.handle('act', { sessionId: 'actions', input: { kind: 'hover', target: { selector: '#heading' } } });
    assert.match(hovered.observation.snapshot, /hovered:heading/);
    const focused = await backend.handle('act', { sessionId: 'actions', input: { kind: 'focus', target: { selector: '#color' } } });
    assert.match(focused.observation.snapshot, /focused:color/);
    await backend.handle('act', { sessionId: 'actions', input: { kind: 'double_click', target: { selector: '#heading' } } });

    const uploadPath = path.join(artifactDir, 'upload.txt');
    await writeFile(uploadPath, 'upload fixture');
    const uploaded = await backend.handle('act', { sessionId: 'actions', input: { kind: 'upload', target: { selector: '#file-input' }, paths: [uploadPath] } });
    assert.match(uploaded.observation.snapshot, /files:1/);

    await backend.handle('act', { sessionId: 'actions', input: { kind: 'wait', condition: { timeMs: 25 } }, timeoutMs: 1000 });
    await backend.handle('act', { sessionId: 'actions', input: { kind: 'wait', condition: { selector: '#status' } }, timeoutMs: 1000 });
    await backend.handle('act', { sessionId: 'actions', input: { kind: 'wait', condition: { text: 'Fixture home' } }, timeoutMs: 1000 });
    const spa = await backend.handle('act', { sessionId: 'actions', input: { kind: 'click', target: { selector: '#spa-btn' } } });
    assert.equal(spa.observation.url, `${baseUrl}/spa-state`);
    assert.match(spa.observation.snapshot, /spa:ready/);
    await backend.handle('act', { sessionId: 'actions', input: { kind: 'wait', condition: { url: '**/spa-state' } }, timeoutMs: 1000 });
    await assert.rejects(
      () => backend.handle('act', { sessionId: 'actions', input: { kind: 'wait', condition: { selector: '#never' } }, timeoutMs: 1000 }),
      (error: unknown) => errorCode(error, 'ACTION_TIMEOUT'),
    );

    const targeted = await backend.handle('observe', { sessionId: 'actions', pageId, observation: { target: { selector: '#signup' } } });
    assert.match(targeted.observation.snapshot, /textbox "Email"/);
    assert.doesNotMatch(targeted.observation.snapshot, /Trigger alert/);
  });
});

test('navigation, history, tabs, and page ids remain explicit', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    const opened = await backend.handle('open', { sessionId: 'tabs', artifactDir, url: `${baseUrl}/` });
    const firstPageId = opened.observation.pageId;
    const navigated = await backend.handle('act', { sessionId: 'tabs', input: { kind: 'navigate', url: `${baseUrl}/page2` } });
    assert.match(navigated.observation.snapshot, /Fixture page 2/);
    await backend.handle('act', { sessionId: 'tabs', input: { kind: 'wait', condition: { url: '**/page2' } }, timeoutMs: 1000 });
    assert.match((await backend.handle('act', { sessionId: 'tabs', input: { kind: 'back' } })).observation.snapshot, /Fixture home/);
    assert.match((await backend.handle('act', { sessionId: 'tabs', input: { kind: 'forward' } })).observation.snapshot, /Fixture page 2/);
    assert.match((await backend.handle('act', { sessionId: 'tabs', input: { kind: 'reload' } })).observation.snapshot, /Fixture page 2/);

    const openedTab = await backend.handle('act', { sessionId: 'tabs', input: { kind: 'tab_open', url: `${baseUrl}/` } });
    assert.equal(openedTab.observation.tabs.length, 2);
    const secondPageId = openedTab.observation.pageId;
    assert.notEqual(secondPageId, firstPageId);
    const selected = await backend.handle('act', { sessionId: 'tabs', input: { kind: 'tab_select', pageId: firstPageId } });
    assert.equal(selected.observation.pageId, firstPageId);
    const closed = await backend.handle('act', { sessionId: 'tabs', input: { kind: 'tab_close', pageId: secondPageId } });
    assert.equal(closed.observation.tabs.length, 1);
    const lastClosed = await backend.handle('act', { sessionId: 'tabs', input: { kind: 'tab_close', pageId: firstPageId } });
    assert.equal(lastClosed.observation, undefined);
    const recovered = await backend.handle('act', { sessionId: 'tabs', input: { kind: 'tab_open', url: `${baseUrl}/page2` } });
    assert.match(recovered.observation.snapshot, /Fixture page 2/);
    assert.equal(recovered.observation.tabs.length, 1);
    await assert.rejects(
      () => backend.handle('act', { sessionId: 'tabs', input: { kind: 'tab_select', pageId: 'missing' } }),
      (error: unknown) => errorCode(error, 'PAGE_NOT_FOUND'),
    );
  });
});

test('dialogs, errors, failed requests, and bounded download artifacts are reported without deadlock', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    await backend.handle('open', { sessionId: 'events', artifactDir, url: `${baseUrl}/` });
    const alert = await backend.handle('act', { sessionId: 'events', input: { kind: 'click', target: { selector: '#alert-btn' } } });
    assert.equal(alert.dialogs[0].result, 'auto-dismissed');
    assert.equal(alert.dialogs[0].type, 'alert');
    const multiple = await backend.handle('act', { sessionId: 'events', input: { kind: 'click', target: { selector: '#multi-dialog-btn' } }, dialog: { action: 'accept' } });
    assert.deepEqual(multiple.dialogs.map((entry: any) => [entry.message, entry.result]), [
      ['fixture-first', 'accepted'],
      ['fixture-second', 'auto-dismissed'],
    ]);
    const accepted = await backend.handle('act', { sessionId: 'events', input: { kind: 'click', target: { selector: '#confirm-btn' } }, dialog: { action: 'accept' } });
    assert.equal(accepted.dialogs[0].result, 'accepted');
    assert.match(accepted.observation.snapshot, /confirm:true/);
    const dismissed = await backend.handle('act', { sessionId: 'events', input: { kind: 'click', target: { selector: '#confirm-btn' } }, dialog: { action: 'dismiss' } });
    assert.equal(dismissed.dialogs[0].result, 'dismissed');
    assert.match(dismissed.observation.snapshot, /confirm:false/);
    const prompted = await backend.handle('act', { sessionId: 'events', input: { kind: 'click', target: { selector: '#prompt-btn' } }, dialog: { action: 'accept', promptText: 'answer' } });
    assert.match(prompted.observation.snapshot, /prompt:answer/);

    const noise = await backend.handle('act', { sessionId: 'events', input: { kind: 'click', target: { selector: '#noise-btn' } } });
    const afterNoise = await backend.handle('act', { sessionId: 'events', input: { kind: 'wait', condition: { timeMs: 200 } }, timeoutMs: 1000 });
    const combined = [noise.observation.events, afterNoise.observation.events];
    assert.ok(combined.some((events) => events.console.some((entry: any) => /fixture-console-error/.test(entry.text))));
    assert.ok(combined.some((events) => events.pageErrors.some((entry: any) => /fixture-page-error/.test(entry.message))));
    assert.ok(combined.some((events) => events.failedRequests.some((entry: any) => /127\.0\.0\.1:9/.test(entry.url))));

    const started = await backend.handle('act', { sessionId: 'events', input: { kind: 'click', target: { selector: '#download-link' } } });
    await waitFor(() => backend.sessions.get('events')?.queues.downloads.some((entry: any) => entry.state === 'saved') === true);
    const settled = await backend.handle('observe', { sessionId: 'events', observation: { mode: 'none', downloadLimit: 200 } });
    const downloads = [...started.observation.events.downloads, ...settled.observation.events.downloads];
    const saved = downloads.find((entry: any) => entry.state === 'saved');
    assert.ok(saved?.path && existsSync(saved.path));
    assert.equal(await readFile(saved.path, 'utf8'), downloadText);

    const bigStarted = await backend.handle('act', { sessionId: 'events', input: { kind: 'click', target: { selector: '#big-download-link' } } });
    await waitFor(() => backend.sessions.get('events')?.queues.downloads.some((entry: any) => entry.state === 'too_large') === true);
    const bigSettled = await backend.handle('observe', { sessionId: 'events', observation: { mode: 'none', downloadLimit: 200 } });
    const bigDownloads = [...bigStarted.observation.events.downloads, ...bigSettled.observation.events.downloads];
    assert.ok(bigDownloads.some((entry: any) => entry.state === 'too_large'));
  }, { maxDownloadArtifactBytes: 64 });
});

test('snapshot and screenshot bounding preserve fidelity markers and complete artifacts', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    await backend.handle('open', { sessionId: 'bounds', artifactDir, url: `${baseUrl}/`, viewport: { width: 1920, height: 1080 } });
    const screenshot = await backend.handle('observe', { sessionId: 'bounds', observation: { screenshot: true } });
    assert.ok(existsSync(screenshot.screenshot.fullImagePath));
    assert.ok(existsSync(screenshot.screenshot.displayImagePath));
    assert.ok(Math.max(screenshot.screenshot.imageWidth, screenshot.screenshot.imageHeight) <= 1600);

    const dense = await backend.handle('act', { sessionId: 'bounds', input: { kind: 'navigate', url: `${baseUrl}/dense` } });
    assert.ok(dense.observation.reduction?.fullSnapshotPath);
    assert.ok(existsSync(dense.observation.reduction.fullSnapshotPath));
    assert.ok(Buffer.byteLength(dense.observation.snapshot) <= 32 * 1024);
    assert.ok(dense.observation.snapshot.split('\n').length <= 250);

    const longLine = await backend.handle('act', { sessionId: 'bounds', input: { kind: 'navigate', url: `${baseUrl}/long-line` } });
    assert.ok(longLine.observation.reduction?.fullSnapshotPath);
    assert.match(longLine.observation.snapshot, /\[line truncated\]/);
    assert.ok(longLine.observation.snapshot.split('\n').every((line: string) => line.length <= 400));

    const huge = await backend.handle('act', { sessionId: 'bounds', input: { kind: 'navigate', url: `${baseUrl}/huge` } });
    assert.ok(huge.observation.reduction?.fullSnapshotPath);
    assert.ok(existsSync(huge.observation.reduction.fullSnapshotPath));
    assert.match(huge.observation.snapshot, /\[line truncated\]/);
    assert.match(huge.observation.snapshot, /\[ref=[^\]]+\]/);
  });
});

test('run_code reconciles new contexts/pages, serializes cycles, spills oversized values, and refreshes refs', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    const opened = await backend.handle('open', { sessionId: 'code', artifactDir, url: `${baseUrl}/` });
    const oldHeadingRef = refFor(opened.observation.snapshot, /heading "Fixture home"/);
    const title = await backend.handle('run_code', { sessionId: 'code', code: 'return await page.title();' });
    assert.match(title.runCode.text, /PW Fixture/);
    assert.ok(title.observation.revision > opened.observation.revision);
    const canvas = await backend.handle('run_code', {
      sessionId: 'code',
      code: "return await page.locator('#demo-canvas').evaluate((element) => Array.from(element.getContext('2d').getImageData(0, 0, 1, 1).data));",
      observation: { mode: 'none' },
    });
    assert.match(canvas.runCode.text, /255/);
    await assert.rejects(
      () => backend.handle('act', { sessionId: 'code', pageId: opened.observation.pageId, input: { kind: 'click', target: { ref: oldHeadingRef, revision: opened.observation.revision } } }),
      (error: unknown) => errorCode(error, 'STALE_REF'),
    );

    const extra = await backend.handle('run_code', {
      sessionId: 'code',
      code: 'async ({ page }) => { const context = await page.context().browser().newContext(); const tab = await context.newPage(); await tab.setContent("<title>Extra</title><button>Extra tab</button>"); return { contexts: page.context().browser().contexts().length }; }',
    });
    assert.match(extra.runCode.text, /"contexts": 2/);
    assert.equal(extra.observation.tabs.length, 2);

    const cyclic = await backend.handle('run_code', { sessionId: 'code', code: 'const value = { ok: true }; value.self = value; return value;' });
    assert.match(cyclic.runCode.text, /\[circular\]/);
    const helper = await backend.handle('run_code', {
      sessionId: 'code',
      code: "const saved = await helpers.writeArtifact('note.txt', 'abc'); return { saved, toJSON() { void helpers.writeArtifact('too-late.txt', 'z'.repeat(10000)); return { saved }; } };",
      observation: { mode: 'none' },
    });
    assert.equal(helper.helperArtifacts.length, 1);
    assert.equal(helper.helperArtifacts[0].bytes, 3);
    assert.equal((await readFile(helper.helperArtifacts[0].path, 'utf8')), 'abc');
    await backend.handle('run_code', {
      sessionId: 'code',
      code: "setTimeout(() => { void helpers.writeArtifact('delayed.txt', 'late'); }, 50); return true;",
      observation: { mode: 'none' },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const helperFiles = await readdir(path.join(artifactDir, 'run-code'));
    assert.equal(helperFiles.some((name) => name.endsWith('too-late.txt') || name.endsWith('delayed.txt')), false);
    const large = await backend.handle('run_code', { sessionId: 'code', code: "return 'x'.repeat(100000);" });
    assert.equal(large.runCode.truncated, true);
    assert.ok(large.runCode.artifactPath && existsSync(large.runCode.artifactPath));
    assert.ok((await readFile(large.runCode.artifactPath)).length > 32 * 1024);

    await assert.rejects(
      () => backend.handle('run_code', { sessionId: 'code', code: "throw new Error('code-boom');" }),
      /code-boom/,
    );
    await assert.rejects(
      () => backend.handle('run_code', { sessionId: 'code', code: 'await new Promise(() => {});', timeout: 1000 }),
      (error: unknown) => errorCode(error, 'RUN_CODE_TIMEOUT'),
    );
  });
});

test('storage state round-trips cookies, local storage, and IndexedDB but not session storage', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    await backend.handle('open', { sessionId: 'auth', artifactDir: path.join(artifactDir, 'auth'), url: `${baseUrl}/` });
    await backend.handle('run_code', {
      sessionId: 'auth',
      code: `
        return await page.evaluate(async () => {
          localStorage.setItem('persist-local', 'local-value');
          sessionStorage.setItem('do-not-persist', 'session-value');
          document.cookie = 'persist_cookie=cookie-value; path=/';
          await new Promise((resolve, reject) => {
            const request = indexedDB.open('persist-db', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('items');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const tx = request.result.transaction('items', 'readwrite');
              tx.objectStore('items').put('idb-value', 'key');
              tx.oncomplete = resolve;
              tx.onerror = () => reject(tx.error);
            };
          });
          return true;
        });
      `,
    });
    const closed = await backend.handle('close', { scope: 'session', sessionId: 'auth', exportStorageState: true });
    assert.ok(closed.storageStatePath && existsSync(closed.storageStatePath));

    await backend.handle('open', { sessionId: 'restored', artifactDir: path.join(artifactDir, 'restored'), url: `${baseUrl}/`, storageStatePath: closed.storageStatePath });
    const restored = await backend.handle('run_code', {
      sessionId: 'restored',
      code: `
        return await page.evaluate(async () => {
          const idb = await new Promise((resolve, reject) => {
            const request = indexedDB.open('persist-db');
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const tx = request.result.transaction('items', 'readonly');
              const get = tx.objectStore('items').get('key');
              get.onsuccess = () => resolve(get.result);
              get.onerror = () => reject(get.error);
            };
          });
          return {
            local: localStorage.getItem('persist-local'),
            session: sessionStorage.getItem('do-not-persist'),
            cookie: document.cookie,
            idb,
          };
        });
      `,
      observation: { mode: 'none' },
    });
    assert.match(restored.runCode.text, /local-value/);
    assert.match(restored.runCode.text, /persist_cookie=cookie-value/);
    assert.match(restored.runCode.text, /idb-value/);
    assert.match(restored.runCode.text, /"session": null/);

    const malformedPath = path.join(artifactDir, 'malformed-storage.json');
    await writeFile(malformedPath, JSON.stringify({ cookies: [{ name: 'missing-required-fields' }], origins: [] }));
    await assert.rejects(
      () => backend.handle('open', { sessionId: 'malformed', artifactDir: path.join(artifactDir, 'malformed'), storageStatePath: malformedPath }),
      (error: unknown) => errorCode(error, 'INVALID_STORAGE_STATE'),
    );
  });
});

test('wrong ids fail closed, browser crash is explicit, and runtime close is idempotent', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    await assert.rejects(() => backend.handle('observe', { sessionId: 'missing' }), (error: unknown) => errorCode(error, 'SESSION_NOT_FOUND'));
    await backend.handle('open', { sessionId: 'crash', artifactDir, url: `${baseUrl}/` });
    await assert.rejects(() => backend.handle('observe', { sessionId: 'crash', pageId: 'missing' }), (error: unknown) => errorCode(error, 'PAGE_NOT_FOUND'));
    const pids = await backend.handle('debug_pids', {});
    assert.equal(pids.browserPids.length, 1);
    process.kill(pids.browserPids[0], 'SIGKILL');
    await waitFor(() => backend.sessions.get('crash')?.crashed === true);
    await assert.rejects(() => backend.handle('observe', { sessionId: 'crash' }), (error: unknown) => errorCode(error, 'BROWSER_CRASHED'));
    const firstClose = await backend.handle('close', { scope: 'runtime' });
    assert.deepEqual(firstClose.closed.sessionIds, ['crash']);
    const secondClose = await backend.handle('close', { scope: 'runtime' });
    assert.deepEqual(secondClose.closed.sessionIds, []);
  });
});

test('failed storage export still closes session and runtime scopes', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    await backend.handle('open', { sessionId: 'one', artifactDir: path.join(artifactDir, 'one'), url: `${baseUrl}/` });
    await backend.handle('open', { sessionId: 'two', artifactDir: path.join(artifactDir, 'two'), url: `${baseUrl}/` });
    await assert.rejects(
      () => backend.handle('close', { scope: 'session', sessionId: 'one', exportStorageState: true }),
      (error: unknown) => errorCode(error, 'ARTIFACT_TOO_LARGE'),
    );
    await assert.rejects(() => backend.handle('observe', { sessionId: 'one' }), (error: unknown) => errorCode(error, 'SESSION_NOT_FOUND'));
    assert.equal((await backend.handle('debug_pids', {})).browserPids.length, 1);

    await assert.rejects(
      () => backend.handle('close', { scope: 'runtime', sessionId: 'two', exportStorageState: true }),
      (error: unknown) => errorCode(error, 'ARTIFACT_TOO_LARGE'),
    );
    assert.equal((await backend.handle('debug_pids', {})).browserPids.length, 0);
    await assert.rejects(() => backend.handle('observe', { sessionId: 'two' }), (error: unknown) => errorCode(error, 'SESSION_NOT_FOUND'));
  }, { maxSessionArtifactBytes: 1 });
});

test('artifact quotas account snapshots, screenshots, and run_code atomically across a session', { skip: !HAS_BROWSER, timeout: 40_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    await assert.rejects(
      () => backend.handle('open', { sessionId: 'snapshot-quota', artifactDir: path.join(artifactDir, 'snapshot'), url: `${baseUrl}/dense` }),
      (error: unknown) => errorCode(error, 'ARTIFACT_TOO_LARGE'),
    );
    assert.equal((await backend.handle('debug_pids', {})).browserPids.length, 0);
  }, { maxSessionArtifactBytes: 1 });

  await withBackend(async (backend, artifactDir) => {
    const sessionDir = path.join(artifactDir, 'cross-type');
    await backend.handle('open', { sessionId: 'cross-type', artifactDir: sessionDir, url: `${baseUrl}/` });
    await backend.handle('observe', { sessionId: 'cross-type', observation: { screenshot: true } });
    const session = backend.sessions.get('cross-type');
    assert.ok(session.artifactBytes > 1);
    assert.equal(session.artifactReservedBytes, 0);
    backend.limits.sessionTotalBytes = session.artifactBytes + 1024;
    await assert.rejects(
      () => backend.handle('run_code', { sessionId: 'cross-type', code: "return 'R'.repeat(10 * 1024);", observation: { mode: 'none' } }),
      (error: unknown) => errorCode(error, 'ARTIFACT_TOO_LARGE'),
    );
    assert.equal(session.artifactReservedBytes, 0);
    const files = await readdir(sessionDir, { recursive: true });
    assert.equal(files.some((name) => String(name).endsWith('.partial')), false);
  });

  await withBackend(async (backend, artifactDir) => {
    await backend.handle('open', { sessionId: 'small-quota', artifactDir, url: `${baseUrl}/` });
    await assert.rejects(
      () => backend.handle('observe', { sessionId: 'small-quota', observation: { screenshot: true } }),
      (error: unknown) => errorCode(error, 'ARTIFACT_TOO_LARGE'),
    );
    const files = await readdir(artifactDir, { recursive: true });
    assert.equal(files.some((name) => String(name).endsWith('.png')), false);
  }, { maxSessionArtifactBytes: 1 });
});

test('run_code rejects oversized result artifacts instead of saving a capped prefix', { skip: !HAS_BROWSER, timeout: 30_000 }, async () => {
  await withBackend(async (backend, artifactDir) => {
    await backend.handle('open', { sessionId: 'oversized-code', artifactDir, url: `${baseUrl}/` });
    await assert.rejects(
      () => backend.handle('run_code', { sessionId: 'oversized-code', code: "return 'X'.repeat(10 * 1024);", observation: { mode: 'none' } }),
      (error: unknown) => errorCode(error, 'ARTIFACT_TOO_LARGE'),
    );
    await assert.rejects(
      () => backend.handle('run_code', { sessionId: 'oversized-code', code: "return await helpers.writeArtifact('large.bin', 'H'.repeat(10 * 1024));", observation: { mode: 'none' } }),
      (error: unknown) => errorCode(error, 'ARTIFACT_TOO_LARGE'),
    );
    const files = await readdir(artifactDir, { recursive: true });
    assert.equal(files.some((name) => String(name).endsWith('.json')), false);
  }, { maxRunCodeResultBytes: 4096 });
});

test('telemetry fitting counts omitted entries and remains below the sidecar envelope cap', () => {
  const backend = new PlaywrightBackend();
  const session = backend.makeSession('telemetry', { artifactDir: tmpdir() });
  for (let index = 0; index < 100; index += 1) backend.pushEvent(session, 'console', { type: 'error', text: `entry-${index}` });
  const first = backend.collectEvents(session, { consoleLimit: 25 });
  assert.equal(first.console.length, 25);
  assert.equal(first.dropped.console, 75);
  const second = backend.collectEvents(session, { consoleLimit: 25 });
  assert.equal(second.console.length, 0);
  assert.equal(second.dropped.console, 75);

  const heavy = backend.makeSession('heavy', { artifactDir: tmpdir() });
  for (let index = 0; index < 200; index += 1) {
    backend.pushEvent(heavy, 'console', { type: 'error', text: 'c'.repeat(500) });
    backend.pushEvent(heavy, 'pageErrors', { message: 'p'.repeat(1000) });
    backend.pushEvent(heavy, 'failedRequests', { method: 'GET', url: `https://example.test/${'u'.repeat(2000)}`, failure: 'f'.repeat(500) });
    backend.pushEvent(heavy, 'downloads', { suggestedFilename: 'd.bin', url: `https://example.test/${'d'.repeat(2000)}`, state: 'saved', path: `C:/${'x'.repeat(500)}`, bytes: 1 });
  }
  const events = backend.collectEvents(heavy, { consoleLimit: 200, pageErrorLimit: 200, requestLimit: 200, downloadLimit: 200 });
  assert.ok(Object.values(events.dropped).some((count: any) => count > 0));
  const tabs = Array.from({ length: 100 }, (_, index) => ({ pageId: `p${index}`, url: `https://example.test/${'t'.repeat(2000)}`, title: 'title', active: index === 0 }));
  assert.doesNotThrow(() => encodeSidecarRecord({
    v: 1, kind: 'response', id: 'bounded', ok: true,
    result: { observation: { pageId: 'p1', url: 'about:blank', title: '', revision: 1, snapshot: 's'.repeat(16 * 1024), events, tabs } },
  }));
});
