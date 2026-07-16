import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import { Module } from 'node:module';

import { createInitialArchState } from '../../../../src/host/core/arch-state';
import type { ArchState } from '../../../../src/host/core/arch-state';
import type { FileChangeEntry } from '../../../../src/shared/protocol';

// file-diff-service.ts does `import * as vscode from 'vscode'`, which tsx
// transpiles to `require('vscode')`. There is no `vscode` runtime module under
// node_modules in this repo (only @types/vscode), so we intercept the bare
// 'vscode' specifier at the CJS loader and return an inline mock. The mock's
// `workspace.workspaceFolders` is mutable so per-test cases can exercise both
// the "fallback present" and "fallback absent" branches of resolveFileChangePath.
// `commands.executeCommand` records every call so diff/open wiring tests can
// inspect the URIs handed to `vscode.diff` (e.g. the baseline git ref).
const capturedCommands: Array<{ cmd: string; args: unknown[] }> = [];
const capturedWarnings: string[] = [];

// A minimal Uri mock whose `with()` returns a fresh object carrying the
// `scheme`/`query` patch — enough for FileDiffService.toGitUri / toEmptyDiffUri
// to build `git://` diff URIs whose `query` the tests can parse.
function mockUri(p: string): Record<string, unknown> {
  const base: Record<string, unknown> = {
    fsPath: p,
    scheme: 'file',
    path: p,
    query: '',
    fragment: '',
  };
  return {
    ...base,
    with: (patch: Record<string, unknown>): Record<string, unknown> => ({ ...base, ...patch }),
  };
}

const integrationTest = process.env.PIE_RUN_INTEGRATION_TESTS === '1' ? test : test.skip;

const vscodeMock = {
  workspace: {
    workspaceFolders: undefined as Array<{ uri: { fsPath: string } }> | undefined,
  },
  Uri: { file: (p: string) => mockUri(p) },
  commands: {
    executeCommand: async (...args: unknown[]): Promise<undefined> => {
      capturedCommands.push({ cmd: args[0] as string, args: args.slice(1) });
      return undefined;
    },
  },
  window: {
    showWarningMessage: async (message: string) => {
      capturedWarnings.push(message);
      return undefined;
    },
  },
};
// `Module._load` is an internal/undocumented hook (absent from @types/node),
// so cast to a small typed shape. The patch is installed in `test.before` only
// long enough to resolve `vscode` during the lazy import, then restored in a
// `finally` (mirroring backend-client.test.ts's finally-scoped restore). The
// immediate restore matters: node:test's top-level after hooks are GLOBAL under
// --test-isolation=none, so a hook-only restore would leave the shim live for
// the whole run and leak it into other files sharing the process. file-diff-
// service captures its `vscode` binding at load time, so the shim is unneeded
// once the import returns. A defensive `test.after` is kept as a backstop.
const NodeModule = Module as unknown as {
  _load: (request: string, ...rest: unknown[]) => unknown;
};
let origLoad: ((request: string, ...rest: unknown[]) => unknown) | undefined;

// Imported lazily (after the vscode shim is in place) because the module
// resolves `vscode` at load time. arch-state is pure (no vscode) so it is
// imported statically above.
let FileDiffService: typeof import('../../../../src/host/core/file-diff-service').FileDiffService;
let EMPTY_DIFF_SCHEME: typeof import('../../../../src/host/core/file-diff-service').EMPTY_DIFF_SCHEME;

test.before(async () => {
  origLoad = NodeModule._load.bind(NodeModule);
  NodeModule._load = (request: string, ...rest: unknown[]) => {
    if (request === 'vscode') return vscodeMock;
    return origLoad!(request, ...rest);
  };
  try {
    ({ FileDiffService, EMPTY_DIFF_SCHEME } = await import('../../../../src/host/core/file-diff-service'));
  } finally {
    NodeModule._load = origLoad;
    origLoad = undefined;
  }
});

test.after(() => {
  // Defensive backstop: restore if `before` threw before its finally ran.
  if (origLoad) {
    NodeModule._load = origLoad;
    origLoad = undefined;
  }
});

function archStateWith(over: {
  sessions?: Array<{ path: string; cwd: string }>;
  workspaceCwd?: string | null;
  fileChanges?: Record<string, FileChangeEntry[]>;
}): ArchState {
  const s = createInitialArchState();
  return {
    ...s,
    sessions: {
      ...s.sessions,
      sessions: (over.sessions ?? s.sessions.sessions) as ArchState['sessions']['sessions'],
      workspaceCwd: over.workspaceCwd ?? s.sessions.workspaceCwd,
    },
    fileChanges: {
      ...s.fileChanges,
      bySession: over.fileChanges ?? s.fileChanges.bySession,
    },
  };
}

