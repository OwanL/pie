import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findTestBash } from './test-shell.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const autoPruneUrl = pathToFileURL(path.resolve(__dirname, '../src/auto-prune.ts')).href;
const opsUrl = pathToFileURL(path.resolve(__dirname, '../src/operations.ts')).href;

type Rewrite = (command: string, opts: { gnuGrepProbe: () => boolean }) => string;

async function loadRewrite(): Promise<Rewrite> {
  const m = await import(autoPruneUrl);
  return m.rewriteForPrune as Rewrite;
}

async function loadProbe(): Promise<(shellPath: string) => boolean> {
  const m = await import(autoPruneUrl);
  return m.probeGnuGrep as (shellPath: string) => boolean;
}

type AnyOps = { exec: (command: string, cwd: string, o: { onData: (b: Buffer) => void }) => Promise<{ exitCode: number | null }> };
type CreateOpsOpts = {
  pool: null;
  fastPathEnabled: boolean;
  autoPruneEnabled?: boolean;
  gnuGrepProbe?: () => boolean;
  log?: (p: Record<string, unknown>) => void;
  fallbackOps: AnyOps;
  metrics?: { totalFastPath: number; totalWarm: number; totalFallback: number };
};
type CreateOps = (o: CreateOpsOpts) => AnyOps;

async function loadOps(): Promise<CreateOps> {
  const m = await import(opsUrl);
  return m.createWarmBashOperations as unknown as CreateOps;
}

const EXCLUDE_FLAGS =
  '--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.venv --exclude-dir=dist --exclude-dir=build --exclude-dir=.next --exclude-dir=coverage --exclude-dir=.turbo --exclude-dir=.moon';
const gnu = () => true;
const noGnu = () => false;

describe('warm-bash auto-prune: grep rule', () => {
  let rewrite: Rewrite;
  test.before(async () => { rewrite = await loadRewrite(); });

  test('recursive grep gets exclude-dir flags injected after the program token', () => {
    assert.equal(
      rewrite('grep -rn foo .', { gnuGrepProbe: gnu }),
      `grep ${EXCLUDE_FLAGS} -rn foo .`,
    );
  });

  test('-r, -R, -rnI, -Er all count as recursive', () => {
    for (const flag of ['-r', '-R', '-rnI', '-Er']) {
      const r = rewrite(`grep ${flag} foo .`, { gnuGrepProbe: gnu });
      assert.ok(r.includes('--exclude-dir=node_modules'), `${flag} should rewrite`);
      assert.ok(r.startsWith(`grep ${EXCLUDE_FLAGS} ${flag} `), `${flag} prefix`);
    }
  });

  test('egrep / fgrep / path-qualified grep rewrite too', () => {
    assert.ok(rewrite('egrep -rn foo .', { gnuGrepProbe: gnu }).startsWith(`egrep ${EXCLUDE_FLAGS} -rn `));
    assert.ok(rewrite('fgrep -rn foo .', { gnuGrepProbe: gnu }).startsWith(`fgrep ${EXCLUDE_FLAGS} -rn `));
    assert.ok(rewrite('/usr/bin/grep -rn foo .', { gnuGrepProbe: gnu }).startsWith(`/usr/bin/grep ${EXCLUDE_FLAGS} -rn `));
  });

  test('leading VAR=val assignments are peeled and preserved', () => {
    assert.equal(
      rewrite('LANG=C grep -rn foo .', { gnuGrepProbe: gnu }),
      `LANG=C grep ${EXCLUDE_FLAGS} -rn foo .`,
    );
  });

  test('non-recursive grep is passed through unchanged', () => {
    assert.equal(rewrite('grep -n foo file.c', { gnuGrepProbe: gnu }), 'grep -n foo file.c');
    assert.equal(rewrite('grep foo .', { gnuGrepProbe: gnu }), 'grep foo .');
  });

  test('grep already carrying --exclude-dir=node_modules passes through', () => {
    assert.equal(
      rewrite('grep --exclude-dir=node_modules -rn foo .', { gnuGrepProbe: gnu }),
      'grep --exclude-dir=node_modules -rn foo .',
    );
    // space-separated form too
    assert.equal(
      rewrite('grep --exclude-dir node_modules -rn foo .', { gnuGrepProbe: gnu }),
      'grep --exclude-dir node_modules -rn foo .',
    );
    // a different --exclude-dir does NOT count as already-excluded (idempotent dup is harmless)
    assert.ok(rewrite('grep --exclude-dir=dist -rn foo .', { gnuGrepProbe: gnu }).includes('--exclude-dir=node_modules'));
  });
});

