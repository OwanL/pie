import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isBuiltin, registerHooks, syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Import the private candidate distribution directly. Do not load the installed
// SDK or run its patch barrier: this suite covers the source candidate itself.
import { sourceFixture } from './source-fixture.js';
const { piRoot, packageRoots } = sourceFixture;
const codingAgentEntry = path.join(packageRoots.codingAgent, 'dist/core/session-manager.js');
const approvedPackages: Readonly<Record<string, string>> = {
  '@earendil-works/pi-ai': packageRoots.ai,
  '@earendil-works/pi-agent-core': packageRoots.agent,
  '@earendil-works/pi-tui': packageRoots.tui,
  '@earendil-works/pi-coding-agent': packageRoots.codingAgent,
};
const isWithin = (file: string, root: string): boolean => file.startsWith(`${root}${path.sep}`);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    if (isBuiltin(specifier)) return result;

    assert.ok(result.url.startsWith('file:'), `Unexpected non-file runtime dependency: ${specifier} -> ${result.url}`);
    const resolved = fs.realpathSync(fileURLToPath(result.url));
    if (specifier.startsWith('@earendil-works/')) {
      const packageName = Object.keys(approvedPackages).find((name) => (
        specifier === name || specifier.startsWith(`${name}/`)
      ));
      const expectedRoot = packageName ? approvedPackages[packageName] : undefined;
      assert.ok(expectedRoot, `Unapproved private SDK package import: ${specifier}`);
      assert.ok(isWithin(resolved, expectedRoot), `Private SDK package graph escape for ${specifier}: ${resolved}`);
      return result;
    }

    assert.ok(isWithin(resolved, fs.realpathSync(piRoot)), `Private SDK runtime graph escape for ${specifier}: ${resolved}`);
    return result;
  },
});

let SessionManager: typeof import('@earendil-works/pi-coding-agent').SessionManager;
before(async () => {
  ({ SessionManager } = await import(pathToFileURL(codingAgentEntry).href));
});

type FsOverride = 'openSync' | 'writeFileSync' | 'fsyncSync' | 'linkSync' | 'closeSync';

function withFsOverrides<T>(overrides: Partial<Record<FsOverride, unknown>>, run: () => T): T {
  const mutableFs = fs as unknown as Record<string, unknown>;
  const originals = new Map<string, unknown>();
  for (const [name, replacement] of Object.entries(overrides)) {
    originals.set(name, mutableFs[name]);
    mutableFs[name] = replacement;
  }
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    for (const [name, original] of originals) mutableFs[name] = original;
    syncBuiltinESMExports();
  }
}

function withSessionReadCount<T>(sessionPath: string, run: () => T): { value: T; reads: number } {
  const originalOpenSync = fs.openSync;
  const expectedPath = path.resolve(sessionPath);
  let reads = 0;
  const countedOpenSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (args[1] === 'r' && path.resolve(String(args[0])) === expectedPath) reads += 1;
    return Reflect.apply(originalOpenSync, fs, args);
  }) as typeof fs.openSync;
  const value = withFsOverrides({ openSync: countedOpenSync }, run);
  return { value, reads };
}

