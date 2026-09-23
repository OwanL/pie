import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { delimiter } from 'node:path';
import { prependManagedBinDir, sanitizeProtoEnv } from '../src/managed-env.js';

/** The PATH key this platform uses inside process.env (Path on Windows,
 *  PATH on POSIX). pi's managed-bin prepend targets this key. */
function platformPathKey(): string {
  return Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
}

describe('prependManagedBinDir', () => {
  test('prepends binDir ahead of the existing PATH', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = { [key]: ['/usr/bin', '/bin'].join(delimiter) };
    const out = prependManagedBinDir(env, '/managed/bin');
    const entries = (out[key] ?? '').split(delimiter);
    assert.equal(entries[0], '/managed/bin', 'binDir must be first');
    assert.ok(entries.includes('/usr/bin'), 'original entries preserved');
    assert.equal(entries.length, 3);
  });

  test('is idempotent: binDir already present leaves PATH unchanged', () => {
    const key = platformPathKey();
    const original = ['/managed/bin', '/usr/bin'].join(delimiter);
    const env: NodeJS.ProcessEnv = { [key]: original };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out[key], original);
  });

  test('is idempotent when binDir appears mid-PATH (not just first)', () => {
    const key = platformPathKey();
    const original = ['/usr/bin', '/managed/bin', '/bin'].join(delimiter);
    const env: NodeJS.ProcessEnv = { [key]: original };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out[key], original, 'must not prepend a duplicate');
  });

  test('preserves unrelated env vars', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = { [key]: '/usr/bin', HOME: '/home/x', FOO: 'bar' };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out.HOME, '/home/x');
    assert.equal(out.FOO, 'bar');
    assert.ok((out[key] ?? '').startsWith('/managed/bin'));
  });

  test('does not mutate the input env', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = { [key]: '/usr/bin' };
    const before = env[key];
    prependManagedBinDir(env, '/managed/bin');
    assert.equal(env[key], before, 'input env must be untouched');
  });

  test('prepends to the Windows-style "Path" key when that is what the env carries', () => {
    // Simulate a Windows env where the key is "Path" (capital P, lowercase ath)
    // rather than "PATH". The prepend must target "Path" — NOT invent a "PATH"
    // — so the spawned shell sees one PATH with the managed dir first.
    const env: NodeJS.ProcessEnv = { Path: 'C:\\Windows;C:\\System32' };
    const out = prependManagedBinDir(env, 'C:\\pi\\agent\\bin');
    assert.equal(out.Path, 'C:\\pi\\agent\\bin;C:\\Windows;C:\\System32');
    assert.equal(out.PATH, undefined, 'must not fabricate a separate PATH key');
  });

  test('defaults to the PATH key when the env has no path-like key', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/home/x' };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out.PATH, '/managed/bin');
    assert.equal(out.HOME, '/home/x');
  });

  test('handles an empty/missing PATH by setting it to just binDir', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = { [key]: '' };
    const out = prependManagedBinDir(env, '/managed/bin');
    assert.equal(out[key], '/managed/bin');
  });
});