describe('warm-bash auto-prune: FIX #3 GNU-grep gate', () => {
  let rewrite: Rewrite;
  test.before(async () => { rewrite = await loadRewrite(); });

  test('non-GNU grep detected → recursive grep passed through even though gate env on', () => {
    assert.equal(rewrite('grep -rn foo .', { gnuGrepProbe: noGnu }), 'grep -rn foo .');
  });

  test('GNU grep → rewritten', () => {
    assert.notEqual(rewrite('grep -rn foo .', { gnuGrepProbe: gnu }), 'grep -rn foo .');
  });

  test('non-GNU does not affect find (find has its own -prune, no grep dependency)', () => {
    assert.notEqual(rewrite('find . -name \'*.ts\'', { gnuGrepProbe: noGnu }), 'find . -name \'*.ts\'');
  });
});

describe('warm-bash auto-prune: find rule', () => {
  let rewrite: Rewrite;
  test.before(async () => { rewrite = await loadRewrite(); });

  test('bare-path find wraps expr in prune + -print', () => {
    assert.equal(
      rewrite('find . -name \'*.ts\'', { gnuGrepProbe: gnu }),
      'find . \\( -name node_modules -o -name .git \\) -prune -o \\( -name \'*.ts\' \\) -print',
    );
  });

  test('no-path find defaults to .', () => {
    assert.equal(
      rewrite('find -name \'*.ts\'', { gnuGrepProbe: gnu }),
      'find . \\( -name node_modules -o -name .git \\) -prune -o \\( -name \'*.ts\' \\) -print',
    );
  });

  test('find with no expression appends -print only', () => {
    assert.equal(
      rewrite('find .', { gnuGrepProbe: gnu }),
      'find . \\( -name node_modules -o -name .git \\) -prune -o -print',
    );
    assert.equal(
      rewrite('find', { gnuGrepProbe: gnu }),
      'find . \\( -name node_modules -o -name .git \\) -prune -o -print',
    );
  });

  test('multi-primary expression preserved verbatim', () => {
    assert.equal(
      rewrite('find . -name \'*.ts\' -type f', { gnuGrepProbe: gnu }),
      'find . \\( -name node_modules -o -name .git \\) -prune -o \\( -name \'*.ts\' -type f \\) -print',
    );
  });

  test('user OR-chain (-o) is wrapped in \\( … \\) to preserve precedence', () => {
    assert.equal(
      rewrite("find . -name '*.ts' -o -name '*.js'", { gnuGrepProbe: gnu }),
      'find . \\( -name node_modules -o -name .git \\) -prune -o \\( -name \'*.ts\' -o -name \'*.js\' \\) -print',
    );
  });

  test('scoped path (src, /tmp) passes through', () => {
    assert.equal(rewrite('find src -name \'*.ts\'', { gnuGrepProbe: gnu }), 'find src -name \'*.ts\'');
    assert.equal(rewrite('find /tmp -name x', { gnuGrepProbe: gnu }), 'find /tmp -name x');
  });

  test('multiple leading paths (find . src …) pass through (wrap only handles one root)', () => {
    assert.equal(rewrite("find . src -name '*.ts'", { gnuGrepProbe: gnu }), "find . src -name '*.ts'");
    assert.equal(rewrite('find . ./other -name x', { gnuGrepProbe: gnu }), 'find . ./other -name x');
    assert.equal(rewrite('find src lib -name x', { gnuGrepProbe: gnu }), 'find src lib -name x');
  });

  test('negation (!) and -not are preserved inside the wrapped expression', () => {
    assert.equal(
      rewrite("find . ! -name '*.ts'", { gnuGrepProbe: gnu }),
      'find . \\( -name node_modules -o -name .git \\) -prune -o \\( ! -name \'*.ts\' \\) -print',
    );
  });

  test('actions (-print/-exec/-delete/…) pass through', () => {
    assert.equal(rewrite('find . -name \'*.ts\' -print', { gnuGrepProbe: gnu }), 'find . -name \'*.ts\' -print');
    assert.equal(rewrite('find . -name \'*.ts\' -delete', { gnuGrepProbe: gnu }), 'find . -name \'*.ts\' -delete');
    assert.equal(rewrite('find . -name x -exec echo {} \\;', { gnuGrepProbe: gnu }), 'find . -name x -exec echo {} \\;');
  });

  test('existing -prune passes through', () => {
    assert.equal(rewrite('find . -name x -prune', { gnuGrepProbe: gnu }), 'find . -name x -prune');
  });

  test('global options (-maxdepth/…) pass through', () => {
    assert.equal(rewrite('find . -maxdepth 2 -name \'*.ts\'', { gnuGrepProbe: gnu }), 'find . -maxdepth 2 -name \'*.ts\'');
    assert.equal(rewrite('find . -mount -name x', { gnuGrepProbe: gnu }), 'find . -mount -name x');
    // -d / -depth are globals that must precede the path; either position → passthrough.
    assert.equal(rewrite('find -d . -name x', { gnuGrepProbe: gnu }), 'find -d . -name x');
    assert.equal(rewrite('find . -depth -name x', { gnuGrepProbe: gnu }), 'find . -depth -name x');
  });

  test('expression grouping via \\( \\) passes through (backslash)', () => {
    assert.equal(rewrite('find . \\( -name x -o -name y \\)', { gnuGrepProbe: gnu }), 'find . \\( -name x -o -name y \\)');
  });
});