function tempRoot(t: test.TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-source-persistence-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function sessionHeader(cwd: string, version: number | undefined, id = 'session-fixture') {
  return {
    type: 'session',
    ...(version === undefined ? {} : { version }),
    id,
    timestamp: '2026-08-25T00:00:00.000Z',
    cwd,
  };
}

function userEntry(id: string, parentId: string | null, content: string) {
  return {
    type: 'message',
    id,
    parentId,
    timestamp: '2026-08-25T00:00:01.000Z',
    message: { role: 'user', content, timestamp: 1 },
  };
}

function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

interface ParsedSessionRow {
  type?: unknown;
  version?: unknown;
  id?: unknown;
  parentId?: unknown;
  message?: { role?: unknown };
  [key: string]: unknown;
}

function readJsonl(filePath: string): ParsedSessionRow[] {
  return fs.readFileSync(filePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as ParsedSessionRow);
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

test('open reads a durable session once and preserves the stored cwd and requested session directory', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const storedCwd = path.join(root, 'stored-cwd');
  const sessionDir = path.join(root, 'future-sessions');
  const sessionPath = path.join(root, 'existing.jsonl');
  fs.mkdirSync(storedCwd);
  fs.mkdirSync(sessionDir);
  const header = sessionHeader(storedCwd, 3, 'single-read-session');
  const user = userEntry('user-1', null, 'hello');
  const assistant = {
    type: 'message', id: 'assistant-1', parentId: 'user-1',
    timestamp: '2026-08-25T00:00:02.000Z',
    message: {
      role: 'assistant', content: [{ type: 'text', text: 'hi' }],
      api: 'test', provider: 'test', model: 'model-a',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {} },
      stopReason: 'stop', timestamp: 2,
    },
  };
  writeJsonl(sessionPath, [header, user, assistant]);

  const opened = withSessionReadCount(sessionPath, () => SessionManager.open(sessionPath, sessionDir));
  assert.equal(opened.reads, 1);
  assert.equal(opened.value.getSessionFile(), path.resolve(sessionPath));
  assert.equal(opened.value.getSessionDir(), path.resolve(sessionDir));
  assert.equal(opened.value.getCwd(), path.resolve(storedCwd));
  // The legacy parity snapshot is explicit here: no installed SDK baseline
  // or patch-derived fixture is needed to define the expected public state.
  assert.deepEqual(JSON.parse(JSON.stringify({
    sessionFile: opened.value.getSessionFile(),
    sessionDir: opened.value.getSessionDir(),
    sessionId: opened.value.getSessionId(),
    cwd: opened.value.getCwd(),
    header: opened.value.getHeader(),
    entries: opened.value.getEntries(),
    branch: opened.value.getBranch(),
    tree: opened.value.getTree(),
    context: opened.value.buildSessionContext(),
  })), {
    sessionFile: path.resolve(sessionPath),
    sessionDir: path.resolve(sessionDir),
    sessionId: header.id,
    cwd: path.resolve(storedCwd),
    header,
    entries: [user, assistant],
    branch: [user, assistant],
    tree: [{ entry: user, children: [{ entry: assistant, children: [] }] }],
    context: {
      messages: [user.message, assistant.message],
      thinkingLevel: 'off',
      model: { provider: 'test', modelId: 'model-a' },
    },
  });
});

test('open leaves missing paths absent, initializes an empty file once, and preserves invalid bytes', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const missingPath = path.join(root, 'missing.jsonl');
  const missing = SessionManager.open(missingPath);
  assert.equal(missing.getSessionFile(), path.resolve(missingPath));
  const missingHeader = missing.getHeader();
  assert.ok(missingHeader);
  assert.equal(missingHeader.version, 3);
  assert.equal(fs.existsSync(missingPath), false);

  const emptyPath = path.join(root, 'empty.jsonl');
  const overrideCwd = path.join(root, 'override-cwd');
  fs.mkdirSync(overrideCwd);
  fs.writeFileSync(emptyPath, '', 'utf8');
  const empty = withSessionReadCount(emptyPath, () => SessionManager.open(emptyPath, undefined, overrideCwd));
  assert.equal(empty.reads, 1);
  assert.equal(empty.value.getSessionFile(), path.resolve(emptyPath));
  assert.equal(empty.value.getCwd(), path.resolve(overrideCwd));
  assert.equal(fs.readFileSync(emptyPath, 'utf8').trim().length > 0, true);
  const emptyHeader = empty.value.getHeader();
  assert.ok(emptyHeader);
  assert.equal(emptyHeader.version, 3);
  assert.equal(readJsonl(emptyPath).length, 1);

  const invalidPath = path.join(root, 'invalid.jsonl');
  const invalidBytes = 'not-json-but-not-empty\n';
  fs.writeFileSync(invalidPath, invalidBytes, 'utf8');
  const invalid = withSessionReadCount(invalidPath, () => {
    assert.throws(() => SessionManager.open(invalidPath), /Session file is not a valid pi session/);
  });
  assert.equal(invalid.reads, 1);
  assert.equal(fs.readFileSync(invalidPath, 'utf8'), invalidBytes);
});

