import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
  LEGACY_SESSION_SETTINGS_DIR_ENV,
  SESSION_SETTINGS_DIR_ENV,
  isSystemPromptTogglePersistenceAvailable,
  readSystemPromptToggles,
  readSystemPromptTogglesForSession,
  writeSystemPromptTogglesForSession,
} from '../session-settings-store';

/** Success persistence is approved only for Windows fixed-local-NTFS
 * directories, so lock-based write expectations run on win32 only. This is a
 * platform gate, not a storage probe: on Windows a broken storage qualification
 * fails the test instead of silently skipping it. */
const successPersistenceSkip = process.platform !== 'win32'
  ? 'success persistence requires Windows fixed-local-NTFS storage'
  : false;

async function withSidecarDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-system-prompt-toggles-'));
  const previous = process.env[SESSION_SETTINGS_DIR_ENV];
  const previousLegacy = process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
  process.env[SESSION_SETTINGS_DIR_ENV] = dir;
  delete process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
  try {
    await run(dir);
  } finally {
    if (previous === undefined) {
      delete process.env[SESSION_SETTINGS_DIR_ENV];
    } else {
      process.env[SESSION_SETTINGS_DIR_ENV] = previous;
    }
    if (previousLegacy === undefined) delete process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
    else process.env[LEGACY_SESSION_SETTINGS_DIR_ENV] = previousLegacy;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('system-prompt toggle store persists, deduplicates, and removes per-session entries', { skip: successPersistenceSkip }, async () => {
  await withSidecarDir(async (dir) => {
    await writeSystemPromptTogglesForSession('/sessions/one.jsonl', ['harness', 'harness', 'skills']);
    await writeSystemPromptTogglesForSession('/sessions/two.jsonl', ['tools']);

    assert.deepEqual(await readSystemPromptToggles(), {
      '/sessions/one.jsonl': ['harness', 'skills'],
      '/sessions/two.jsonl': ['tools'],
    });
    assert.deepEqual(await readSystemPromptTogglesForSession('/sessions/one.jsonl'), ['harness', 'skills']);

    await writeSystemPromptTogglesForSession('/sessions/one.jsonl', []);
    assert.deepEqual(await readSystemPromptToggles(), {
      '/sessions/two.jsonl': ['tools'],
    });
    assert.equal(
      await fs.readFile(path.join(dir, 'system-prompt-toggles.json'), 'utf8'),
      '{\n  "/sessions/two.jsonl": [\n    "tools"\n  ]\n}\n',
    );
  });
});

test('system-prompt toggle store serializes concurrent read-modify-write updates', { skip: successPersistenceSkip }, async () => {
  await withSidecarDir(async (dir) => {
    await Promise.all([
      writeSystemPromptTogglesForSession('/sessions/one.jsonl', ['harness']),
      writeSystemPromptTogglesForSession('/sessions/two.jsonl', ['skills']),
      writeSystemPromptTogglesForSession('/sessions/three.jsonl', ['tools']),
    ]);

    assert.deepEqual(await readSystemPromptToggles(), {
      '/sessions/one.jsonl': ['harness'],
      '/sessions/two.jsonl': ['skills'],
      '/sessions/three.jsonl': ['tools'],
    });
    assert.deepEqual(
      (await fs.readdir(dir)).filter((name) => name.endsWith('.tmp')),
      [],
      'completed atomic writes clean up their temporary files',
    );
  });
});

test('system-prompt toggle store treats missing and malformed sidecars as empty', async () => {
  await withSidecarDir(async (dir) => {
    assert.deepEqual(await readSystemPromptToggles(), {});

    await fs.writeFile(path.join(dir, 'system-prompt-toggles.json'), '{ malformed', 'utf8');
    assert.deepEqual(await readSystemPromptTogglesForSession('/sessions/one.jsonl'), []);
  });
});

test('mutations preserve a multi-session sidecar on read I/O failure', { skip: successPersistenceSkip }, async (t) => {
  await withSidecarDir(async (dir) => {
    const file = path.join(dir, 'system-prompt-toggles.json');
    const bytes = JSON.stringify({ '/sessions/one.jsonl': ['harness'], '/sessions/two.jsonl': ['tools'] });
    await fs.writeFile(file, bytes);
    const readFile = fs.readFile;
    const failure = Object.assign(new Error('injected read failure'), { code: 'EACCES' });
    const mock = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
      if (args[0] === file) throw failure;
      return readFile(...args);
    });
    try {
      assert.deepEqual(await readSystemPromptToggles(), {});
      await assert.rejects(writeSystemPromptTogglesForSession('/sessions/one.jsonl', [], true), failure);
      await writeSystemPromptTogglesForSession('/sessions/three.jsonl', ['skills']);
    } finally {
      mock.mock.restore();
    }
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    assert.deepEqual(await fs.readdir(dir), ['system-prompt-toggles.json']);
    await writeSystemPromptTogglesForSession('/sessions/three.jsonl', ['skills'], true);
    assert.deepEqual(await readSystemPromptToggles(), {
      '/sessions/one.jsonl': ['harness'], '/sessions/two.jsonl': ['tools'], '/sessions/three.jsonl': ['skills'],
    });
  });
});