describe('warm-bash auto-prune: FIX #2 prune-dir references pass through', () => {
  let rewrite: Rewrite;
  test.before(async () => { rewrite = await loadRewrite(); });

  test('-name node_modules / .git (exact) → passthrough', () => {
    assert.equal(rewrite('find . -name node_modules', { gnuGrepProbe: gnu }), 'find . -name node_modules');
    assert.equal(rewrite('find . -name .git', { gnuGrepProbe: gnu }), 'find . -name .git');
  });

  test('-iname variants → passthrough', () => {
    assert.equal(rewrite('find . -iname node_modules', { gnuGrepProbe: gnu }), 'find . -iname node_modules');
    assert.equal(rewrite('find . -iname .git', { gnuGrepProbe: gnu }), 'find . -iname .git');
  });

  test('-path / -ipath referencing node_modules / .git → passthrough', () => {
    assert.equal(rewrite("find . -path '*/node_modules/*'", { gnuGrepProbe: gnu }), "find . -path '*/node_modules/*'");
    assert.equal(rewrite("find . -ipath '*/.git/*'", { gnuGrepProbe: gnu }), "find . -ipath '*/.git/*'");
  });

  test('substring references (*node_modules*, *.git*) → passthrough (prune would hide those results)', () => {
    assert.equal(rewrite("find . -path '*node_modules*' -type f", { gnuGrepProbe: gnu }), "find . -path '*node_modules*' -type f");
    assert.equal(rewrite("find . -name '*node_modules*'", { gnuGrepProbe: gnu }), "find . -name '*node_modules*'");
    assert.equal(rewrite("find . -path '*.git*'", { gnuGrepProbe: gnu }), "find . -path '*.git*'");
  });

  test('path-matching primaries (-wholename/-regex/-iregex/-lname) referencing prune dirs → passthrough', () => {
    // -wholename is -path's alias; -regex/-iregex match against the path; all
    // can reference a prune dir and would be defeated by the prune branch.
    assert.equal(rewrite("find . -wholename '*node_modules*'", { gnuGrepProbe: gnu }), "find . -wholename '*node_modules*'");
    assert.equal(rewrite("find . -regex '.*node_modules.*'", { gnuGrepProbe: gnu }), "find . -regex '.*node_modules.*'");
    assert.equal(rewrite("find . -iregex '.*\\.git.*'", { gnuGrepProbe: gnu }), "find . -iregex '.*\\.git.*'");
    assert.equal(rewrite("find . -lname '*node_modules*'", { gnuGrepProbe: gnu }), "find . -lname '*node_modules*'");
    // a regex that does NOT reference a prune dir is still rewritten
    assert.notEqual(rewrite("find . -regex '.*\\.ts$'", { gnuGrepProbe: gnu }), "find . -regex '.*\\.ts$'");
  });

  test('-name .github / .gitignore pass through too (conservative: contain .git substring)', () => {
    // Rewriting these would actually be safe (their files aren't inside .git
    // dirs), but the substring rule is correctness-first — slow-but-correct is
    // never worse than status quo, so we don't risk the rare *.git* harm.
    assert.equal(rewrite('find . -name .github', { gnuGrepProbe: gnu }), 'find . -name .github');
    assert.equal(rewrite("find . -name '.gitignore'", { gnuGrepProbe: gnu }), "find . -name '.gitignore'");
  });
});