test('v1 and v2 opens migrate once and honor a cwd override', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const storedCwd = path.join(root, 'stored-cwd');
  const overrideCwd = path.join(root, 'override-cwd');
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(storedCwd);
  fs.mkdirSync(overrideCwd);
  fs.mkdirSync(sessionDir);

  const v1Path = path.join(root, 'v1.jsonl');
  writeJsonl(v1Path, [
    sessionHeader(storedCwd, undefined, 'legacy-v1'),
    { type: 'message', timestamp: '2026-08-25T00:00:01.000Z', message: { role: 'user', content: 'legacy', timestamp: 1 } },
    { type: 'message', timestamp: '2026-08-25T00:00:02.000Z', message: { role: 'hookMessage', content: 'hook', timestamp: 2 } },
  ]);
  const v1 = withSessionReadCount(v1Path, () => SessionManager.open(v1Path, sessionDir, overrideCwd));
  assert.equal(v1.reads, 1);
  assert.equal(v1.value.getCwd(), path.resolve(overrideCwd));
  assert.equal(v1.value.getSessionDir(), path.resolve(sessionDir));
  const v1Header = v1.value.getHeader();
  assert.ok(v1Header);
  assert.equal(v1Header.version, 3);
  const v1Rows = readJsonl(v1Path);
  assert.equal(v1Rows[0].version, 3);
  assert.ok(v1Rows.slice(1).every((row) => typeof row.id === 'string'));
  assert.equal(v1Rows[1].parentId, null);
  assert.equal(v1Rows[2].parentId, v1Rows[1].id);
  assert.equal(v1Rows[2].message?.role, 'custom');

  const v2Path = path.join(root, 'v2.jsonl');
  writeJsonl(v2Path, [
    sessionHeader(storedCwd, 2, 'legacy-v2'),
    userEntry('user-v2', null, 'legacy v2'),
    {
      type: 'message', id: 'hook-v2', parentId: 'user-v2',
      timestamp: '2026-08-25T00:00:02.000Z',
      message: { role: 'hookMessage', content: 'hook', timestamp: 2 },
    },
  ]);
  const v2 = withSessionReadCount(v2Path, () => SessionManager.open(v2Path, sessionDir, overrideCwd));
  assert.equal(v2.reads, 1);
  assert.equal(v2.value.getCwd(), path.resolve(overrideCwd));
  const v2Header = v2.value.getHeader();
  assert.ok(v2Header);
  assert.equal(v2Header.version, 3);
  const v2Rows = readJsonl(v2Path);
  assert.equal(v2Rows[0].version, 3);
  assert.equal(v2Rows[2].message?.role, 'custom');
});

test('create eagerly publishes exactly its v3 header and subsequent appends do not duplicate it', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);

  const originalOpenSync = fs.openSync;
  let exclusiveOpens = 0;
  const countedOpenSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (args[1] === 'wx') exclusiveOpens += 1;
    return Reflect.apply(originalOpenSync, fs, args);
  }) as typeof fs.openSync;
  const manager = withFsOverrides(
    { openSync: countedOpenSync },
    () => SessionManager.create(root, sessionDir, { id: 'eager-create' }),
  );
  const sessionPath = manager.getSessionFile();
  assert.ok(sessionPath);
  assert.equal(exclusiveOpens, 1, 'creation stages its header through an exclusive file create');
  assert.equal(fs.existsSync(sessionPath), true, 'the header is durable before create returns');
  assert.deepEqual(readJsonl(sessionPath), [JSON.parse(JSON.stringify(manager.getHeader()))]);
  const header = manager.getHeader();
  assert.ok(header);
  assert.equal(header.version, 3);

  manager.appendMessage({ role: 'user', content: 'hello', timestamp: 1 });
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
    api: 'anthropic-messages',
    provider: 'anthropic',
    model: 'fixture-model',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
  });
  const rows = readJsonl(sessionPath);
  assert.equal(rows.filter((row) => row.type === 'session').length, 1);
  assert.deepEqual(rows[0], JSON.parse(JSON.stringify(manager.getHeader())));
  assert.deepEqual(rows.slice(1).map((row) => row.message?.role), ['user', 'assistant']);
});