function entry(pathStr: string, kind: FileChangeEntry['kind']): FileChangeEntry {
  return { path: pathStr, kind, toolCallId: 't', messageId: 'm', description: '', timestamp: '' };
}

// Clear captured vscode command calls between tests so wiring assertions
// only see their own `vscode.diff` invocation.
test.beforeEach(() => {
  capturedCommands.length = 0;
  capturedWarnings.length = 0;
});

// ─── resolveFileChangePath ───────────────────────────────────────────────────

test('resolveFileChangePath passes an absolute path through unchanged', () => {
  const svc = new FileDiffService(() => archStateWith({}));
  assert.equal(svc.resolveFileChangePath('s', '/abs/file.txt'), '/abs/file.txt');
});

test('resolveFileChangePath resolves a relative path against the matching session cwd', () => {
  const svc = new FileDiffService(() =>
    archStateWith({ sessions: [{ path: 's', cwd: '/proj' }] }),
  );
  assert.equal(
    svc.resolveFileChangePath('s', 'a/b.txt'),
    path.resolve('/proj', 'a/b.txt'),
  );
});

test('resolveFileChangePath falls back to workspaceCwd when the session is unknown', () => {
  const svc = new FileDiffService(() => archStateWith({ workspaceCwd: '/ws' }));
  assert.equal(svc.resolveFileChangePath('missing', 'a.txt'), path.resolve('/ws', 'a.txt'));
});

test('resolveFileChangePath prefers the session cwd over workspaceCwd', () => {
  const svc = new FileDiffService(() =>
    archStateWith({ sessions: [{ path: 's', cwd: '/proj' }], workspaceCwd: '/ws' }),
  );
  assert.equal(svc.resolveFileChangePath('s', 'a.txt'), path.resolve('/proj', 'a.txt'));
});

test('resolveFileChangePath falls back to the first vscode workspace folder when nothing else is set', () => {
  vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: '/ws/root' } }];
  try {
    const svc = new FileDiffService(() => archStateWith({ workspaceCwd: null }));
    assert.equal(svc.resolveFileChangePath('s', 'rel/file.txt'), path.resolve('/ws/root', 'rel/file.txt'));
  } finally {
    vscodeMock.workspace.workspaceFolders = undefined;
  }
});

test('resolveFileChangePath returns the relative path unchanged when no base path is available anywhere', () => {
  vscodeMock.workspace.workspaceFolders = undefined;
  const svc = new FileDiffService(() => archStateWith({ workspaceCwd: null }));
  assert.equal(svc.resolveFileChangePath('s', 'rel/file.txt'), 'rel/file.txt');
});

// ─── getFileChangeKind ───────────────────────────────────────────────────────

test('getFileChangeKind defaults to "modified" when the session has no entries', () => {
  const svc = new FileDiffService(() => archStateWith({}));
  assert.equal(svc.getFileChangeKind('s', 'x.txt', '/abs/x.txt'), 'modified');
});

test('getFileChangeKind returns the entry kind when entry.path matches filePath', () => {
  const svc = new FileDiffService(() =>
    archStateWith({ fileChanges: { s: [entry('x.txt', 'created')] } }),
  );
  assert.equal(svc.getFileChangeKind('s', 'x.txt', '/abs/x.txt'), 'created');
});

test('getFileChangeKind matches by resolved path even when entry.path differs from filePath', () => {
  // entry.path is relative ('a/b.txt'); filePath is a different label ('x.txt')
  // but resolvedPath equals the entry's resolved path → match.
  const svc = new FileDiffService(() =>
    archStateWith({
      sessions: [{ path: 's', cwd: '/proj' }],
      fileChanges: { s: [entry('a/b.txt', 'deleted')] },
    }),
  );
  const resolved = path.resolve('/proj', 'a/b.txt');
  assert.equal(svc.getFileChangeKind('s', 'x.txt', resolved), 'deleted');
});

test('getFileChangeKind returns "modified" when entries exist but none match', () => {
  const svc = new FileDiffService(() =>
    archStateWith({ fileChanges: { s: [entry('other.txt', 'created')] } }),
  );
  assert.equal(svc.getFileChangeKind('s', 'x.txt', '/abs/x.txt'), 'modified');
});

test('getFileChangeKind picks the matching entry out of several', () => {
  const svc = new FileDiffService(() =>
    archStateWith({
      fileChanges: { s: [entry('first.txt', 'created'), entry('second.txt', 'deleted')] },
    }),
  );
  assert.equal(svc.getFileChangeKind('s', 'second.txt', '/abs/second.txt'), 'deleted');
});

test('getFileChangeKind treats an empty entry list for the session as "modified"', () => {
  const svc = new FileDiffService(() => archStateWith({ fileChanges: { s: [] } }));
  assert.equal(svc.getFileChangeKind('s', 'x.txt', '/abs/x.txt'), 'modified');
});