test('mutations reject malformed existing state without replacing its bytes', { skip: successPersistenceSkip }, async () => {
  await withSidecarDir(async (dir) => {
    const file = path.join(dir, 'system-prompt-toggles.json');
    for (const bytes of [
      '{"/sessions/one.jsonl":["harness"],"/sessions/two.jsonl":["tools"]',
      '{"/sessions/one.jsonl":["harness"],"/sessions/two.jsonl":42}',
      'null', '[]',
    ]) {
      await fs.writeFile(file, bytes);
      await assert.rejects(writeSystemPromptTogglesForSession('/sessions/three.jsonl', ['skills'], true));
      await writeSystemPromptTogglesForSession('/sessions/one.jsonl', []);
      assert.equal(await fs.readFile(file, 'utf8'), bytes);
      assert.deepEqual(await fs.readdir(dir), ['system-prompt-toggles.json']);
    }
  });
});

test('system-prompt toggles read the legacy review sidecar and scrub it after migration', { skip: successPersistenceSkip }, async () => {
  const currentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-settings-'));
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-legacy-session-settings-'));
  const previousCurrent = process.env[SESSION_SETTINGS_DIR_ENV];
  const previousLegacy = process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
  process.env[SESSION_SETTINGS_DIR_ENV] = currentDir;
  process.env[LEGACY_SESSION_SETTINGS_DIR_ENV] = legacyDir;
  try {
    const sessionPath = '/sessions/legacy.jsonl';
    await fs.writeFile(
      path.join(legacyDir, 'system-prompt-toggles.json'),
      JSON.stringify({ [sessionPath]: ['harness'], '/sessions/other.jsonl': ['tools'] }) + '\n',
      'utf8',
    );
    assert.deepEqual(await readSystemPromptTogglesForSession(sessionPath), ['harness']);

    await writeSystemPromptTogglesForSession(sessionPath, ['skills']);
    assert.deepEqual(await readSystemPromptTogglesForSession(sessionPath), ['skills']);
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(currentDir, 'system-prompt-toggles.json'), 'utf8')),
      { [sessionPath]: ['skills'], '/sessions/other.jsonl': ['tools'] },
    );
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(legacyDir, 'system-prompt-toggles.json'), 'utf8')),
      { '/sessions/other.jsonl': ['tools'] },
    );

    const currentFile = path.join(currentDir, 'system-prompt-toggles.json');
    const legacyFile = path.join(legacyDir, 'system-prompt-toggles.json');
    const currentBytes = await fs.readFile(currentFile, 'utf8');
    const legacyBytes = '{"/sessions/legacy.jsonl":["harness"],"/sessions/other.jsonl":["tools"]';
    await fs.writeFile(legacyFile, legacyBytes);
    await assert.rejects(writeSystemPromptTogglesForSession(sessionPath, [], true));
    assert.equal(await fs.readFile(currentFile, 'utf8'), currentBytes, 'legacy scrub is validated before current replacement');
    assert.equal(await fs.readFile(legacyFile, 'utf8'), legacyBytes);
    assert.deepEqual(await readSystemPromptTogglesForSession(sessionPath), ['skills']);

    await fs.unlink(currentFile);
    assert.deepEqual(await readSystemPromptToggles(), {});
    await assert.rejects(writeSystemPromptTogglesForSession(sessionPath, ['tools'], true));
    await assert.rejects(fs.readFile(currentFile), { code: 'ENOENT' });
    assert.equal(await fs.readFile(legacyFile, 'utf8'), legacyBytes);
  } finally {
    if (previousCurrent === undefined) delete process.env[SESSION_SETTINGS_DIR_ENV];
    else process.env[SESSION_SETTINGS_DIR_ENV] = previousCurrent;
    if (previousLegacy === undefined) delete process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
    else process.env[LEGACY_SESSION_SETTINGS_DIR_ENV] = previousLegacy;
    await fs.rm(currentDir, { recursive: true, force: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});

async function waitForChildExit(child: ReturnType<typeof fork>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(child, 'exit').then(() => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopUnsupportedChild(child: ReturnType<typeof fork>): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 2000)) return true;
  child.kill('SIGKILL');
  return waitForChildExit(child, 2000);
}