test('direct create writes parent ownership into the one canonical durable initial header', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const sessionDir = path.join(root, 'parent-sessions');
  fs.mkdirSync(sessionDir);
  const manager = SessionManager.create(root, sessionDir, { parentSession: 'canonical-parent.jsonl' });
  const sessionPath = manager.getSessionFile();
  assert.ok(sessionPath);
  const rows = readJsonl(sessionPath);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].parentSession, 'canonical-parent.jsonl');
  assert.deepEqual(rows[0], JSON.parse(JSON.stringify(manager.getHeader())));
  assert.equal(fs.readdirSync(sessionDir).length, 1);
});

test('an EEXIST publication collision preserves the pre-existing destination and removes the staged file', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(sessionDir);
  const originalLinkSync = fs.linkSync;
  const existingBytes = '{"type":"session","version":3,"id":"existing"}\n';
  let collisionPath: string | undefined;
  const linkWithCollision = ((...args: Parameters<typeof fs.linkSync>) => {
    collisionPath = String(args[1]);
    fs.writeFileSync(collisionPath, existingBytes, { flag: 'wx' });
    return Reflect.apply(originalLinkSync, fs, args);
  }) as typeof fs.linkSync;

  assert.throws(
    () => withFsOverrides({ linkSync: linkWithCollision }, () => SessionManager.create(root, sessionDir, { id: 'collision' })),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
  );
  assert.ok(collisionPath);
  assert.equal(fs.readFileSync(collisionPath, 'utf8'), existingBytes);
  assert.deepEqual(fs.readdirSync(sessionDir), [path.basename(collisionPath)]);
});

test('exclusive temporary-path collisions preserve files not created by this call', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const originalOpenSync = fs.openSync;
  let temporaryPath: string | undefined;
  const bytes = 'pre-existing temporary file';
  const collidingOpen = ((...args: Parameters<typeof fs.openSync>) => {
    if (args[1] === 'wx') {
      temporaryPath = String(args[0]);
      const fd = originalOpenSync(temporaryPath, 'wx');
      try { fs.writeFileSync(fd, bytes); } finally { fs.closeSync(fd); }
    }
    return Reflect.apply(originalOpenSync, fs, args);
  }) as typeof fs.openSync;
  assert.throws(() => withFsOverrides({ openSync: collidingOpen }, () => SessionManager.create(root, root)),
    (error: NodeJS.ErrnoException) => error.code === 'EEXIST');
  assert.ok(temporaryPath);
  assert.equal(fs.readFileSync(temporaryPath, 'utf8'), bytes);
  assert.deepEqual(fs.readdirSync(root), [path.basename(temporaryPath)]);
});

test('staged-file cleanup still runs when descriptor close throws repeatedly', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const originalClose = fs.closeSync;
  const closed = new Set<number>();
  const failingClose = ((fd: number) => {
    if (!closed.has(fd)) { originalClose(fd); closed.add(fd); }
    throw errno('EIO', 'staged descriptor close failure');
  }) as typeof fs.closeSync;
  assert.throws(() => withFsOverrides({ closeSync: failingClose }, () => SessionManager.create(root, root)),
    /staged descriptor close failure/);
  assert.deepEqual(fs.readdirSync(root), []);
});