describe('warm-bash auto-prune: FIX #1 byte-preservation + keyword/comment guard', () => {
  let rewrite: Rewrite;
  test.before(async () => { rewrite = await loadRewrite(); });

  test('unchanged command returns the SAME reference (byte-identical, no alloc)', () => {
    const input = 'echo hello world';
    assert.strictEqual(rewrite(input, { gnuGrepProbe: gnu }), input);
  });

  test('separators between segments are preserved byte-identical (&&, |, ;, newlines)', () => {
    // grep segment rewritten; the trailing operator + command must be untouched.
    const r = rewrite('grep -rn foo . && echo done', { gnuGrepProbe: gnu });
    assert.equal(r, `grep ${EXCLUDE_FLAGS} -rn foo . && echo done`);
    assert.ok(r.endsWith(' && echo done'));

    const r2 = rewrite('grep -rn foo . | head', { gnuGrepProbe: gnu });
    assert.equal(r2, `grep ${EXCLUDE_FLAGS} -rn foo . | head`);

    const r3 = rewrite('echo hi; grep -rn foo .; echo bye', { gnuGrepProbe: gnu });
    assert.equal(r3, `echo hi; grep ${EXCLUDE_FLAGS} -rn foo .; echo bye`);

    const r4 = rewrite('grep -rn foo .\necho done', { gnuGrepProbe: gnu });
    assert.equal(r4, `grep ${EXCLUDE_FLAGS} -rn foo .\necho done`);
  });

  test('multiline for-loop containing grep is passed through UNCHANGED', () => {
    const cmd = 'for f in *.ts; do\ngrep -rn foo "$f"\ndone';
    assert.equal(rewrite(cmd, { gnuGrepProbe: gnu }), cmd);
  });

  test('while / if-then-fi loops pass through unchanged', () => {
    const w = 'while true; do grep -rn foo .; done';
    assert.equal(rewrite(w, { gnuGrepProbe: gnu }), w);
    const iff = 'if true; then grep -rn foo .; fi';
    assert.equal(rewrite(iff, { gnuGrepProbe: gnu }), iff);
  });

  test('trailing # comment before a newline+command is not swallowed', () => {
    const cmd = 'grep -rn foo . # note\necho done';
    assert.equal(rewrite(cmd, { gnuGrepProbe: gnu }), cmd);
  });

  test('word-boundary: grep -rn foreach . is REWRITTEN (foreach is not the `for` keyword)', () => {
    const r = rewrite('grep -rn foreach .', { gnuGrepProbe: gnu });
    assert.ok(r.includes('--exclude-dir=node_modules'), 'foreach must not false-trigger the keyword guard');
  });

  test('word-boundary: quoted #include does not false-trigger the comment guard', () => {
    // Non-recursive → passes through via rule 3 regardless; assert the guard did
    // not bail early by checking the recursive variant IS rewritten.
    assert.equal(rewrite("grep -n '#include' file.c", { gnuGrepProbe: gnu }), "grep -n '#include' file.c");
    const r = rewrite("grep -rn '#include' .", { gnuGrepProbe: gnu });
    assert.ok(r.includes('--exclude-dir=node_modules'), "quoted '#include' must not false-trigger comment guard");
  });
});

