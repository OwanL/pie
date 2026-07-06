import assert from 'node:assert/strict';
import test, { describe, beforeEach, afterEach } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const indexUrl = pathToFileURL(path.resolve(__dirname, '../index.ts')).href;
const configUrl = pathToFileURL(path.resolve(__dirname, '../config.ts')).href;
const loggerUrl = pathToFileURL(path.resolve(__dirname, '../logger.ts')).href;

type RuleToggles = { ansi: boolean; whitespace: boolean; blankRun: boolean; jsonMinify: boolean; lsLong: boolean; gitLog: boolean };
type Config = { enabled: boolean; profile: string; rules: RuleToggles };
type ToolContent = { type: 'text'; text: string };
type Event = {
  type: 'tool_result';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: ToolContent[];
  isError: boolean;
  details: unknown;
};
type Patch = { content?: ToolContent[]; details?: unknown; isError?: boolean };
type PruningBadge = { rules: string[]; tokensSaved: number };

type IndexModule = {
  default: (pi: {
    on: (event: string, handler: (e: Event, ctx: unknown) => Promise<Patch | undefined>) => void;
  }) => void;
  setStashDirForTesting: (dir: string | null) => void;
};
type ConfigModule = {
  setConfigOverrideForTesting: (c: Config | null) => void;
  resetConfigCache: () => void;
};
type LoggerModule = {
  setLogPathOverrideForTesting: (p: string | null, maxBytes?: number) => void;
  flushLog: () => Promise<void>;
};

const ALL_ON: RuleToggles = { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true };
const ENABLED: Config = { enabled: true, profile: 'default', rules: { ...ALL_ON } };

function ev(over: Partial<Event>): Event {
  return {
    type: 'tool_result',
    toolName: 'bash',
    toolCallId: 'c1',
    input: { command: 'ls' },
    content: [{ type: 'text', text: '' }],
    isError: false,
    details: undefined,
    ...over,
  };
}

function badgeOf(patch: Patch | undefined): PruningBadge | undefined {
  const details = patch?.details as { pruningBadge?: PruningBadge } | undefined;
  return details?.pruningBadge;
}

