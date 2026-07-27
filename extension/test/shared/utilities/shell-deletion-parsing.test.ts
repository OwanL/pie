import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { parseDeletedPathsFromCommand } from '../../../src/shared/shell-deletion-parsing';

// `parseDeletedPathsFromCommand` recovers literal file paths targeted by a
// deletion command embedded in a raw bash/shell command string. Globs are
// excluded (the real victims can't be known without listing the FS), index-only
// `git rm --cached` is ignored, and nested `bash -c "..."` shells are parsed
// recursively. Tilde and brace expansion are applied to each recovered path.

// ─── empty / invalid input ──────────────────────────────────────────────────

test('empty string yields no paths', () => {
  assert.deepEqual(parseDeletedPathsFromCommand(''), []);
});

test('whitespace-only string yields no paths', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('   \t\n  '), []);
});

test('non-string input hits the defensive guard (no crash)', () => {
  // The guard `typeof command !== 'string'` exists so a malformed bash tool
  // payload can't crash on `.trim()`. Removing it would throw here.
  assert.deepEqual(parseDeletedPathsFromCommand(undefined as unknown as string), []);
  assert.deepEqual(parseDeletedPathsFromCommand(null as unknown as string), []);
});

// ─── rm: basic args, flags, --, globs ────────────────────────────────────────

test('rm with multiple literal args returns them in order', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm a b'), ['a', 'b']);
});

test('rm flags are skipped but the following path is kept', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm -rf dir'), ['dir']);
  assert.deepEqual(parseDeletedPathsFromCommand('rm -f --recursive d'), ['d']);
});

test('rm -- ends flag parsing so a leading-dash file is kept', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm -- -file'), ['-file']);
  assert.deepEqual(parseDeletedPathsFromCommand('rm -rf -- -weird-name'), ['-weird-name']);
});

test('rm globs are excluded even after -- (real victims unknowable)', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm *.log'), []);
  assert.deepEqual(parseDeletedPathsFromCommand('rm a?b'), []);
  assert.deepEqual(parseDeletedPathsFromCommand('rm cache[0-9].dat'), []);
  assert.deepEqual(parseDeletedPathsFromCommand('rm -- *.log keep.txt'), ['keep.txt']);
});

// ─── brace expansion ─────────────────────────────────────────────────────────

test('brace expansion multiplies a token into one path per option', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm file{1,2}.ts'), ['file1.ts', 'file2.ts']);
});

test('brace expansion preserves prefix and suffix around the group', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm src/{a,b}/x.ts'), ['src/a/x.ts', 'src/b/x.ts']);
});

test('nested braces expand recursively, depth-first', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm {a,{b,c}}.ts'), ['a.ts', 'b.ts', 'c.ts']);
});

test('single-option brace is left literal (not expanded)', () => {
  // `{x}` has one option → code returns the token verbatim.
  assert.deepEqual(parseDeletedPathsFromCommand('rm {x}.ts'), ['{x}.ts']);
});

test('unbalanced brace is left literal', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm {a.ts'), ['{a.ts']);
});

// ─── tilde expansion ─────────────────────────────────────────────────────────

test('bare ~ expands to home dir', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm ~'), [os.homedir()]);
});

test('~/path expands against home dir (brace-then-tilde order)', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm ~/foo'), [path.join(os.homedir(), 'foo')]);
  assert.deepEqual(parseDeletedPathsFromCommand('rm ~/{a,b}'), [
    path.join(os.homedir(), 'a'),
    path.join(os.homedir(), 'b'),
  ]);
});

test('~user/path is left as-is (no passwd lookup)', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm ~bob/x'), ['~bob/x']);
});

// ─── other deletion commands ─────────────────────────────────────────────────

test('rmdir and unlink targets are recovered', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rmdir dir'), ['dir']);
  assert.deepEqual(parseDeletedPathsFromCommand('unlink f'), ['f']);
});

test('Windows del skips /flags and excludes globs', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('del file.txt'), ['file.txt']);
  assert.deepEqual(parseDeletedPathsFromCommand('del /Q file.txt'), ['file.txt']);
  assert.deepEqual(parseDeletedPathsFromCommand('del *.tmp'), []);
});

test('PowerShell Remove-Item / ri skip -flags', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('Remove-Item f'), ['f']);
  assert.deepEqual(parseDeletedPathsFromCommand('ri f'), ['f']);
  assert.deepEqual(parseDeletedPathsFromCommand('Remove-Item -Recurse d'), ['d']);
});

