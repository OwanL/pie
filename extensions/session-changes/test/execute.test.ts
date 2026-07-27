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
interface SessionOptions {
  toolPath?: string | ((dir: string) => string);
  cwd?: string | null | ((dir: string) => string);
}

async function makeSession(options: SessionOptions = {}): Promise<{ dir: string; file: string; sessionPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sc-exec-'));
  const file = path.join(dir, 'created.ts');
  const toolPath = typeof options.toolPath === 'function' ? options.toolPath(dir) : options.toolPath;
  const cwd = typeof options.cwd === 'function' ? options.cwd(dir) : options.cwd === undefined ? dir : options.cwd;
  await fs.writeFile(file, 'hello\nworld\n');
  const entries = [
    { type: 'session', version: 3, id: 's', timestamp: 't', ...(cwd === null ? {} : { cwd }) },
    {
      type: 'message', id: 'm1', timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'write', arguments: { path: toolPath ?? 'created.ts', content: 'hello\nworld\n' } }] },
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

test('execute: list renders absolute paths inside the session cwd as relative', async () => {
  const session = await makeSession({ toolPath: (dir) => path.join(dir, 'created.ts') });
  try {
    const res = await exe({ action: 'list', sessionPath: session.sessionPath });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /A\tcreated\.ts\t\+2\t-0/);
    assert.equal(textOf(res).includes(session.dir), false);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
  }
});

test('execute: list keeps paths outside the session cwd absolute', async () => {
  const outsidePath = path.join(os.tmpdir(), `pie-sc-outside-${Date.now()}.ts`);
  const session = await makeSession({ toolPath: outsidePath });
  try {
    const res = await exe({ action: 'list', sessionPath: session.sessionPath });
    assert.equal(res.isError, false);
    assert.equal(textOf(res).includes(outsidePath), true);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
  }
});

test('execute: list makes relative traversal outside cwd explicitly absolute', async () => {
  const session = await makeSession({ toolPath: path.join('..', 'outside.ts') });
  try {
    const res = await exe({ action: 'list', sessionPath: session.sessionPath });
    const expected = path.resolve(session.dir, '..', 'outside.ts');
    assert.equal(res.isError, false);
    assert.equal(textOf(res).includes(expected), true);
    assert.equal(textOf(res).includes(`\t..${path.sep}outside.ts\t`), false);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
  }
});

test('execute: list does not confuse a sibling sharing the cwd name prefix for a descendant', async () => {
  const session = await makeSession({
    toolPath: (dir) => path.join(path.dirname(dir), `${path.basename(dir)}-sibling`, 'file.ts'),
  });
  try {
    const expected = path.join(path.dirname(session.dir), `${path.basename(session.dir)}-sibling`, 'file.ts');
    const res = await exe({ action: 'list', sessionPath: session.sessionPath });
    assert.equal(res.isError, false);
    assert.equal(textOf(res).includes(expected), true);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
  }
});

test('execute: list handles a session cwd with a trailing separator', async () => {
  const session = await makeSession({
    cwd: (dir) => `${dir}${path.sep}`,
    toolPath: (dir) => path.join(dir, 'created.ts'),
  });
  try {
    const res = await exe({ action: 'list', sessionPath: session.sessionPath });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /A\tcreated\.ts\t\+2\t-0/);
    assert.equal(textOf(res).includes(session.dir), false);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
  }
});

test('execute: list preserves an absolute path when the session header has no cwd', async () => {
  const session = await makeSession({ cwd: null, toolPath: (dir) => path.join(dir, 'created.ts') });
  try {
    const res = await exe({ action: 'list', sessionPath: session.sessionPath });
    assert.equal(res.isError, false);
    assert.equal(textOf(res).includes(session.file), true);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
  }
});