// ─── resolveBaselineRef / openFileDiff baseline ───────────────────────────────
//
// The changed-files panel is derived from transcript tool calls, and pi
// agents commit their work after each task — so a bare `HEAD` baseline
// already holds the agent's edits and the diff is empty (the "same file on
// both sides" bug). These integration tests spin up a real throwaway git
// repo to verify `resolveBaselineRef` finds the pre-change baseline and that
// `openFileDiff` actually diffs against it.

const execFileP = promisify(execFile);

/** Run git in `dir`; returns `{stdout, code}`. `git diff --exit-code` exits 1
 *  on differences (not an error), so a non-zero numeric `code` is surfaced for
 *  the caller to inspect rather than rejected. */
async function git(
  dir: string,
  args: string[],
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileP('git', args, { cwd: dir, maxBuffer: 1024 * 1024 });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string };
    if (typeof err.code === 'number') return { stdout: err.stdout ?? '', code: err.code };
    throw e;
  }
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, ['init', '-q']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
}

/** Stage everything in `dir` and commit; returns the new HEAD SHA. */
async function commit(dir: string, message: string): Promise<string> {
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  const { stdout } = await git(dir, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function withTempRepo(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-diff-test-'));
  try {
    await initRepo(dir);
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

integrationTest('resolveBaselineRef returns the pre-change commit when the agent change has been committed', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'v1\n');
    const initial = await commit(dir, 'initial');
    await fs.writeFile(file, 'v2\n'); // agent edits …
    await commit(dir, 'agent change'); // … and commits → working tree clean (== HEAD)

    const svc = new FileDiffService(() => createInitialArchState());
    const ref = await svc.resolveBaselineRef(file);

    // Baseline is the pre-change commit (v1), NOT HEAD (v2) — the fix.
    assert.equal(ref, initial);
    const { stdout: baselineContent } = await git(dir, ['show', `${ref}:f.txt`]);
    assert.equal(baselineContent, 'v1\n');
  });
});

integrationTest('resolveBaselineRef returns HEAD when the change is uncommitted (dirty working tree)', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'v1\n');
    const head = await commit(dir, 'initial');
    await fs.writeFile(file, 'v2\n'); // uncommitted agent edit

    const svc = new FileDiffService(() => createInitialArchState());
    // Working tree differs from HEAD → HEAD itself is the baseline (returned
    // as its SHA, which resolves identically to the literal "HEAD" ref).
    const ref = await svc.resolveBaselineRef(file);
    assert.equal(ref, head);
    const { stdout: baselineContent } = await git(dir, ['show', `${ref}:f.txt`]);
    assert.equal(baselineContent, 'v1\n');
  });
});

integrationTest('resolveBaselineRef falls back to HEAD for an untracked file', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'new.txt');
    await fs.writeFile(file, 'hi\n'); // never committed

    const svc = new FileDiffService(() => createInitialArchState());
    assert.equal(await svc.resolveBaselineRef(file), 'HEAD');
  });
});

integrationTest('resolveBaselineRef is robust to unrelated later commits that do not touch the file', async () => {
  // The agent committed the file, then the user committed an UNRELATED file —
  // HEAD no longer touches f.txt, but the baseline must still be the pre-change
  // commit (found via `git log -- <path>`), not the unrelated HEAD.
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'v1\n');
    const initial = await commit(dir, 'initial');
    await fs.writeFile(file, 'v2\n');
    await commit(dir, 'agent change');
    await fs.writeFile(path.join(dir, 'other.txt'), 'x\n');
    await commit(dir, 'unrelated user commit');

    const svc = new FileDiffService(() => createInitialArchState());
    assert.equal(await svc.resolveBaselineRef(file), initial);
  });
});

integrationTest('resolveBaselineRef finds the pre-deletion commit for a file the agent deleted and committed', async () => {
  // kind=deleted → modifiedUri is the empty diff; the LEFT side must be the
  // file's content just before deletion. The walk skips the delete commit
  // (file absent on both sides → no diff) and lands on the last content commit.
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'v1\n');
    const content = await commit(dir, 'initial');
    await fs.rm(file);
    await commit(dir, 'agent deletes file'); // working tree clean, file absent

    const svc = new FileDiffService(() => createInitialArchState());
    const ref = await svc.resolveBaselineRef(file);
    assert.equal(ref, content);
    const { stdout: baselineContent } = await git(dir, ['show', `${ref}:f.txt`]);
    assert.equal(baselineContent, 'v1\n');
  });
});

