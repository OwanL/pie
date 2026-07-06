import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const lossyUrl = pathToFileURL(path.resolve(__dirname, '../lossy-rules.ts')).href;

type RuleResult = { text: string; changed: boolean; marker?: string } | null;
type RuleCtx = { toolName: string; input: Record<string, unknown>; profile: string };
type Rule = { name: string; run: (text: string, ctx: RuleCtx) => RuleResult };
type LossyModule = { LOSSY_RULES: Rule[] };

function rule(name: string, mod: LossyModule): Rule {
  const r = mod.LOSSY_RULES.find((x) => x.name === name);
  if (!r) throw new Error(`rule ${name} not found`);
  return r;
}

const bash = (command: string): RuleCtx => ({ toolName: 'bash', input: { command }, profile: 'default' });

const LS_L_OUTPUT = `total 24
drwxr-xr-x  2 user group 4096 Jul  6 12:34 src
-rw-r--r--  1 user group  123 Jul  6 12:34 readme.md
lrwxrwxrwx  1 user group    5 Jul  6 12:34 link -> target
`;

const GIT_LOG_OUTPUT = `commit a1b2c3d4e5f6789012345678901234567890abcd (HEAD -> main, origin/main)
Author: Owan L <owan@example.com>
Date:   Fri Jul 4 12:00:00 2025

    Fix the widget renderer

    The widget was double-rendering on edge cases. Add a guard.

commit f6e5d4c3b2a109876543210987654321098fedcb
Author: Owan L <owan@example.com>
Date:   Thu Jul 3 10:30:00 2025

    Initial commit
`;

describe('ls-long rule', () => {
  let mod: LossyModule;
  test.before(async () => {
    mod = (await import(lossyUrl)) as LossyModule;
  });

  test('reduces ls -l to names + dir marker', () => {
    const out = rule('ls-long', mod).run(LS_L_OUTPUT, bash('ls -l'));
    assert.equal(out?.text, 'src/\nreadme.md\nlink -> target\n');
    assert.equal(out?.changed, true);
    assert.match(out?.marker ?? '', /3 entries/);
  });

  test('detects -l inside combined flag groups (-la, -lah)', () => {
    const out = rule('ls-long', mod).run(LS_L_OUTPUT, bash('ls -lah'));
    assert.ok(out, 'expected -lah to be detected as long format');
    assert.equal(out?.text, 'src/\nreadme.md\nlink -> target\n');
  });

  test('drops the "total N" summary line', () => {
    const out = rule('ls-long', mod).run(LS_L_OUTPUT, bash('ls -l'));
    assert.ok(out);
    assert.doesNotMatch(out!.text, /total/);
  });

  test('handles filenames with spaces', () => {
    const input = `-rw-r--r-- 1 u g 10 Jul 6 12:34 my file name.txt\n`;
    const out = rule('ls-long', mod).run(input, bash('ls -l'));
    assert.equal(out?.text, 'my file name.txt\n');
  });

  test('no-op for plain ls (no -l flag)', () => {
    const out = rule('ls-long', mod).run(LS_L_OUTPUT, bash('ls'));
    assert.equal(out, null);
  });

  test('no-op for piped ls -l (output is not ls\'s)', () => {
    const out = rule('ls-long', mod).run(LS_L_OUTPUT, bash('ls -l | grep src'));
    assert.equal(out, null);
  });

  test('no-op for newline-separated commands (multi-line script)', () => {
    // A real newline in input.command means a multi-line script — the output
    // isn't a lone ls's, so the guard must skip (else parseLsLong drops the
    // other commands' lines from the visible result).
    assert.equal(rule('ls-long', mod).run(LS_L_OUTPUT, bash('ls -l\necho done')), null);
  });

  test('no-op for non-bash tools (pi ls tool does not emit -l)', () => {
    const out = rule('ls-long', mod).run(LS_L_OUTPUT, { toolName: 'ls', input: { path: '.' }, profile: 'default' });
    assert.equal(out, null);
  });

  test('no-op when output is not -l-shaped (uncertain → keep)', () => {
    const notLs = `src\ntest\nreadme.md\n`;
    const out = rule('ls-long', mod).run(notLs, bash('ls -l'));
    assert.equal(out, null);
  });

  test('no-op when too few lines parse (guards against other columnar output)', () => {
    // Looks vaguely tabular but doesn't match the -l datetime field shape.
    const junk = `d-something foo bar baz qux notamonth 99 99 name\n` + `another line of noise here\n`;
    const out = rule('ls-long', mod).run(junk, bash('ls -l'));
    assert.equal(out, null);
  });
});