describe('index handler (visibility badge + analytics)', () => {
  let handler: (e: Event, ctx: unknown) => Promise<Patch | undefined>;
  let configMod: ConfigModule;
  let loggerMod: LoggerModule;
  let setStashDir: (dir: string | null) => void;
  let dir: string;
  let logPath: string;
  let stashDir: string;

  test.before(async () => {
    configMod = (await import(configUrl)) as ConfigModule;
    loggerMod = (await import(loggerUrl)) as LoggerModule;
    const indexMod = (await import(indexUrl)) as IndexModule;
    setStashDir = indexMod.setStashDirForTesting;
    let captured: ((e: Event, ctx: unknown) => Promise<Patch | undefined>) | undefined;
    const mockPi = {
      on: (_event: string, h: (e: Event, ctx: unknown) => Promise<Patch | undefined>) => {
        captured = h;
      },
    };
    indexMod.default(mockPi);
    if (!captured) throw new Error('tool_result handler was not registered');
    handler = captured;
  });

  beforeEach(() => {
    configMod.setConfigOverrideForTesting({ ...ENABLED, rules: { ...ALL_ON } });
    dir = mkdtempSync(path.join(tmpdir(), 'trp-index-'));
    logPath = path.join(dir, 'tool-result-pruning.jsonl');
    stashDir = path.join(dir, 'stash');
    setStashDir(stashDir);
    loggerMod.setLogPathOverrideForTesting(logPath);
  });

  afterEach(async () => {
    // Drain queued logger writes BEFORE resetting the override — otherwise
    // pending writes either hit a torn-down dir (ENOENT noise) or escape to
    // the real data/tool-result-pruning.jsonl (test-isolation leak).
    await loggerMod.flushLog();
    setStashDir(null);
    configMod.setConfigOverrideForTesting(null);
    configMod.resetConfigCache();
    loggerMod.setLogPathOverrideForTesting(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns undefined when nothing is pruned (lean output)', async () => {
    const out = await handler(ev({ content: [{ type: 'text', text: 'lean' }] }), {});
    assert.equal(out, undefined);
  });

  test('patch.details.pruningBadge carries fired rule names + tokensSaved', async () => {
    const out = await handler(ev({ content: [{ type: 'text', text: '\u001B[31mhi\u001B[0m   ' }] }), {});
    assert.ok(out);
    const badge = badgeOf(out);
    assert.ok(badge);
    assert.deepEqual(badge!.rules, ['ansi-strip', 'trim-trailing-whitespace']);
    assert.equal(typeof badge!.tokensSaved, 'number');
    assert.ok(badge!.tokensSaved > 0, `expected tokensSaved > 0, got ${badge!.tokensSaved}`);
  });

  test('preserves existing event.details fields (spread, never replace)', async () => {
    const out = await handler(
      ev({
        content: [{ type: 'text', text: '\u001B[31mhi\u001B[0m' }],
        details: { truncated: true, fullOutputPath: '/tmp/x' },
      }),
      {},
    );
    assert.ok(out);
    const details = out!.details as { truncated?: boolean; fullOutputPath?: string; pruningBadge?: PruningBadge };
    assert.equal(details.truncated, true);
    assert.equal(details.fullOutputPath, '/tmp/x');
    assert.deepEqual(details.pruningBadge!.rules, ['ansi-strip']);
  });

  test('returns undefined for errors / read results (guards)', async () => {
    assert.equal(
      await handler(ev({ isError: true, content: [{ type: 'text', text: '\u001B[31mboom\u001B[0m' }] }), {}),
      undefined,
    );
    assert.equal(
      await handler(ev({ toolName: 'read', content: [{ type: 'text', text: '{\n  "a": 1\n}' }] }), {}),
      undefined,
    );
  });

  test('disabled rule does not fire (badge reflects only enabled rules)', async () => {
    configMod.setConfigOverrideForTesting({
      enabled: true,
      profile: 'default',
      rules: { ansi: false, whitespace: true, blankRun: true, jsonMinify: true, lsLong: false, gitLog: false },
    });
    const out = await handler(ev({ content: [{ type: 'text', text: '\u001B[31ma\u001B[0m   ' }] }), {});
    assert.ok(out);
    // ANSI preserved (ansi disabled), trailing ws stripped.
    assert.equal(out!.content![0]!.text, '\u001B[31ma\u001B[0m');
    assert.deepEqual(badgeOf(out)!.rules, ['trim-trailing-whitespace']);
  });

  test('records a tool_result_pruned analytics event', async () => {
    await handler(
      ev({ content: [{ type: 'text', text: '\u001B[31mhi\u001B[0m   ' }] }),
      { sessionManager: { getSessionId: () => 'sess-1' } },
    );
    await loggerMod.flushLog();
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1);
    const evt = JSON.parse(lines[0]!);
    assert.equal(evt.event, 'tool_result_pruned');
    assert.equal(evt.sessionId, 'sess-1');
    assert.deepEqual(evt.rules, ['ansi-strip', 'trim-trailing-whitespace']);
    assert.ok(evt.tokensSaved > 0);
  });

  test('noise gate: no badge when tokensSaved === 0, but content still patched', async () => {
    // A lossless rewrite that changes bytes but not the BPE count (normalizing
    // a whitespace-only middle line: "a\n   \nb" -> "a\n\nb" is 3->3 tokens on
    // cl100k). The content patch still applies (lossless hygiene), but no
    // visibility chip — ~45% of rewrites saved 0 tokens in production, all
    // noise. Analytics still records it (measurement stays complete).
    const out = await handler(ev({ content: [{ type: 'text', text: 'a\n   \nb' }] }), {});
    assert.ok(out, 'expected a content patch');
    assert.equal(out!.content![0]!.text, 'a\n\nb');
    assert.equal(badgeOf(out), undefined, 'no badge when tokensSaved === 0');
    await loggerMod.flushLog();
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    assert.equal(lines.length, 1, 'analytics still records the 0-token rewrite');
    assert.equal(JSON.parse(lines[0]!).tokensSaved, 0);
  });

  // --- lossy tier + recall contract (§7.3) ---
  // Fixtures are deliberately large enough that the lossy reduction clearly
  // outweighs the fidelity-marker overhead (LOSSY_MIN_NET_SAVED) even on
  // long-temp-path platforms (Windows). See the "tiny output" test for the
  // flip side — the gate skips lossy when the marker would eat the savings.
  const LS_L_BIG = [
    'total 96',
    'drwxr-xr-x  2 user group 4096 Jul  6 12:34 src',
    'drwxr-xr-x  2 user group 4096 Jul  6 12:34 test',
    'drwxr-xr-x  3 user group 4096 Jul  6 12:34 docs',
    '-rw-r--r--  1 user group  123 Jul  6 12:34 readme.md',
    '-rw-r--r--  1 user group 2048 Jul  6 12:34 package.json',
    '-rw-r--r--  1 user group  512 Jul  6 12:34 tsconfig.json',
    '-rw-r--r--  1 user group  256 Jul  6 12:34 .gitignore',
    'lrwxrwxrwx  1 user group    5 Jul  6 12:34 link -> target',
  ].join('\n') + '\n';
  const GIT_LOG_3 = [
    'commit a1b2c3d4e5f6789012345678901234567890abcd (HEAD -> main)',
    'Author: X <x@x>', 'Date:   Fri Jul 4 12:00:00 2025', '', '    Fix the widget renderer', '',
    'commit a1b2c3d4e5f6789012345678901234567890abce',
    'Author: X <x@x>', 'Date:   Thu Jul 3 10:30:00 2025', '', '    Add widget tests', '',
    'commit a1b2c3d4e5f6789012345678901234567890abcf',
    'Author: X <x@x>', 'Date:   Wed Jul 2 09:00:00 2025', '', '    Initial widget', '',
  ].join('\n');

  test('ls -l lossy: fidelity marker + recall stash + details.pruning', async () => {
    const out = await handler(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: LS_L_BIG }] }), {});
    assert.ok(out);
    const text = out!.content![0]!.text;
    assert.match(text, /^\[pruned: ls-long \(8 entries → names only\) — raw: .*\]\n/);
    assert.ok(text.endsWith('src/\ntest/\ndocs/\nreadme.md\npackage.json\ntsconfig.json\n.gitignore\nlink -> target\n'));
    const pruning = (out!.details as { pruning?: { id: string; rawPath: string; rules: string[] } }).pruning;
    assert.ok(pruning, 'details.pruning must be set for a lossy result');
    assert.deepEqual(pruning!.rules, ['ls-long']);
    assert.ok(pruning!.rawPath.startsWith(stashDir));
    assert.ok(existsSync(pruning!.rawPath), 'stash file not written');
    assert.equal(readFileSync(pruning!.rawPath, 'utf-8'), LS_L_BIG);
    const badge = badgeOf(out);
    assert.ok(badge, 'expected a badge for a big lossy win');
    assert.deepEqual(badge!.rules, ['ls-long']);
    assert.ok(badge!.tokensSaved >= 8);
  });

  test('recall stash holds the pre-pruning text (incl. ANSI lossless stripped)', async () => {
    const colored = '\u001B[31m' + LS_L_BIG + '\u001B[0m';
    const out = await handler(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: colored }] }), {});
    assert.ok(out);
    const pruning = (out!.details as { pruning?: { rawPath: string } }).pruning!;
    assert.equal(readFileSync(pruning.rawPath, 'utf-8'), colored);
    assert.doesNotMatch(out!.content![0]!.text, /\u001B/);
    assert.match(out!.content![0]!.text, /^\[pruned:/);
  });

  test('tiny ls -l is NOT lossy-pruned (marker would eat the savings)', async () => {
    // 2 entries: the fidelity-marker overhead exceeds the lossy reduction on
    // a long-temp-path platform → the gate keeps the lossless-only result
    // (here, no lossless opportunity either) and history stays untouched.
    const tiny = 'total 24\ndrwxr-xr-x  2 user group 4096 Jul  6 12:34 src\n-rw-r--r--  1 user group  123 Jul  6 12:34 readme.md\n';
    const out = await handler(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: tiny }] }), {});
    assert.equal(out, undefined, 'tiny output should not be lossy-pruned');
  });

  test('net-savings gate compares vs the LOSSLESS fallback, not the original (M1 regression)', async () => {
    // A 1-entry heavily-colored `ls -l` (--color=always): ANSI strip (lossless)
    // saves a lot, but the lossy rewrite (1 name + marker) costs MORE than the
    // lossless result. Lossy must NOT apply — applying it would drop the
    // perms/owner/size while *increasing* context vs the lossless-only result.
    // The gate must compare candidate-vs-losslessText; comparing vs the
    // original (beforeText) folds the ANSI savings in and wrongly applies lossy.
    const heavy =
      '\u001B[0m\u001B[01;34mtotal 24\u001B[0m\n' +
      '\u001B[01;32mdrwxr-xr-x\u001B[0m \u001B[01;36m2\u001B[0m \u001B[01;33muser\u001B[0m \u001B[01;33mgroup\u001B[0m \u001B[01;36m4096\u001B[0m \u001B[01;36mJul\u001B[0m \u001B[01;36m 6\u001B[0m \u001B[01;36m12:34\u001B[0m \u001B[01;34msrc\u001B[0m\n';
    const out = await handler(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: heavy }] }), {});
    assert.ok(out);
    // Lossy NOT applied: content is the ANSI-stripped -l line (keeps perms/etc),
    // no fidelity marker, no recall contract.
    assert.equal(out!.content![0]!.text, 'total 24\ndrwxr-xr-x 2 user group 4096 Jul  6 12:34 src\n');
    assert.doesNotMatch(out!.content![0]!.text, /^\[pruned/);
    assert.equal((out!.details as { pruning?: unknown }).pruning, undefined);
    // Badge reflects the lossless ANSI-strip win only.
    assert.deepEqual(badgeOf(out)!.rules, ['ansi-strip']);
  });

  test('stash write failure falls back to lossless-only (hard gate, no lossy loss)', async () => {
    const blocker = path.join(dir, 'blocker-file');
    writeFileSync(blocker, 'x');
    setStashDir(path.join(blocker, 'sub'));
    // Big + ANSI: the size gate passes (net >= 8), so the write is attempted
    // and fails (parent is a file) → the lossy rewrite is abandoned and the
    // lossless ANSI-stripped result is used instead.
    const colored = '\u001B[31m' + LS_L_BIG + '\u001B[0m';
    const out = await handler(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: colored }] }), {});
    assert.ok(out);
    assert.doesNotMatch(out!.content![0]!.text, /\u001B/);
    assert.doesNotMatch(out!.content![0]!.text, /^\[pruned/);
    assert.equal((out!.details as { pruning?: unknown }).pruning, undefined);
    assert.deepEqual(badgeOf(out)!.rules, ['ansi-strip']);
  });

  test('stash failure with no lossless opportunity → undefined (history untouched)', async () => {
    const blocker = path.join(dir, 'blocker-file');
    writeFileSync(blocker, 'x');
    setStashDir(path.join(blocker, 'sub'));
    const out = await handler(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: LS_L_BIG }] }), {});
    assert.equal(out, undefined);
  });

  test('git log lossy: oneline + marker + stash', async () => {
    const out = await handler(ev({ input: { command: 'git log' }, content: [{ type: 'text', text: GIT_LOG_3 }] }), {});
    assert.ok(out);
    assert.match(
      out!.content![0]!.text,
      /^\[pruned: git-log \(3 commits → oneline\) — raw: .*\]\na1b2c3d Fix the widget renderer \(HEAD -> main\)\na1b2c3d Add widget tests\na1b2c3d Initial widget\n$/,
    );
    const pruning = (out!.details as { pruning?: { rules: string[]; rawPath: string } }).pruning!;
    assert.deepEqual(pruning.rules, ['git-log']);
    assert.equal(readFileSync(pruning.rawPath, 'utf-8'), GIT_LOG_3);
  });
});