for (const platform of ['linux', 'win32']) {
  for (const stage of ['open', 'fsync', 'close']) {
    test(`directory ${stage} failure after publication preserves ${platform} semantics`, { concurrency: false }, (t) => {
      const root = tempRoot(t);
      const originalOpen = fs.openSync;
      const originalFsync = fs.fsyncSync;
      const originalClose = fs.closeSync;
      let directoryFd: number | undefined;
      let publishedPath: string | undefined;
      const originalLink = fs.linkSync;
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
      try {
        withFsOverrides({
          linkSync: ((source: fs.PathLike, destination: fs.PathLike) => {
            originalLink(source, destination);
            publishedPath = String(destination);
          }) as typeof fs.linkSync,
          openSync: ((...args: Parameters<typeof fs.openSync>) => {
            if (args[1] === 'r' && String(args[0]) === root) {
              if (stage === 'open') throw errno('EIO', 'directory failure');
              // Use a real file descriptor so the simulated platform branches
              // are deterministic even when Windows forbids directory opens.
              directoryFd = originalOpen(publishedPath!, 'r');
              return directoryFd;
            }
            return Reflect.apply(originalOpen, fs, args);
          }) as typeof fs.openSync,
          fsyncSync: ((fd: number) => {
            if (stage === 'fsync' && fd === directoryFd) throw errno('EIO', 'directory failure');
            originalFsync(fd);
          }) as typeof fs.fsyncSync,
          closeSync: ((fd: number) => {
            originalClose(fd);
            if (stage === 'close' && fd === directoryFd) throw errno('EIO', 'directory failure');
          }) as typeof fs.closeSync,
        }, () => {
          if (platform === 'win32' && stage !== 'close') {
            const manager = SessionManager.create(root, root);
            assert.equal(manager.getSessionFile(), publishedPath);
            assert.equal(readJsonl(publishedPath!)[0].version, 3);
          } else {
            assert.throws(() => SessionManager.create(root, root), /directory failure/);
          }
        });
      } finally {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
      assert.ok(publishedPath, 'fault occurs after exclusive publication');
      assert.deepEqual(fs.readdirSync(root), platform === 'win32' && stage !== 'close' ? [path.basename(publishedPath)] : []);
    });
  }
}

test('write, file-fsync, and link failures leave neither a destination nor a staged file', { concurrency: false }, (t) => {
  const root = tempRoot(t);
  const failures: Array<{ name: string; mock: () => Partial<Record<FsOverride, unknown>> }> = [
    {
      name: 'write',
      mock: () => {
        const originalOpenSync = fs.openSync;
        const originalWriteFileSync = fs.writeFileSync;
        const temporaryDescriptors = new Set<number>();
        return {
          openSync: ((...args: Parameters<typeof fs.openSync>) => {
            const fd = Reflect.apply(originalOpenSync, fs, args) as number;
            if (args[1] === 'wx') temporaryDescriptors.add(fd);
            return fd;
          }) as typeof fs.openSync,
          writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
            if (typeof args[0] === 'number' && temporaryDescriptors.has(args[0])) {
              throw errno('EIO', 'injected session-header write failure');
            }
            return Reflect.apply(originalWriteFileSync, fs, args);
          }) as typeof fs.writeFileSync,
        };
      },
    },
    {
      name: 'fsync',
      mock: () => {
        const originalOpenSync = fs.openSync;
        const originalFsyncSync = fs.fsyncSync;
        const temporaryDescriptors = new Set<number>();
        return {
          openSync: ((...args: Parameters<typeof fs.openSync>) => {
            const fd = Reflect.apply(originalOpenSync, fs, args) as number;
            if (args[1] === 'wx') temporaryDescriptors.add(fd);
            return fd;
          }) as typeof fs.openSync,
          fsyncSync: ((fd: number) => {
            if (temporaryDescriptors.has(fd)) throw errno('EIO', 'injected session-header fsync failure');
            return Reflect.apply(originalFsyncSync, fs, [fd]);
          }) as typeof fs.fsyncSync,
        };
      },
    },
    {
      name: 'link',
      mock: () => {
        const linkSync = (() => { throw errno('EIO', 'injected session-header link failure'); }) as typeof fs.linkSync;
        return { linkSync };
      },
    },
  ];

  for (const failure of failures) {
    const sessionDir = path.join(root, failure.name);
    fs.mkdirSync(sessionDir);
    assert.throws(
      () => withFsOverrides(failure.mock(), () => SessionManager.create(root, sessionDir, { id: `failed-${failure.name}` })),
      new RegExp(`injected session-header ${failure.name} failure`),
    );
    assert.deepEqual(fs.readdirSync(sessionDir), [], `${failure.name} failure cleans temporary and destination files`);
  }
});