integrationTest('openFileDiff diffs a committed agent change against the pre-change baseline, not HEAD', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'v1\n');
    const initial = await commit(dir, 'initial');
    await fs.writeFile(file, 'v2\n');
    await commit(dir, 'agent change');

    const svc = new FileDiffService(() =>
      archStateWith({
        sessions: [{ path: 's', cwd: dir }],
        fileChanges: { s: [entry('f.txt', 'modified')] },
      }),
    );
    await svc.openFileDiff('s', 'f.txt');

    const diffCall = capturedCommands.find((c) => c.cmd === 'vscode.diff');
    assert.ok(diffCall, 'vscode.diff was not invoked');
    const originalUri = diffCall!.args[0] as { scheme: string; query: string };
    assert.equal(originalUri.scheme, 'git');
    const { ref } = JSON.parse(originalUri.query) as { path: string; ref: string };
    assert.equal(ref, initial, 'diff left side should be the pre-change commit, not HEAD');
  });
});

integrationTest('openFileDiff uses the empty diff for a created file regardless of git state', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'created.txt');
    await fs.writeFile(file, 'new\n');
    await commit(dir, 'create'); // already committed, but kind=created → empty left side

    const svc = new FileDiffService(() =>
      archStateWith({
        sessions: [{ path: 's', cwd: dir }],
        fileChanges: { s: [entry('created.txt', 'created')] },
      }),
    );
    await svc.openFileDiff('s', 'created.txt');

    const diffCall = capturedCommands.find((c) => c.cmd === 'vscode.diff');
    assert.ok(diffCall, 'vscode.diff was not invoked');
    const originalUri = diffCall!.args[0] as { scheme: string };
    assert.equal(originalUri.scheme, EMPTY_DIFF_SCHEME);
  });
});

integrationTest('openFileDiff does not open a dead URI when a created file no longer exists', async () => {
  await withTempRepo(async (dir) => {
    const svc = new FileDiffService(() =>
      archStateWith({
        sessions: [{ path: 's', cwd: dir }],
        fileChanges: { s: [entry('missing.txt', 'created')] },
      }),
    );

    await svc.openFileDiff('s', 'missing.txt');

    assert.equal(capturedCommands.some((c) => c.cmd === 'vscode.diff'), false);
    assert.match(capturedWarnings[0] ?? '', /no longer exists on disk/i);
    assert.match(capturedWarnings[0] ?? '', /missing\.txt/);
  });
});

integrationTest('openFileDiff treats an existing modified file without a Git baseline as newly created', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-diff-test-'));
  try {
    await fs.writeFile(path.join(dir, 'f.txt'), 'current\n');
    const svc = new FileDiffService(() =>
      archStateWith({
        sessions: [{ path: 's', cwd: dir }],
        fileChanges: { s: [entry('f.txt', 'modified')] },
      }),
    );

    await svc.openFileDiff('s', 'f.txt');

    const diffCall = capturedCommands.find((c) => c.cmd === 'vscode.diff');
    assert.ok(diffCall, 'vscode.diff was not invoked');
    assert.equal((diffCall.args[0] as { scheme: string }).scheme, EMPTY_DIFF_SCHEME);
    assert.equal((diffCall.args[1] as { scheme: string }).scheme, 'file');
    assert.match(capturedWarnings[0] ?? '', /no Git baseline/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

integrationTest('openFileDiff does not open a bogus Git URI for a deleted non-git file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-diff-test-'));
  try {
    const svc = new FileDiffService(() =>
      archStateWith({
        sessions: [{ path: 's', cwd: dir }],
        fileChanges: { s: [entry('deleted.txt', 'deleted')] },
      }),
    );

    await svc.openFileDiff('s', 'deleted.txt');

    assert.equal(capturedCommands.some((c) => c.cmd === 'vscode.diff'), false);
    assert.match(capturedWarnings[0] ?? '', /no Git baseline/i);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

integrationTest('openFileDiff shows the Git baseline for a deleted committed file', async () => {
  await withTempRepo(async (dir) => {
    const file = path.join(dir, 'f.txt');
    await fs.writeFile(file, 'before\n');
    const contentRef = await commit(dir, 'initial');
    await fs.rm(file);
    await commit(dir, 'delete');
    const svc = new FileDiffService(() =>
      archStateWith({
        sessions: [{ path: 's', cwd: dir }],
        fileChanges: { s: [entry('f.txt', 'deleted')] },
      }),
    );

    await svc.openFileDiff('s', 'f.txt');

    const diffCall = capturedCommands.find((c) => c.cmd === 'vscode.diff');
    assert.ok(diffCall, 'vscode.diff was not invoked');
    const originalUri = diffCall.args[0] as { scheme: string; query: string };
    assert.equal(originalUri.scheme, 'git');
    assert.equal((JSON.parse(originalUri.query) as { ref: string }).ref, contentRef);
    assert.equal((diffCall.args[1] as { scheme: string }).scheme, EMPTY_DIFF_SCHEME);
    assert.match(capturedWarnings[0] ?? '', /last available Git version/i);
  });
});