describe('warm-bash auto-prune: FIX #5 heredoc short-circuits the whole rewrite', () => {
  let rewrite: Rewrite;
  test.before(async () => { rewrite = await loadRewrite(); });

  test('heredoc containing a grep-looking literal line is passed through byte-identical', () => {
    const cmd = "cat <<'EOF'\ngrep -rn foo .\nEOF";
    assert.equal(rewrite(cmd, { gnuGrepProbe: gnu }), cmd);
  });

  test('heredoc writing a script with a find-looking line is untouched', () => {
    const cmd = "cat <<'EOF' > script.sh\nfind . -name '*.ts'\nEOF";
    assert.equal(rewrite(cmd, { gnuGrepProbe: gnu }), cmd);
  });
});

describe('warm-bash auto-prune: segment battery', () => {
  let rewrite: Rewrite;
  test.before(async () => { rewrite = await loadRewrite(); });

  test('quoted operators inside a grep pattern do not split the segment', () => {
    assert.equal(
      rewrite('grep -rn "a;b" .', { gnuGrepProbe: gnu }),
      `grep ${EXCLUDE_FLAGS} -rn "a;b" .`,
    );
    assert.equal(
      rewrite("grep -rn 'a | b' .", { gnuGrepProbe: gnu }),
      `grep ${EXCLUDE_FLAGS} -rn 'a | b' .`,
    );
  });

  test('cd-prefix grep still rewrites (cd segment passthrough, grep segment rewritten)', () => {
    const r = rewrite('cd ext && grep -rn foo .', { gnuGrepProbe: gnu });
    assert.equal(r, `cd ext && grep ${EXCLUDE_FLAGS} -rn foo .`);
  });

  test('rg / ls -R / xargs grep pass through (not grep/find programs)', () => {
    assert.equal(rewrite('rg -n foo .', { gnuGrepProbe: gnu }), 'rg -n foo .');
    assert.equal(rewrite('ls -R', { gnuGrepProbe: gnu }), 'ls -R');
    assert.equal(rewrite('xargs grep -rn foo', { gnuGrepProbe: gnu }), 'xargs grep -rn foo');
  });

  test('grep inside $(…) is not rewritten (first token is not grep)', () => {
    assert.equal(rewrite('echo $(grep -rn foo .)', { gnuGrepProbe: gnu }), 'echo $(grep -rn foo .)');
  });

  test('grep with redirect / $() arg still rewrites the program token', () => {
    assert.equal(
      rewrite('grep -rn foo . 2>/dev/null', { gnuGrepProbe: gnu }),
      `grep ${EXCLUDE_FLAGS} -rn foo . 2>/dev/null`,
    );
    assert.equal(
      rewrite('grep -rn foo $(pwd) .', { gnuGrepProbe: gnu }),
      `grep ${EXCLUDE_FLAGS} -rn foo $(pwd) .`,
    );
  });

  test('backgrounded grep (&) rewrites the grep segment', () => {
    assert.equal(
      rewrite('grep -rn foo . &', { gnuGrepProbe: gnu }),
      `grep ${EXCLUDE_FLAGS} -rn foo . &`,
    );
  });

  test('empty / whitespace command passes through unchanged', () => {
    assert.equal(rewrite('', { gnuGrepProbe: gnu }), '');
    assert.equal(rewrite('   ', { gnuGrepProbe: gnu }), '   ');
  });
});