describe('git-log rule', () => {
  let mod: LossyModule;
  test.before(async () => {
    mod = (await import(lossyUrl)) as LossyModule;
  });

  test('reduces verbose git log to oneline + short hash', () => {
    const out = rule('git-log', mod).run(GIT_LOG_OUTPUT, bash('git log'));
    assert.equal(
      out?.text,
      'a1b2c3d Fix the widget renderer (HEAD -> main, origin/main)\n' +
        'f6e5d4c Initial commit\n',
    );
    assert.equal(out?.changed, true);
    assert.match(out?.marker ?? '', /2 commits/);
  });

  test('drops author/date/body, keeps subject only', () => {
    const out = rule('git-log', mod).run(GIT_LOG_OUTPUT, bash('git log'));
    assert.ok(out);
    assert.doesNotMatch(out!.text, /Author/);
    assert.doesNotMatch(out!.text, /Date/);
    assert.doesNotMatch(out!.text, /double-rendering/); // body dropped
  });

  test('uses 7-char short hash', () => {
    const out = rule('git-log', mod).run(GIT_LOG_OUTPUT, bash('git log'));
    assert.ok(out);
    assert.match(out!.text.split('\n')[0]!, /^a1b2c3d /);
  });

  test('no-op for --oneline (already compact)', () => {
    const oneline = 'a1b2c3d Fix the widget renderer (HEAD -> main, origin/main)\n';
    const out = rule('git-log', mod).run(oneline, bash('git log --oneline'));
    assert.equal(out, null);
  });

  test('no-op when diff/stat content is requested (agent wants detail, not the list)', () => {
    // These options mean the agent asked for the diff/file changes — pruning to
    // oneline would drop what was explicitly requested (tier-3 risk).
    for (const cmd of ['git log -p', 'git log --patch', 'git log --stat', 'git log --numstat', 'git log --name-only', 'git log --name-status', 'git log -p5']) {
      assert.equal(rule('git-log', mod).run(GIT_LOG_OUTPUT, bash(cmd)), null, `${cmd} should not be pruned`);
    }
  });

  test('no-op for non-git-log commands', () => {
    const out = rule('git-log', mod).run(GIT_LOG_OUTPUT, bash('git status'));
    assert.equal(out, null);
  });

  test('no-op for piped git log', () => {
    const out = rule('git-log', mod).run(GIT_LOG_OUTPUT, bash('git log | head'));
    assert.equal(out, null);
  });

  test('no-op for newline-separated git log (multi-line script)', () => {
    assert.equal(rule('git-log', mod).run(GIT_LOG_OUTPUT, bash('git log\necho done')), null);
  });

  test('no-op for -u / -c / --cc (diff synonyms of -p — agent wants the diff)', () => {
    for (const cmd of ['git log -u', 'git log -c', 'git log --cc', 'git log -u5', 'git log --remerge-diff']) {
      assert.equal(rule('git-log', mod).run(GIT_LOG_OUTPUT, bash(cmd)), null, `${cmd} should not be pruned`);
    }
  });

  test('prunes git log -m (list intent — -m alone emits no diff)', () => {
    // Verified empirically: `git log -m` without -p shows the commit list, no
    // diffs → list intent → prune. (-m only matters combined with -p/-u, which
    // are caught by their own short-flag check.)
    const out = rule('git-log', mod).run(GIT_LOG_OUTPUT, bash('git log -m'));
    assert.ok(out, 'git log -m should be pruned (list intent)');
  });

  test('no-op when output has no commit blocks', () => {
    const out = rule('git-log', mod).run('not a git log at all\n', bash('git log'));
    assert.equal(out, null);
  });

  test('handles a single commit', () => {
    const single = `commit abcdef1234567890\nAuthor: X <x@x>\nDate:   Fri Jul 4 12:00:00 2025\n\n    Only commit\n`;
    const out = rule('git-log', mod).run(single, bash('git log -1'));
    assert.equal(out?.text, 'abcdef1 Only commit\n');
  });

  test('prunes plain git log with filters (--author, -n, --since) — list intent', () => {
    // Filter options don't request diff content → the agent wants the list.
    const out = rule('git-log', mod).run(GIT_LOG_OUTPUT, bash('git log --author=foo -5'));
    assert.ok(out, 'git log --author=foo -5 should be pruned (list intent)');
    assert.match(out!.text, /^a1b2c3d /);
  });
});