test('unsupported platform strictly rejects persistence without creating directories or files', async () => {
  type UnsupportedReport = { kind: string; name?: string; value?: unknown; message?: string; error?: string };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-toggles-unsupported-'));
  const existing = path.join(root, 'existing');
  const missingCurrent = path.join(root, 'missing-current');
  const missingLegacy = path.join(root, 'missing-legacy');
  await fs.mkdir(existing, { recursive: true });
  const env = { ...process.env };
  delete env.PIE_SESSION_SETTINGS_DIR;
  delete env.PIE_LEGACY_SESSION_SETTINGS_DIR;
  const child = fork(path.join(__dirname, 'system-prompt-toggle-unsupported-child.cjs'), [], {
    env, execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const messages: UnsupportedReport[] = [];
  child.on('message', message => messages.push(message as UnsupportedReport));
  let primaryError: unknown;
  let childExited = false;
  try {
    child.send({ kind: 'run', existing, missingCurrent, missingLegacy });
    const deadline = Date.now() + 30000;
    for (;;) {
      if (messages.some(message => message.kind === 'done')) break;
      const failed = messages.find(message => message.kind === 'failed');
      if (failed) throw new Error(String(failed.error));
      if (Date.now() > deadline) throw new Error('unsupported-platform child timed out');
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('child exited before done');
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    for (const name of ['missing', 'existing']) {
      assert.equal(
        messages.find(message => message.kind === 'available' && message.name === name)?.value, true,
        'the rejection is platform-driven, not caused by a missing sidecar directory',
      );
      assert.deepEqual(
        messages.find(message => message.kind === 'read' && message.name === name)?.value, {},
        'portable reads stay available on unsupported platforms',
      );
      assert.equal(
        messages.find(message => message.kind === 'strict-rejected' && message.name === name)?.message,
        'Runtime lock requires Windows',
      );
      assert.ok(
        messages.some(message => message.kind === 'best-effort-completed' && message.name === name),
        'best-effort persistence completes so live in-memory state is not blocked',
      );
    }
    // The open IPC channel keeps the child alive past its work.
    childExited = await stopUnsupportedChild(child);
    if (!childExited) throw new Error('unsupported-platform child did not exit within the bounded teardown');

    assert.deepEqual(
      await fs.readdir(existing), [],
      'no sidecar file or temporary is created in an existing sidecar directory',
    );
    await assert.rejects(
      fs.stat(missingCurrent), { code: 'ENOENT' },
      'no sidecar directory is created when it was missing',
    );
    await assert.rejects(
      fs.stat(missingLegacy), { code: 'ENOENT' },
      'no legacy sidecar directory is created when it was missing',
    );
    assert.deepEqual(
      (await fs.readdir(root)).filter(name => name !== 'existing'), [],
      'the unsupported platform must not create any durable state',
    );
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      if (!childExited) childExited = await stopUnsupportedChild(child);
      if (childExited) {
        await fs.rm(root, { recursive: true, force: true });
      } else {
        const diagnostic = `unsupported-platform child exit could not be confirmed; fixture retained at ${root}`;
        console.error(diagnostic);
        if (primaryError === undefined) primaryError = new Error(diagnostic);
      }
    } catch (cleanupError) {
      const diagnostic = `unsupported-platform child cleanup failed; fixture retained at ${root}: ${String(cleanupError)}`;
      console.error(diagnostic);
      if (primaryError === undefined) primaryError = new Error(diagnostic);
    }
  }
  if (primaryError !== undefined) throw primaryError;
});

test('system-prompt toggle store exposes when no durable sidecar directory is configured', async () => {
  const previous = process.env[SESSION_SETTINGS_DIR_ENV];
  const previousLegacy = process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
  delete process.env[SESSION_SETTINGS_DIR_ENV];
  delete process.env[LEGACY_SESSION_SETTINGS_DIR_ENV];
  try {
    assert.equal(isSystemPromptTogglePersistenceAvailable(), false);
    await writeSystemPromptTogglesForSession('/sessions/one.jsonl', ['harness'], true);
  } finally {
    if (previous !== undefined) process.env[SESSION_SETTINGS_DIR_ENV] = previous;
    if (previousLegacy !== undefined) process.env[LEGACY_SESSION_SETTINGS_DIR_ENV] = previousLegacy;
  }
});
