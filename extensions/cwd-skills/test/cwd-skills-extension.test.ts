/**
 * Bug-hunting tests for cwd-skills extension.
 *
 * Regression-focused tests for cwd-skills.
 *
 * Historically this extension had two easy-to-miss path bugs:
 *
 *  - undefined/null cwd threw instead of returning {}
 *  - empty-string cwd resolved a relative `skills/` directory against process.cwd()
 *
 * The assertions below lock in the fixed behavior and guard future refactors.
 */

import test, { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, symlinkSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionModuleUrl = pathToFileURL(
  path.resolve(__dirname, '../index.ts'),
).href;

type ResourceDiscoverEvent = { cwd: string; reason: 'startup' | 'reload' };
type ResourceDiscoverHandler = (
  event: ResourceDiscoverEvent,
  ctx: unknown,
) => Promise<unknown> | unknown;

function createApiRecorder() {
  const handlers = new Map<string, ResourceDiscoverHandler[]>();

  return {
    api: {
      on(eventName: string, handler: ResourceDiscoverHandler) {
        const existing = handlers.get(eventName) ?? [];
        existing.push(handler);
        handlers.set(eventName, existing);
      },
    },
    getHandlers(eventName: string): ResourceDiscoverHandler[] {
      return handlers.get(eventName) ?? [];
    },
    getSingleHandler(eventName: string): ResourceDiscoverHandler {
      const existing = handlers.get(eventName) ?? [];
      assert.equal(
        existing.length,
        1,
        `Expected exactly one handler for ${eventName}, got ${existing.length}`,
      );
      return existing[0];
    },
  };
}

let cachedFactory: ((api: unknown) => void) | undefined;
async function loadFactory(): Promise<(api: unknown) => void> {
  if (!cachedFactory) {
    const module = (await import(extensionModuleUrl)) as {
      default: (api: unknown) => void;
    };
    cachedFactory = module.default;
  }
  return cachedFactory;
}

/** Create a fresh api recorder + registered handler ready for a single test. */
async function makeHandler(): Promise<ResourceDiscoverHandler> {
  const { api, getSingleHandler } = createApiRecorder();
  const factory = await loadFactory();
  factory(api);
  return getSingleHandler('resources_discover');
}

/** Create a temp dir and register cleanup via afterEach-style callback. */
async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pi-cwd-skills-'));
}

// ---------------------------------------------------------------------------
// Original happy-path tests (kept, slightly enhanced)
// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('returns skillPaths when skills/ directory exists', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    await fs.mkdir(path.join(cwd, 'skills'), { recursive: true });

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'startup' }, {});

    assert.deepEqual(result, { skillPaths: [path.join(cwd, 'skills')] });
  });

  it('returns {} when skills/ directory is absent', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'reload' }, {});

    assert.deepEqual(result, {});
  });

  it('result is always a plain object — never null or undefined', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'startup' }, {});

    assert.notEqual(result, null);
    assert.notEqual(result, undefined);
    assert.equal(typeof result, 'object');
  });
});

// ---------------------------------------------------------------------------
// BUG-1 — undefined / null cwd
// ---------------------------------------------------------------------------

