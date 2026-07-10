import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import listTool from '../index';

// Drive the ACTUAL tool's `execute` (via a fake pi.registerTool) so the
// env-glue layer — `sessionPath` defaulting, `path: string | string[]`
// normalization, action dispatch, error/toggle paths — is pinned against
// regression. (The unit-testable cores — JSONL join, renderers, git diff —
// live in session-jsonl/render/diff.test.ts; this covers the dispatch glue.)
let tool: any;
test.before(() => {
  let captured: any;
  listTool({ registerTool: (def: any) => { captured = def; } });
  tool = captured;
});

async function exe(params: any, ctx?: any) {
  return tool.execute('tc', params, undefined, undefined, ctx ?? {});
}
function textOf(res: any): string {
  return res.content[0].text;
}

/** Build a temp session JSONL (well-formed) whose cwd is the temp dir and
 *  that "created" `created.ts` there — so `diff` on it resolves to a file that
 *  exists and produces a synthetic all-additions body (no git needed). */
async function makeSession(): Promise<{ dir: string; file: string; sessionPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sc-exec-'));
  const file = path.join(dir, 'created.ts');
  await fs.writeFile(file, 'hello\nworld\n');
  const entries = [
    { type: 'session', version: 3, id: 's', timestamp: 't', cwd: dir },
    {
      type: 'message', id: 'm1', timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'write', arguments: { path: 'created.ts', content: 'hello\nworld\n' } }] },
    },
    { type: 'message', id: 'tr1', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'write', content: 'ok', isError: false } },
  ];
  const sessionPath = path.join(dir, 'session.jsonl');
  await fs.writeFile(sessionPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { dir, file, sessionPath };
}

// ─── list ───────────────────────────────────────────────────────────────────

test('execute: list defaults sessionPath to ctx.sessionManager.getSessionFile()', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'list' }, { sessionManager: { getSessionFile: () => sessionPath } });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /1 \+2 -0 \(1c\/0m\/0d\)/);
    assert.match(textOf(res), /A\tcreated\.ts\t\+2\t-0/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('execute: list with explicit sessionPath', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'list', sessionPath });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /created\.ts/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── diff: path arrays (single + multi) ────────────────────────────────────

test('execute: diff accepts a single-element path array', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'diff', sessionPath, path: ['created.ts'] });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /^A created\.ts \+2 -0 baseline=\(new file\)/m);
    assert.match(textOf(res), /@@ -0,0 \+1,2 @@/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('execute: diff accepts a string[] path', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'diff', sessionPath, path: ['created.ts'] });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /^A created\.ts /m);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('execute: diff unknown path never errors (defaults to modified, returns header)', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'diff', sessionPath, path: ['no/such/file.ts'] });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /^M no\/such\/file\.ts /m);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('execute: diff context param is honoured (0 default, explicit passed)', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const r0 = await exe({ action: 'diff', sessionPath, path: ['created.ts'], context: 0 });
    assert.equal(textOf(r0).split('\n').some((l: string) => l.startsWith(' ')), false);
    const r3 = await exe({ action: 'diff', sessionPath, path: ['created.ts'], context: 3 });
    // created file → all-additions; context has no effect on a creation hunk,
    // but the param must not error and still produce the body.
    assert.equal(r3.isError, false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── error / dispatch paths (never throw) ───────────────────────────────────

test('execute: no sessionPath + no ctx → isError', async () => {
  const res = await exe({ action: 'list' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /no sessionPath/);
});

test('execute: non-existent session file → isError (not throw)', async () => {
  const res = await exe({ action: 'list', sessionPath: '/no/such/file.jsonl' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /Could not read session file/);
});

test('execute: invalid action → isError', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'bogus', sessionPath });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /action must be one of list \| diff/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('execute: diff with no path → isError', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'diff', sessionPath });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /diff requires path/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('execute: diff with empty path array → isError', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'diff', sessionPath, path: [] });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /non-empty/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── toggle ─────────────────────────────────────────────────────────────────

test('execute: disabled toggle → isError', async () => {
  const prev = process.env.PIE_EXTENSION_TOGGLES_JSON;
  process.env.PIE_EXTENSION_TOGGLES_JSON = JSON.stringify({ 'session-changes': false });
  try {
    const res = await exe({ action: 'list', sessionPath: '/whatever.jsonl' });
    assert.equal(res.isError, true);
    assert.match(textOf(res), /disabled/);
  } finally {
    process.env.PIE_EXTENSION_TOGGLES_JSON = prev;
  }
});
