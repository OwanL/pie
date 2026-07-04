import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const classifierUrl = pathToFileURL(path.resolve(__dirname, '../src/classifier.ts')).href;

type Classification = Awaited<ReturnType<typeof import('../src/classifier.ts')['classify']>>;

async function load() {
  const m = (await import(classifierUrl)) as { classify: (c: string) => Classification };
  return m.classify;
}

function expectSimple(c: Classification, program: string, args: string[], cwd: string | null) {
  assert.equal(c.kind, 'simple', `expected simple, got ${c.kind}`);
  assert.equal(c.program, program);
  assert.deepEqual(c.args, args);
  assert.equal(c.cwd, cwd, `cwd mismatch: expected ${cwd}, got ${c.cwd}`);
}

function expectShell(c: Classification, cwd: string | null = null) {
  assert.equal(c.kind, 'shell', `expected shell`);
  assert.equal(c.cwd, cwd, `cwd mismatch: expected ${cwd}, got ${c.cwd}`);
}

describe('warm-bash classifier', () => {
  let classify: (c: string) => Classification;
  test.before(async () => {
    classify = await load();
  });

  test('simple commands fast-path', () => {
    expectSimple(classify('ls -la src'), 'ls', ['-la', 'src'], null);
    expectSimple(classify('rg -n foo extension/src'), 'rg', ['-n', 'foo', 'extension/src'], null);
    expectSimple(classify('git status'), 'git', ['status'], null);
    expectSimple(classify('npm run build'), 'npm', ['run', 'build'], null);
    expectSimple(classify('echo hello world'), 'echo', ['hello', 'world'], null);
    expectSimple(classify('cat README.md'), 'cat', ['README.md'], null);
  });

  test('quoted args stay one token (operators inside quotes do NOT route to shell)', () => {
    expectSimple(classify('git commit -m "foo && bar"'), 'git', ['commit', '-m', 'foo && bar'], null);
    expectSimple(classify('echo "a | b"'), 'echo', ['a | b'], null);
    expectSimple(classify('ls "my dir"'), 'ls', ['my dir'], null);
    expectSimple(classify('rg "x|y" file'), 'rg', ['x|y', 'file'], null);
  });

  test('cd <dir> && <simple> peels cwd and fast-paths the rest', () => {
    expectSimple(classify('cd extension && npm run build'), 'npm', ['run', 'build'], 'extension');
    expectSimple(classify('cd "c:/Users/x/pie" && rg -n foo'), 'rg', ['-n', 'foo'], 'c:/Users/x/pie');
    expectSimple(classify("cd '/tmp/a b' && ls"), 'ls', [], '/tmp/a b');
  });

  test('shell operators route to shell (with cwd peeled)', () => {
    expectShell(classify('cat README.md | head -20'), null);
    expectShell(classify('npm run build && npm test'), null);
    expectShell(classify('ls > out.txt'), null);
    expectShell(classify('cd x && npm run build && npm test'), 'x');
    expectShell(classify('cd x && echo "===" && rg -n foo'), 'x');
  });

  test('globs / tilde / vars / braces / env-assign route to shell', () => {
    expectShell(classify('ls *.ts'), null); // bare glob → shell globs
    expectShell(classify('echo $HOME'), null);
    expectShell(classify('ls ~/foo'), null);
    expectShell(classify('echo {a,b,c}'), null);
    expectShell(classify('FOO=bar cmd'), null);
  });

  test('quoted globs fast-path (quoted glob is literal — matches bash)', () => {
    expectSimple(classify('ls "*.ts"'), 'ls', ['*.ts'], null);
    expectSimple(classify('grep "$x" file'), 'grep', ['$x', 'file'], null);
  });

  test('heredocs route to shell', () => {
    expectShell(classify("python - <<'PY'\nprint(1)\nPY"), null);
    expectShell(classify('cat <<EOF\nhi\nEOF'), null);
  });

  test('shell builtins route to shell (no pointless execFile ENOENT)', () => {
    expectShell(classify('cd /tmp'), null);
    expectShell(classify('export FOO=bar'), null);
    expectShell(classify('source ~/init.sh'), null);
  });

  test('empty / whitespace route to shell', () => {
    expectShell(classify(''), null);
    expectShell(classify('   '), null);
  });

  test('backslash-escaped space routes to shell (tokenizer does not interpret escapes)', () => {
    expectShell(classify('ls my\\ dir'), null);
  });
});