/** Split a PATH value into its non-empty entries. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return (env[key] ?? '').split(delimiter).filter(Boolean);
}

describe('sanitizeProtoEnv — var stripping', () => {
  test('strips per-tool PROTO_<TOOL>_VERSION and PROTO_<TOOL>_SHIM pins', () => {
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: '/p',
      PROTO_NODE_VERSION: '22.22.3',
      PROTO_NPM_VERSION: '10.9.0',
      PROTO_PYTHON_VERSION: '3.12.4',
      PROTO_NODE_SHIM: '/p/shims/node.exe',
      PROTO_NPM_SHIM: '/p/shims/npm.exe',
      HOME: '/home/x',
    };
    const out = sanitizeProtoEnv(env);
    assert.equal(out.PROTO_NODE_VERSION, undefined);
    assert.equal(out.PROTO_NPM_VERSION, undefined);
    assert.equal(out.PROTO_PYTHON_VERSION, undefined);
    assert.equal(out.PROTO_NODE_SHIM, undefined);
    assert.equal(out.PROTO_NPM_SHIM, undefined);
    assert.equal(out.HOME, '/home/x', 'unrelated vars preserved');
  });

  test('strips the running shim identity PROTO_SHIM_NAME / PROTO_SHIM_PATH', () => {
    // These are the activation-context vars the proto shim sets when it launches
    // a process (present on real proto machines: PROTO_SHIM_NAME=node,
    // PROTO_SHIM_PATH=…/node.exe). A frozen warm pool must not carry a stale
    // "I am node" identity — each shim the pool invokes sets its own.
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: '/p',
      PROTO_SHIM_NAME: 'node',
      PROTO_SHIM_PATH: '/p/shims/node.exe',
    };
    const out = sanitizeProtoEnv(env);
    assert.equal(out.PROTO_SHIM_NAME, undefined);
    assert.equal(out.PROTO_SHIM_PATH, undefined);
  });

  test('preserves PROTO_HOME and unrelated proto config vars', () => {
    // PROTO_HOME is REQUIRED by the shims (they locate config under it) so it
    // must survive. PROTO_VERSION is proto's own version (not a tool pin) and
    // does not match PROTO_<TOOL>_VERSION, so it is kept alongside other config.
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: '/p',
      PROTO_VERSION: '0.57.4',
      PROTO_APP_LOG: 'proto=info',
      PROTO_OFFLINE_TIMEOUT: '750',
      PROTO_NODE_VERSION: '22.22.3',
    };
    const out = sanitizeProtoEnv(env);
    assert.equal(out.PROTO_HOME, '/p');
    assert.equal(out.PROTO_VERSION, '0.57.4');
    assert.equal(out.PROTO_APP_LOG, 'proto=info');
    assert.equal(out.PROTO_OFFLINE_TIMEOUT, '750');
    assert.equal(out.PROTO_NODE_VERSION, undefined, 'tool pin still stripped');
  });

  test('strips PROTO_*_VERSION/SHIM even when PROTO_HOME is absent', () => {
    // Var stripping is independent of PROTO_HOME: a stale PROTO_NODE_VERSION
    // pins a tool regardless. With no PROTO_HOME there are no tools/ entries to
    // strip and no shim paths to promote, so PATH is left untouched.
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      [key]: ['/usr/bin', '/bin'].join(delimiter),
      PROTO_NODE_VERSION: '22.22.3',
      PROTO_NPM_SHIM: '/nowhere/npm',
    };
    const out = sanitizeProtoEnv(env);
    assert.equal(out.PROTO_NODE_VERSION, undefined);
    assert.equal(out.PROTO_NPM_SHIM, undefined);
    assert.deepEqual(pathEntries(out), ['/usr/bin', '/bin'], 'PATH untouched with no PROTO_HOME');
  });
});

describe('sanitizeProtoEnv — PATH sanitization', () => {
  const PROTO = '/p';
  const TOOLS_NODE = '/p/tools/node/22.22.3';
  const TOOLS_GLOBALS = '/p/tools/node/22.22.3/globals/bin';
  const SHIMS = '/p/shims';
  const BIN = '/p/bin';
  const NVM = '/nvm4w/nodejs';
  const MANAGED = '/agent/bin';

  test('strips direct PROTO_HOME/tools PATH entries (install bin + globals/bin)', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      [key]: [TOOLS_NODE, TOOLS_GLOBALS, SHIMS, BIN, NVM].join(delimiter),
    };
    const out = sanitizeProtoEnv(env, MANAGED);
    const entries = pathEntries(out);
    assert.ok(!entries.includes(TOOLS_NODE), 'version-pinned install bin must be stripped');
    assert.ok(!entries.includes(TOOLS_GLOBALS), 'globals/bin under tools/ must be stripped');
  });

  test('promotes shims + bin right after the managed bin dir', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      [key]: [MANAGED, TOOLS_NODE, NVM].join(delimiter),
    };
    const out = sanitizeProtoEnv(env, MANAGED);
    const entries = pathEntries(out);
    // Managed bin stays first (rg/fd win), then shims, then bin, then the rest.
    assert.equal(entries[0], MANAGED, 'managed bin must stay first');
    assert.equal(entries[1], SHIMS, 'shims promoted to position 1');
    assert.equal(entries[2], BIN, 'bin promoted to position 2 (after shims)');
    assert.equal(entries[3], NVM, 'non-proto entry preserved after');
    assert.ok(!entries.includes(TOOLS_NODE), 'tools/ entry stripped');
  });

  test('places shims before bin so the version-resolving shim wins over the pinned bin binary', () => {
    // bin/<tool> is the real pinned binary; shims/<tool> is the version-resolving
    // shim. The shim must precede bin so tools resolve per .prototools.
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      [key]: [MANAGED].join(delimiter),
    };
    const out = sanitizeProtoEnv(env, MANAGED);
    const entries = pathEntries(out);
    assert.ok(entries.indexOf(SHIMS) < entries.indexOf(BIN), 'shims must precede bin');
  });

  test('promotes to the front when managedBinDir is absent or not on PATH', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      [key]: [TOOLS_NODE, NVM].join(delimiter),
    };
    // No managedBinDir → shims/bin go to the front.
    let out = sanitizeProtoEnv(env);
    let entries = pathEntries(out);
    assert.equal(entries[0], SHIMS);
    assert.equal(entries[1], BIN);
    // managedBinDir provided but not present on PATH → also front.
    out = sanitizeProtoEnv(env, '/not/on/path');
    entries = pathEntries(out);
    assert.equal(entries[0], SHIMS);
    assert.equal(entries[1], BIN);
  });

  test('moves buried shims/bin up rather than duplicating them', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      [key]: [MANAGED, NVM, SHIMS, BIN].join(delimiter),
    };
    const out = sanitizeProtoEnv(env, MANAGED);
    const entries = pathEntries(out);
    assert.equal(entries.filter((e) => e === SHIMS).length, 1, 'shims not duplicated');
    assert.equal(entries.filter((e) => e === BIN).length, 1, 'bin not duplicated');
    assert.equal(entries[0], MANAGED);
    assert.equal(entries[1], SHIMS);
    assert.equal(entries[2], BIN);
    assert.equal(entries[3], NVM, 'non-proto entry preserved');
  });

  test('preserves non-proto PATH entries and their relative order', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      [key]: [MANAGED, TOOLS_NODE, NVM, '/usr/bin', '/bin'].join(delimiter),
    };
    const out = sanitizeProtoEnv(env, MANAGED);
    const entries = pathEntries(out);
    // Non-proto entries keep their relative order after the promoted shims/bin.
    const nonProto = entries.filter((e) => e !== SHIMS && e !== BIN);
    assert.deepEqual(nonProto, [MANAGED, NVM, '/usr/bin', '/bin']);
  });

  test('structural npm/yarn availability: shim-managed tools resolve via shims, shim-less tools fall through', () => {
    // Represents the availability assumption STRUCTURALLY (via PATH order), not
    // machine-specifically: a tool WITH a shim in `shims` (node, npm, pnpm)
    // resolves via the promoted shims dir; a tool WITHOUT a shim (yarn, served
    // by a non-proto source like nvm4w) falls through to the next entry. The
    // helper promotes shims ahead of nvm4w regardless of which shims exist — it
    // never inspects the filesystem — so this ordering is the contract.
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      // managed bin + tools/node pinned entry + nvm4w (yarn source) + buried shims.
      [key]: [MANAGED, TOOLS_NODE, NVM, SHIMS].join(delimiter),
    };
    const out = sanitizeProtoEnv(env, MANAGED);
    const entries = pathEntries(out);
    assert.equal(entries[0], MANAGED, 'managed bin first (rg/fd win)');
    assert.equal(entries[1], SHIMS, 'shims ahead of nvm4w → shim-managed tools (node/npm/pnpm) resolve via proto');
    assert.ok(entries.indexOf(SHIMS) < entries.indexOf(NVM), 'shim-less tools (yarn) fall through to nvm4w');
    assert.ok(!entries.includes(TOOLS_NODE), 'pinned node install stripped → node no longer frozen to 22.22.3');
  });
});

describe('sanitizeProtoEnv — immutability, casing, idempotence', () => {
  test('does not mutate the input env (object or its PATH string)', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: '/p',
      PROTO_NODE_VERSION: '22.22.3',
      [key]: ['/p/tools/node/22.22.3', '/p/shims', '/nvm4w'].join(delimiter),
      HOME: '/home/x',
    };
    const pathBefore = env[key];
    const homeBefore = env.HOME;
    const keysBefore = Object.keys(env);
    sanitizeProtoEnv(env, '/agent/bin');
    assert.equal(env[key], pathBefore, 'input PATH string untouched');
    assert.equal(env.HOME, homeBefore);
    assert.deepEqual(Object.keys(env), keysBefore, 'input key set untouched');
    assert.equal(env.PROTO_NODE_VERSION, '22.22.3', 'input vars untouched');
  });

  test('is idempotent: sanitizing twice equals once', () => {
    const key = platformPathKey();
    const env: NodeJS.ProcessEnv = {
      PROTO_HOME: '/p',
      PROTO_NODE_VERSION: '22.22.3',
      PROTO_SHIM_NAME: 'node',
      [key]: ['/agent/bin', '/p/tools/node/22.22.3', '/p/shims', '/nvm4w'].join(delimiter),
    };
    const once = sanitizeProtoEnv(env, '/agent/bin');
    const twice = sanitizeProtoEnv(once, '/agent/bin');
    assert.deepEqual(twice, once);
  });

  test('preserves the Windows-style "Path" key casing (does not fabricate "PATH")', () => {
    // Windows envs carry the key as "Path" (capital P, lowercase ath). The
    // sanitized env must keep that exact key — NOT invent a separate "PATH" —
    // so the spawned shell sees one PATH with shims promoted under "Path".
    const env: NodeJS.ProcessEnv = {
      Path: 'C:\\agent\\bin;C:\\p\\tools\\node\\22.22.3;C:\\nvm4w',
      PROTO_HOME: 'C:\\p',
      PROTO_NODE_VERSION: '22.22.3',
    };
    const out = sanitizeProtoEnv(env, 'C:\\agent\\bin');
    assert.equal(out.Path, 'C:\\agent\\bin;C:\\p\\shims;C:\\p\\bin;C:\\nvm4w');
    assert.equal(out.PATH, undefined, 'must not fabricate a separate PATH key');
    assert.equal(out.PROTO_NODE_VERSION, undefined);
  });

  test('handles Windows backslash + mixed-case drive paths (structural, machine-independent)', () => {
    // Case-folding is keyed on the path STRUCTURE (a drive letter), not on
    // process.platform, so a Windows-style env is normalized consistently on
    // any test host. Mixed-case PROTO_HOME / managed bin / tools entry must all
    // match despite differing case.
    const env: NodeJS.ProcessEnv = {
      Path: 'C:\\Agent\\Bin;C:\\P\\Tools\\Node\\22.22.3;C:\\NVM4W',
      PROTO_HOME: 'c:\\P',
      PROTO_NODE_VERSION: '22.22.3',
    };
    const out = sanitizeProtoEnv(env, 'C:\\agent\\bin');
    const entries = (out.Path ?? '').split(';');
    assert.equal(entries[0], 'C:\\Agent\\Bin', 'managed bin preserved as-is (first)');
    assert.equal(entries[1], 'c:\\P\\shims', 'shims promoted right after managed bin');
    assert.equal(entries[2], 'c:\\P\\bin');
    assert.equal(entries[3], 'C:\\NVM4W', 'non-proto entry preserved');
    assert.ok(!entries.some((e) => /22\.22\.3/i.test(e)), 'tools/ version-pinned entry gone');
    assert.equal(out.PROTO_NODE_VERSION, undefined);
  });
});

describe('sanitizeProtoEnv — routing compositions (pool env + per-call spawnHook)', () => {
  // These mirror the exact compositions index.ts wires at each routing point:
  //   pool env        = sanitizeProtoEnv(prependManagedBinDir(process.env, bin), bin)
  //   per-call env    = sanitizeProtoEnv(getShellEnv-like env (managed bin already first), bin)
  // Both must yield: managed bin first, shims+bin second, tools/ stripped,
  // proto activation vars gone — the contract that makes every layer
  // (fast/warm/fallback) project-aware.
  const PROTO = '/p';
  const MANAGED = '/agent/bin';

  test('pool env recipe: prepend managed bin then sanitize', () => {
    const key = platformPathKey();
    const raw: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      PROTO_NODE_VERSION: '22.22.3',
      PROTO_SHIM_NAME: 'node',
      PROTO_SHIM_PATH: '/p/shims/node',
      PROTO_VERSION: '0.57.4',
      [key]: ['/p/tools/node/22.22.3', '/p/tools/node/22.22.3/globals/bin', '/p/shims', '/p/bin', '/nvm4w'].join(delimiter),
      HOME: '/home/x',
    };
    const poolEnv = sanitizeProtoEnv(prependManagedBinDir(raw, MANAGED), MANAGED);
    const entries = pathEntries(poolEnv);
    assert.equal(entries[0], MANAGED, 'managed bin first (rg/fd)');
    assert.equal(entries[1], '/p/shims', 'shims second');
    assert.equal(entries[2], '/p/bin', 'bin third');
    assert.equal(entries[3], '/nvm4w', 'non-proto entry preserved');
    assert.ok(!entries.includes('/p/tools/node/22.22.3'));
    assert.ok(!entries.includes('/p/tools/node/22.22.3/globals/bin'));
    assert.equal(poolEnv.PROTO_NODE_VERSION, undefined);
    assert.equal(poolEnv.PROTO_SHIM_NAME, undefined);
    assert.equal(poolEnv.PROTO_SHIM_PATH, undefined);
    assert.equal(poolEnv.PROTO_HOME, PROTO, 'PROTO_HOME kept (shims need it)');
    assert.equal(poolEnv.PROTO_VERSION, '0.57.4', "proto's own version kept");
    assert.equal(poolEnv.HOME, '/home/x');
  });

  test('per-call spawnHook recipe: sanitize an env whose managed bin is already first', () => {
    // pi's getShellEnv() already prepended the managed bin dir before the
    // spawnHook runs, so the per-call env arrives with managed bin at PATH[0].
    const key = platformPathKey();
    const callEnv: NodeJS.ProcessEnv = {
      PROTO_HOME: PROTO,
      PROTO_NODE_VERSION: '22.22.3',
      PROTO_NPM_SHIM: '/p/shims/npm',
      [key]: [MANAGED, '/p/tools/node/22.22.3', '/nvm4w'].join(delimiter),
    };
    const out = sanitizeProtoEnv(callEnv, MANAGED);
    const entries = pathEntries(out);
    assert.equal(entries[0], MANAGED, 'managed bin stays first');
    assert.equal(entries[1], '/p/shims');
    assert.equal(entries[2], '/p/bin');
    assert.equal(entries[3], '/nvm4w');
    assert.ok(!entries.includes('/p/tools/node/22.22.3'));
    assert.equal(out.PROTO_NODE_VERSION, undefined);
    assert.equal(out.PROTO_NPM_SHIM, undefined);
  });
});