describe('regression: undefined/null cwd', () => {
  it('returns {} (does NOT throw) when cwd is undefined', async () => {
    const handler = await makeHandler();
    const result = await handler({ cwd: undefined as unknown as string, reason: 'startup' }, {});
    assert.deepEqual(result, {});
  });

  it('returns {} (does NOT throw) when cwd is null', async () => {
    const handler = await makeHandler();
    const result = await handler({ cwd: null as unknown as string, reason: 'startup' }, {});
    assert.deepEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// BUG-2 — empty-string cwd resolves to a relative path
// ---------------------------------------------------------------------------

describe('regression: empty-string cwd resolves relative to process.cwd()', () => {
  it('returns {} for empty-string cwd', async () => {
    const handler = await makeHandler();
    const result = await handler({ cwd: '', reason: 'startup' }, {});

    assert.deepEqual(
      result,
      {},
      `Empty cwd should return {} but returned ${JSON.stringify(result)} ` +
        `(resolved against process.cwd()=${process.cwd()})`,
    );
  });

  it('skillPaths entries are always absolute paths', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await fs.mkdir(path.join(cwd, 'skills'));

    const handler = await makeHandler();
    const result = (await handler({ cwd, reason: 'startup' }, {})) as {
      skillPaths: string[];
    };

    assert.ok(result.skillPaths, 'should have skillPaths');
    for (const p of result.skillPaths) {
      assert.ok(
        path.isAbsolute(p),
        `skillPath must be absolute, got: ${p}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// skills exists but is NOT a directory
// ---------------------------------------------------------------------------

describe('skills exists but is not a directory', () => {
  it('returns {} when skills/ is a plain file', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    // Create a FILE named 'skills', not a directory
    await fs.writeFile(path.join(cwd, 'skills'), 'not a directory');

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'startup' }, {});

    assert.deepEqual(
      result,
      {},
      'A file named "skills" should not be treated as a skills directory',
    );
  });
});

// ---------------------------------------------------------------------------
// Symlink edge cases
// ---------------------------------------------------------------------------

describe('symlink edge cases', () => {
  /** On Windows without Developer Mode / admin, fs.symlinkSync throws EPERM.
   *  These edge-case tests need real symlinks; skip them gracefully when the
   *  host can't create one, rather than reporting a false failure. */
  function assumeSymlinksSupported(t: { skip: (reason: string) => void }): boolean {
    const probe = path.join(os.tmpdir(), `pie-symlink-probe-${process.pid}-${Date.now()}`);
    try {
      symlinkSync(probe, `${probe}.link`);
      rmSync(`${probe}.link`, { force: true });
      return true;
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'EACCES') {
        t.skip(`symlinks not supported on this host (${code})`);
        return false;
      }
      throw error;
    }
  }

  it('accepts a symlink that points to a real directory', async (t) => {
    if (!assumeSymlinksSupported(t)) return;
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    const realDir = path.join(cwd, 'real-skills-dir');
    mkdirSync(realDir);
    symlinkSync(realDir, path.join(cwd, 'skills'));

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'startup' }, {});

    assert.deepEqual(result, {
      skillPaths: [path.join(cwd, 'skills')],
    });
  });

  it('returns {} when skills is a symlink pointing to a plain file', async (t) => {
    if (!assumeSymlinksSupported(t)) return;
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    const realFile = path.join(cwd, 'not-a-dir.txt');
    writeFileSync(realFile, 'data');
    symlinkSync(realFile, path.join(cwd, 'skills'));

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'startup' }, {});

    assert.deepEqual(
      result,
      {},
      'Symlink-to-file must not be returned as a skills path',
    );
  });

  it('returns {} for a broken symlink — existsSync follows the link target', async (t) => {
    if (!assumeSymlinksSupported(t)) return;
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    // Create a symlink whose target does not exist
    symlinkSync(
      path.join(cwd, 'nonexistent-target'),
      path.join(cwd, 'skills'),
    );

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'startup' }, {});

    assert.deepEqual(
      result,
      {},
      'Broken symlink: existsSync returns false, handler must return {}',
    );
  });
});

// ---------------------------------------------------------------------------
// cwd itself doesn't exist
// ---------------------------------------------------------------------------

describe('nonexistent cwd', () => {
  it('returns {} when cwd directory does not exist', async () => {
    const cwd = path.join(os.tmpdir(), `pi-cwd-skills-nonexistent-${Date.now()}`);
    // Confirm it really does not exist
    assert.equal(existsSync(cwd), false, 'Precondition: temp cwd must not exist');

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'startup' }, {});

    assert.deepEqual(result, {});
  });

  it('returns {} when cwd exists but contains no skills subdir', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    // Ensure no 'skills' entry at all
    const skillsPath = path.join(cwd, 'skills');
    assert.equal(existsSync(skillsPath), false);

    const handler = await makeHandler();
    const result = await handler({ cwd, reason: 'startup' }, {});

    assert.deepEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// Path normalisation
// ---------------------------------------------------------------------------

describe('path normalisation', () => {
  it('handles cwd with a trailing path separator', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await fs.mkdir(path.join(cwd, 'skills'));

    const handler = await makeHandler();
    // Append OS separator so join must normalise it
    const cwdWithSep = cwd + path.sep;
    const result = await handler({ cwd: cwdWithSep, reason: 'startup' }, {});

    assert.deepEqual(result, { skillPaths: [path.join(cwd, 'skills')] });
  });

  it('normalises path-traversal sequences in cwd', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await fs.mkdir(path.join(cwd, 'skills'));

    // Build a traversal that still resolves to cwd
    const parent = path.dirname(cwd);
    const base = path.basename(cwd);
    const traversalCwd = path.join(parent, 'dummy', '..', base);

    const handler = await makeHandler();
    const result = await handler({ cwd: traversalCwd, reason: 'startup' }, {});

    assert.deepEqual(result, { skillPaths: [path.join(cwd, 'skills')] });
  });
});

// ---------------------------------------------------------------------------
// reason field is ignored
// ---------------------------------------------------------------------------

describe('reason field', () => {
  it('returns same result for reason=startup and reason=reload', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await fs.mkdir(path.join(cwd, 'skills'));

    const handler = await makeHandler();
    const startup = await handler({ cwd, reason: 'startup' }, {});
    const reload = await handler({ cwd, reason: 'reload' }, {});

    assert.deepEqual(startup, reload);
  });

  it('returns {} for both reasons when skills/ is absent', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    const handler = await makeHandler();
    assert.deepEqual(
      await handler({ cwd, reason: 'startup' }, {}),
      {},
    );
    assert.deepEqual(
      await handler({ cwd, reason: 'reload' }, {}),
      {},
    );
  });
});

// ---------------------------------------------------------------------------
// Registration contract
// ---------------------------------------------------------------------------

describe('registration contract', () => {
  it('registers exactly one resources_discover handler per factory call', async () => {
    const { api, getHandlers } = createApiRecorder();
    const factory = await loadFactory();
    factory(api);

    const handlers = getHandlers('resources_discover');
    assert.equal(
      handlers.length,
      1,
      `Expected 1 handler, registered ${handlers.length}`,
    );
  });

  it('does not register handlers for unrelated event names', async () => {
    const { api, getHandlers } = createApiRecorder();
    const factory = await loadFactory();
    factory(api);

    const unrelated = ['tool_call', 'message', 'error', 'startup', 'shutdown'];
    for (const name of unrelated) {
      assert.equal(
        getHandlers(name).length,
        0,
        `Unexpected handler registered for event: ${name}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Concurrent / repeated calls — no shared mutable state
// ---------------------------------------------------------------------------

describe('no shared mutable state across calls', () => {
  it('concurrent handler invocations return independent correct results', async (t) => {
    const cwdA = await makeTempDir();
    const cwdB = await makeTempDir();
    const cwdC = await makeTempDir();
    t.after(async () => {
      await Promise.all([
        fs.rm(cwdA, { recursive: true, force: true }),
        fs.rm(cwdB, { recursive: true, force: true }),
        fs.rm(cwdC, { recursive: true, force: true }),
      ]);
    });

    // A has skills, B does not, C has skills
    await fs.mkdir(path.join(cwdA, 'skills'));
    await fs.mkdir(path.join(cwdC, 'skills'));

    const handler = await makeHandler();

    const [rA, rB, rC] = await Promise.all([
      handler({ cwd: cwdA, reason: 'startup' }, {}),
      handler({ cwd: cwdB, reason: 'startup' }, {}),
      handler({ cwd: cwdC, reason: 'startup' }, {}),
    ]);

    assert.deepEqual(rA, { skillPaths: [path.join(cwdA, 'skills')] });
    assert.deepEqual(rB, {});
    assert.deepEqual(rC, { skillPaths: [path.join(cwdC, 'skills')] });
  });

  it('calling the handler multiple times for the same cwd returns consistent results', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));
    await fs.mkdir(path.join(cwd, 'skills'));

    const handler = await makeHandler();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        handler({ cwd, reason: 'startup' }, {}),
      ),
    );

    const expected = { skillPaths: [path.join(cwd, 'skills')] };
    for (const result of results) {
      assert.deepEqual(result, expected);
    }
  });
});

// ---------------------------------------------------------------------------
// skills/ directory is later removed (state-at-call-time, not cached)
// ---------------------------------------------------------------------------

describe('no caching between calls', () => {
  it('reflects filesystem state at call time — removal is visible on next call', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    const skillsPath = path.join(cwd, 'skills');
    await fs.mkdir(skillsPath);

    const handler = await makeHandler();

    // First call: skills dir exists
    const before = await handler({ cwd, reason: 'startup' }, {});
    assert.deepEqual(before, { skillPaths: [skillsPath] });

    // Remove it
    await fs.rm(skillsPath, { recursive: true, force: true });

    // Second call: skills dir gone
    const after = await handler({ cwd, reason: 'reload' }, {});
    assert.deepEqual(
      after,
      {},
      'Handler must re-check the filesystem — must not cache the previous result',
    );
  });

  it('reflects filesystem state at call time — creation is visible on next call', async (t) => {
    const cwd = await makeTempDir();
    t.after(() => fs.rm(cwd, { recursive: true, force: true }));

    const handler = await makeHandler();

    // First call: no skills dir
    const before = await handler({ cwd, reason: 'startup' }, {});
    assert.deepEqual(before, {});

    // Create skills dir
    await fs.mkdir(path.join(cwd, 'skills'));

    // Second call: skills dir now present
    const after = await handler({ cwd, reason: 'reload' }, {});
    assert.deepEqual(
      after,
      { skillPaths: [path.join(cwd, 'skills')] },
      'Handler must detect newly created skills directory',
    );
  });
});