test('execute: list handles Windows path casing and slash variants', { skip: process.platform !== 'win32' }, async () => {
  const session = await makeSession({
    toolPath: (dir) => path.join(dir.toUpperCase().replaceAll('\\', '/'), 'created.ts'),
  });
  try {
    const res = await exe({ action: 'list', sessionPath: session.sessionPath });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /A\tcreated\.ts\t\+2\t-0/i);
    assert.equal(textOf(res).toLowerCase().includes(session.dir.toLowerCase()), false);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
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

test('execute: diff renders an absolute manifest path inside cwd as relative', async () => {
  const session = await makeSession({ toolPath: (dir) => path.join(dir, 'created.ts') });
  try {
    const res = await exe({ action: 'diff', sessionPath: session.sessionPath, path: ['created.ts'] });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /^A created\.ts /m);
    assert.equal(textOf(res).includes(session.dir), false);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
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

// ─── deletion verification (a "deleted" file that still exists is not deleted) ─

/** Build a session whose bash `rm` targets a file that STILL EXISTS on disk —
 *  the deletion did not take effect (or the file was regenerated). The
 *  manifest must not claim it is deleted. */
async function makeSessionWithStaleDeletion(): Promise<{ dir: string; file: string; sessionPath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sc-del-'));
  const file = path.join(dir, 'gen.uid');
  await fs.writeFile(file, 'regenerated\n');
  const entries = [
    { type: 'session', version: 3, id: 's', timestamp: 't', cwd: dir },
    {
      type: 'message', id: 'm1', timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'rm gen.uid' } }] },
    },
    { type: 'message', id: 'tr1', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: 'ok', isError: false } },
  ];
  const sessionPath = path.join(dir, 'session.jsonl');
  await fs.writeFile(sessionPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return { dir, file, sessionPath };
}

test('execute: list does not report a deleted file that still exists on disk as deleted', async () => {
  const { dir, sessionPath } = await makeSessionWithStaleDeletion();
  try {
    const res = await exe({ action: 'list', sessionPath });
    assert.equal(res.isError, false);
    const text = textOf(res);
    // The file exists on disk → must NOT be reported as deleted (D).
    assert.equal(text.split('\n').some((l) => l.startsWith('D\t')), false, 'a file that still exists must not be reported as deleted');
    // It is downgraded to modified (M) — present, not suppressed.
    assert.ok(text.split('\n').some((l) => l.startsWith('M\t')), 'downgraded to modified');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('execute: list reports a real deletion (file actually gone) as deleted', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-sc-real-del-'));
  // Do NOT create the file — it is genuinely absent (a real deletion).
  const entries = [
    { type: 'session', version: 3, id: 's', timestamp: 't', cwd: dir },
    {
      type: 'message', id: 'm1', timestamp: 't',
      message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'rm gone.ts' } }] },
    },
    { type: 'message', id: 'tr1', timestamp: 't', message: { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: 'ok', isError: false } },
  ];
  const sessionPath = path.join(dir, 'session.jsonl');
  await fs.writeFile(sessionPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  try {
    const res = await exe({ action: 'list', sessionPath });
    assert.equal(res.isError, false);
    assert.ok(textOf(res).split('\n').some((l) => l.startsWith('D\t')), 'a genuinely absent file is a real deletion');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ─── diff lookup: canonical path matching ──────────────────────────────────

test('execute: diff finds a manifest entry via a `./`-prefixed path', async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'diff', sessionPath, path: ['./created.ts'] });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /^A created\.ts /m);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('execute: diff finds a manifest entry via an absolute path inside the cwd', async () => {
  const session = await makeSession({ toolPath: (dir) => path.join(dir, 'created.ts') });
  try {
    const res = await exe({ action: 'diff', sessionPath: session.sessionPath, path: [path.join(session.dir, 'created.ts')] });
    assert.equal(res.isError, false);
    assert.match(textOf(res), /^A created\.ts /m);
  } finally {
    await fs.rm(session.dir, { recursive: true, force: true });
  }
});

test('execute: diff finds a manifest entry via a case-variant path on Windows', { skip: process.platform !== 'win32' }, async () => {
  const { dir, sessionPath } = await makeSession();
  try {
    const res = await exe({ action: 'diff', sessionPath, path: ['CREATED.TS'] });
    assert.equal(res.isError, false);
    // Must resolve to the created-kind entry (all-additions body), not default
    // to modified — proving the case-variant path matched the manifest entry.
    assert.match(textOf(res), /^A created\.ts /m);
    assert.match(textOf(res), /@@ -0,0 \+1,2 @@/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