test('trash / trash-put / trash-cli targets are recovered', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('trash f'), ['f']);
  assert.deepEqual(parseDeletedPathsFromCommand('trash-put f'), ['f']);
  assert.deepEqual(parseDeletedPathsFromCommand('trash-cli f'), ['f']);
});

// ─── git rm ──────────────────────────────────────────────────────────────────

test('git rm without --cached is a working-tree deletion → recovered', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('git rm x'), ['x']);
  assert.deepEqual(parseDeletedPathsFromCommand('git rm -f file'), ['file']);
});

test('git rm --cached is index-only → ignored', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('git rm --cached x'), []);
  assert.deepEqual(parseDeletedPathsFromCommand('git rm -r --cached dir'), []);
});

test('git global flags (-C / --git-dir / --work-tree) and their values are skipped', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('git -C subdir rm x'), ['x']);
  assert.deepEqual(parseDeletedPathsFromCommand('git --git-dir /d/.git rm x'), ['x']);
  assert.deepEqual(parseDeletedPathsFromCommand('git --work-tree /wt rm x'), ['x']);
});

test('git non-rm subcommands yield nothing', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('git status'), []);
  assert.deepEqual(parseDeletedPathsFromCommand('git log -p'), []);
});

// ─── nested shells ───────────────────────────────────────────────────────────

test('bash -c "..." is parsed recursively', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('bash -c "rm nested"'), ['nested']);
  assert.deepEqual(parseDeletedPathsFromCommand('sh -c "rm a b"'), ['a', 'b']);
  assert.deepEqual(parseDeletedPathsFromCommand('zsh -c "rm z"'), ['z']);
});

test('flags between the shell name and -c are skipped before recursing', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('bash -e -c "rm withflag"'), ['withflag']);
});

test('nested shell with no deletion yields nothing', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('bash -c "echo hi"'), []);
});

// ─── command separators & prefixes ───────────────────────────────────────────

test('&& / ; / newline split into independent segments', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('cd d && rm f'), ['f']);
  assert.deepEqual(parseDeletedPathsFromCommand('echo hi; rm b'), ['b']);
  assert.deepEqual(parseDeletedPathsFromCommand('rm a\nrm b'), ['a', 'b']);
});

test('|| splits segments (distinct from a single pipe, which stops tokenization)', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm a || rm b'), ['a', 'b']);
});

test('a single pipe stops tokenization mid-segment (rm target captured, rest dropped)', () => {
  // `rm a | rm b`: single `|` is NOT a separator, so `rm b` lives in the same
  // segment and is dropped by the pipe-stop in the tokenizer — only `a` returns.
  assert.deepEqual(parseDeletedPathsFromCommand('rm a | rm b'), ['a']);
});

test('redirect operator stops tokenization even when attached to a file descriptor', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm a > out.txt'), ['a']);
  assert.deepEqual(parseDeletedPathsFromCommand('rm a 2>/dev/null'), ['a']);
  assert.deepEqual(parseDeletedPathsFromCommand('rm a>/dev/null'), ['a']);
});

test('sudo / env / FOO=bar prefixes are skipped to reach the command', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('sudo rm f'), ['f']);
  assert.deepEqual(parseDeletedPathsFromCommand('env rm f'), ['f']);
  assert.deepEqual(parseDeletedPathsFromCommand('FOO=bar rm f'), ['f']);
});

test('mixed segments across separators aggregate', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('git rm --cached x && rm y'), ['y']);
  assert.deepEqual(parseDeletedPathsFromCommand('rm a && git rm --cached b && rm c'), ['a', 'c']);
});

// ─── non-deletion commands & quoting ─────────────────────────────────────────

test('non-deletion commands yield nothing', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('echo hello'), []);
  assert.deepEqual(parseDeletedPathsFromCommand('ls -la'), []);
  assert.deepEqual(parseDeletedPathsFromCommand('cat file'), []);
});

test('quoted paths with spaces become a single token', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm "my file"'), ['my file']);
  assert.deepEqual(parseDeletedPathsFromCommand("rm 'my file'"), ['my file']);
});

test('backslash escape keeps a space inside a single token', () => {
  assert.deepEqual(parseDeletedPathsFromCommand('rm my\\ file'), ['my file']);
});