describe('warm-bash auto-prune: splitter & edge-case robustness', () => {
  let rewrite: Rewrite;
  test.before(async () => { rewrite = await loadRewrite(); });

  test('unclosed quote does not throw and is handled gracefully', () => {
    // The splitter leaves the rest of the line inside the (unclosed) quote frame;
    // rewrite still injects after `grep`, preserving the broken input byte-for-byte
    // apart from the injection. We do NOT make a broken command worse.
    const r = rewrite("grep -rn foo 'bar", { gnuGrepProbe: gnu });
    assert.ok(r.startsWith(`grep ${EXCLUDE_FLAGS} -rn foo 'bar`));
    assert.ok(!r.includes('\n'));
  });

  test('backtick command-substitution as a grep arg is preserved', () => {
    const r = rewrite('grep -rn foo `cat list` .', { gnuGrepProbe: gnu });
    assert.equal(r, `grep ${EXCLUDE_FLAGS} -rn foo \`cat list\` .`);
  });

  test('nested $( $( … ) ) command substitution is kept in one segment', () => {
    const r = rewrite('grep -rn $(cat $(find . -name list)) .', { gnuGrepProbe: gnu });
    assert.equal(r, `grep ${EXCLUDE_FLAGS} -rn $(cat $(find . -name list)) .`);
  });

  test('--exclude (file pattern, not --exclude-dir) does not block the rewrite', () => {
    const r = rewrite("grep --exclude='*.log' -rn foo .", { gnuGrepProbe: gnu });
    assert.ok(r.includes('--exclude-dir=node_modules'));
    assert.ok(r.includes("--exclude='*.log'"));
  });

  test('combined perl/recursive flags (-PErn) count as recursive', () => {
    const r = rewrite('grep -PErn foo .', { gnuGrepProbe: gnu });
    assert.ok(r.startsWith(`grep ${EXCLUDE_FLAGS} -PErn `));
  });

  test('leading / trailing / repeated separators are preserved byte-identical', () => {
    // Leading ';' → empty first segment; the grep segment still rewrites.
    assert.equal(rewrite('; grep -rn foo .', { gnuGrepProbe: gnu }), `; grep ${EXCLUDE_FLAGS} -rn foo .`);
    // Trailing ';' preserved.
    assert.equal(rewrite('grep -rn foo . ;', { gnuGrepProbe: gnu }), `grep ${EXCLUDE_FLAGS} -rn foo . ;`);
    // Repeated separators (';;') preserved when nothing rewrites (byte-identical ref).
    const empty = 'echo a;;echo b';
    assert.strictEqual(rewrite(empty, { gnuGrepProbe: gnu }), empty);
  });

  test('CRLF line endings are preserved as one separator', () => {
    const r = rewrite('grep -rn foo .\r\necho done', { gnuGrepProbe: gnu });
    assert.equal(r, `grep ${EXCLUDE_FLAGS} -rn foo .\r\necho done`);
  });

  test('tabs and multiple spaces between segments are preserved', () => {
    const r = rewrite('grep -rn foo .\t\t echo done', { gnuGrepProbe: gnu });
    assert.equal(r, `grep ${EXCLUDE_FLAGS} -rn foo .\t\t echo done`);
  });

  test('quoted $ and backtick inside a grep pattern do not split', () => {
    assert.equal(
      rewrite('grep -rn \'a$b`c\' .', { gnuGrepProbe: gnu }),
      `grep ${EXCLUDE_FLAGS} -rn 'a$b\`c' .`,
    );
  });

  test('grep with a pattern that starts with - after -- is preserved', () => {
    // `--` ends options; the following `-foo` is the pattern. Still recursive (-rn).
    const r = rewrite('grep -rn -- -foo .', { gnuGrepProbe: gnu });
    assert.equal(r, `grep ${EXCLUDE_FLAGS} -rn -- -foo .`);
  });

  test('many segments: each grep/find segment rewritten independently', () => {
    const r = rewrite('grep -rn a . ; find . -name \'*.ts\' ; echo done ; grep -rn b .', { gnuGrepProbe: gnu });
    assert.equal(r, `grep ${EXCLUDE_FLAGS} -rn a . ; find . \\( -name node_modules -o -name .git \\) -prune -o \\( -name \'*.ts\' \\) -print ; echo done ; grep ${EXCLUDE_FLAGS} -rn b .`);
  });

  test('command with only separators / whitespace returns the same reference', () => {
    for (const c of [';', '&&', '||', '|', '&', '\n', ';;', '   \n  ']) {
      assert.strictEqual(rewrite(c, { gnuGrepProbe: gnu }), c);
    }
  });
});

