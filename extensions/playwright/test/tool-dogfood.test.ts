import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { chromium } from 'playwright';

import registerPlaywright from '../index.js';
import { runtimeRegistry } from '../src/runtime-client.js';

function browserAvailable(): boolean {
  try { return existsSync(chromium.executablePath()); } catch { return false; }
}
function captureTool(): { tool: any; shutdown?: (event: unknown, ctx: unknown) => Promise<void> } {
  let tool: any; let shutdown: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  registerPlaywright({
    registerTool(value: any) { tool = value; },
    on(name: string, handler: (event: unknown, ctx: unknown) => Promise<void>) { if (name === 'session_shutdown') shutdown = handler; },
  } as any);
  return { tool, shutdown };
}
function textOf(result: any): string { return result.content.find((part: any) => part.type === 'text')?.text ?? ''; }
function field(text: string, name: string): string {
  const match = text.match(new RegExp(`^${name}: (.+)$`, 'm'));
  assert.ok(match, `missing ${name} in result:\n${text}`);
  return match[1];
}
function refFor(text: string, linePattern: RegExp): string {
  const line = text.split('\n').find((candidate) => linePattern.test(candidate));
  const match = line?.match(/\[ref=([^\]\s]+)\]/);
  assert.ok(match, `missing ref for ${linePattern}:\n${text}`);
  return match[1];
}

test('public playwright tool completes a rendered ref workflow without screenshots, then one explicit visual assertion', { skip: !browserAvailable(), timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pw-tool-dogfood-'));
  const sessionPath = path.join(root, 'durable-session.jsonl');
  await writeFile(sessionPath, '');
  const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'browser-fixture.html');
  const fixture = await readFile(fixturePath, 'utf8');
  const server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(fixture);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/`;
  const context = { sessionManager: { getSessionFile: () => sessionPath }, model: { input: ['text', 'image'] } };
  const { tool, shutdown } = captureTool();
  try {
    const opened = await tool.execute('open', { action: 'open', sessionId: 'dogfood', url }, undefined, undefined, context);
    const openText = textOf(opened);
    const pageId = field(openText, 'page');
    const openRevision = Number(field(openText, 'revision'));
    const emailRef = refFor(openText, /textbox "Email"/);

    const filled = await tool.execute('fill', {
      action: 'act', sessionId: 'dogfood', pageId,
      input: { kind: 'fill', target: { ref: emailRef, revision: openRevision }, value: 'dogfood@example.test' },
    }, undefined, undefined, context);
    assert.equal(filled.content.some((part: any) => part.type === 'image'), false, 'ordinary ref workflow must not emit screenshots');
    const fillText = textOf(filled);
    const fillRevision = Number(field(fillText, 'revision'));
    const submitRef = refFor(fillText, /button "Submit"/);

    const submitted = await tool.execute('submit', {
      action: 'act', sessionId: 'dogfood', pageId,
      input: { kind: 'click', target: { ref: submitRef, revision: fillRevision } },
    }, undefined, undefined, context);
    assert.match(textOf(submitted), /submitted:dogfood@example\.test/);
    assert.equal(submitted.content.some((part: any) => part.type === 'image'), false);

    const canvas = await tool.execute('canvas', {
      action: 'run_code', sessionId: 'dogfood',
      code: "return await page.locator('#demo-canvas').evaluate((element) => Array.from(element.getContext('2d').getImageData(0, 0, 1, 1).data));",
      observation: { mode: 'none' },
    }, undefined, undefined, context);
    assert.match(textOf(canvas), /255/);

    const visual = await tool.execute('visual', {
      action: 'observe', sessionId: 'dogfood', pageId,
      observation: { screenshot: true, target: { selector: 'main' } },
    }, undefined, undefined, context);
    assert.equal(visual.content.filter((part: any) => part.type === 'image').length, 1, 'one explicit screenshot produces one image part');
    assert.match(textOf(visual), /display_png:/);

    const closed = await tool.execute('close', { action: 'close', scope: 'session', sessionId: 'dogfood' }, undefined, undefined, context);
    assert.match(textOf(closed), /closed_session: dogfood/);
  } finally {
    await shutdown?.(undefined, context);
    await runtimeRegistry.shutdownSession(sessionPath);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