describe('warm-bash auto-prune: find correctness (real temp tree, GNU find)', () => {
  let rewrite: Rewrite;
  const BASH = findTestBash();
  let tmp: string;

  test.before(async () => {
    rewrite = await loadRewrite();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-bash-prune-'));
    // root/src/a.ts, root/other/c.ts, root/node_modules/pkg/b.ts, root/.git/config
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'other'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(tmp, 'other', 'c.ts'), 'export const c = 2;\n');
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'b.ts'), 'module.exports = 3;\n');
    fs.writeFileSync(path.join(tmp, '.git', 'config'), '[core]\n');
  });
  test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

  function runFind(cmd: string): { code: number | null; out: string } {
    const r = spawnSync(BASH, ['-c', cmd], { cwd: tmp, encoding: 'utf8', windowsHide: true });
    return { code: r.status, out: r.stdout ?? '' };
  }

  test('rewritten find excludes node_modules/.git and matches an explicit -path prune (byte-identical results)', () => {
    const rewritten = rewrite('find . -name \'*.ts\'', { gnuGrepProbe: gnu });
    // sanity: rewrite actually produced a prune expression
    assert.ok(rewritten.includes('-prune'), `expected prune in: ${rewritten}`);

    const mine = runFind(rewritten);
    const explicit = runFind("find . \\( -path '*/node_modules' -o -path '*/.git' \\) -prune -o -name '*.ts' -print");
    assert.equal(mine.code, 0, `mine exited ${mine.code}`);
    assert.equal(explicit.code, 0, `explicit exited ${explicit.code}`);

    const norm = (s: string) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).sort();
    assert.deepEqual(norm(mine.out), norm(explicit.out), 'rewritten find results must equal explicit-prune results');

    // node_modules must be pruned; src/other must be present.
    assert.ok(!mine.out.includes('node_modules'), `node_modules leaked: ${mine.out}`);
    assert.ok(mine.out.includes('src/a.ts') || mine.out.includes('src\\a.ts') || mine.out.includes(path.join('src', 'a.ts')));
    assert.ok(mine.out.includes('other/c.ts') || mine.out.includes(path.join('other', 'c.ts')));
  });
});

describe('warm-bash auto-prune: env-gate is an opts field (live-toggleable, same process)', () => {
  test('constructing twice with different autoPruneEnabled in one process threads the gate', async () => {
    const create = await loadOps();

    function capturingOps() {
      const commands: string[] = [];
      return {
        commands,
        ops: {
          exec: async (command: string) => { commands.push(command); return { exitCode: 0 as number | null }; },
        } as AnyOps,
      };
    }

    // A shell command (pipe) → no fast path; pool null → no warm; reaches the
    // fallback, where we capture the (possibly rewritten) command.
    const off = capturingOps();
    const opsOff = create({ pool: null, fastPathEnabled: false, autoPruneEnabled: false, gnuGrepProbe: gnu, fallbackOps: off.ops });
    await opsOff.exec('grep -rn foo . | head', process.cwd(), { onData: () => {} });
    assert.equal(off.commands[0], 'grep -rn foo . | head', 'autoPrune off → command unchanged');

    const on = capturingOps();
    const opsOn = create({ pool: null, fastPathEnabled: false, autoPruneEnabled: true, gnuGrepProbe: gnu, fallbackOps: on.ops });
    await opsOn.exec('grep -rn foo . | head', process.cwd(), { onData: () => {} });
    assert.notEqual(on.commands[0], 'grep -rn foo . | head', 'autoPrune on → command rewritten');
    assert.ok(on.commands[0]!.includes('--exclude-dir=node_modules'));
  });

  test('log callback receives the before/after payload on rewrite', async () => {
    const create = await loadOps();
    const logged: Record<string, unknown>[] = [];
    const fallback: AnyOps = { exec: async () => ({ exitCode: 0 as number | null }) };
    const ops = create({
      pool: null, fastPathEnabled: false, autoPruneEnabled: true, gnuGrepProbe: gnu,
      log: (p: Record<string, unknown>) => logged.push(p), fallbackOps: fallback,
    });
    await ops.exec('grep -rn foo . | head', process.cwd(), { onData: () => {} });
    assert.equal(logged.length, 1);
    assert.equal(logged[0]!.source, 'pie:warm-bash:auto-prune');
    assert.equal(logged[0]!.before, 'grep -rn foo . | head');
    assert.ok(String(logged[0]!.after).includes('--exclude-dir=node_modules'));

    // a non-rewriting command logs nothing
    await ops.exec('echo hi | cat', process.cwd(), { onData: () => {} });
    assert.equal(logged.length, 1);
  });
});

describe('warm-bash auto-prune: GNU-grep probe', () => {
  test('probeGnuGrep returns a boolean without throwing', async () => {
    const probe = await loadProbe();
    const r = probe(findTestBash());
    assert.equal(typeof r, 'boolean');
  });
});
