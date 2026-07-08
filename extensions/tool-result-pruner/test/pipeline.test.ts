import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pipelineUrl = pathToFileURL(path.resolve(__dirname, '../pipeline.ts')).href;

type ToolContent = { type: 'text'; text: string } | { type: 'image'; [k: string]: unknown };
type Event = {
  type: 'tool_result';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  content: ToolContent[];
  isError: boolean;
  details: unknown;
};
type Config = { enabled: boolean; profile: string; rules: { ansi: boolean; whitespace: boolean; blankRun: boolean; jsonMinify: boolean; lsLong: boolean; gitLog: boolean; grepGroup: boolean }; tools?: string[] | null };
type Patch = { content?: ToolContent[]; details?: unknown; isError?: boolean };
type PruningMeta = { rules: string[]; beforeText: string; afterText: string; losslessText: string; markers: string[]; recallRules: string[] };
type PipelineResult = { patch: Patch; meta: PruningMeta } | null;
type PipelineModule = { runPipeline: (event: Event, config: Config) => PipelineResult };

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

const ENABLED: Config = { enabled: true, profile: 'default', rules: { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true, grepGroup: true }, tools: null };

describe('pipeline guards', () => {
  let runPipeline: PipelineModule['runPipeline'];
  test.before(async () => {
    const mod = (await import(pipelineUrl)) as PipelineModule;
    runPipeline = mod.runPipeline;
  });

  test('disabled config → no-op', () => {
    const out = runPipeline(ev({ content: [{ type: 'text', text: '\u001B[31ma\u001B[0m' }] }), { enabled: false, profile: 'default', rules: { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true, grepGroup: true }, tools: null });
    assert.equal(out, null);
  });

  test('error results pass through unfiltered', () => {
    const text = '\u001B[31mboom\u001B[0m\n\n\n\nnoise';
    const out = runPipeline(ev({ isError: true, content: [{ type: 'text', text }] }), ENABLED);
    assert.equal(out, null);
  });

  test('read results skip the whole pipeline', () => {
    // minify-JSON would otherwise fire here; the read guard must prevent it.
    const pretty = '{\n  "a": 1\n}';
    const out = runPipeline(ev({ toolName: 'read', content: [{ type: 'text', text: pretty }] }), ENABLED);
    assert.equal(out, null);
  });

  test('read results skip even when explicitly in the tools allowlist (hard safety)', () => {
    const pretty = '{\n  "a": 1\n}';
    const out = runPipeline(ev({ toolName: 'read', content: [{ type: 'text', text: pretty }] }), { ...ENABLED, tools: ['read', 'bash'] });
    assert.equal(out, null);
  });

  test('a non-null tools allowlist prunes only listed tools', () => {
    // bash is listed → pruned (ansi-strip fires).
    const bashOut = runPipeline(ev({ toolName: 'bash', content: [{ type: 'text', text: '\u001B[31ma\u001B[0m' }] }), { ...ENABLED, tools: ['bash'] });
    assert.deepEqual(bashOut?.patch.content, [{ type: 'text', text: 'a' }]);
    // ls is NOT listed → skipped entirely.
    const lsOut = runPipeline(ev({ toolName: 'ls', content: [{ type: 'text', text: '\u001B[31ma\u001B[0m' }] }), { ...ENABLED, tools: ['bash'] });
    assert.equal(lsOut, null);
  });

  test('an empty tools allowlist prunes nothing', () => {
    const out = runPipeline(ev({ toolName: 'bash', content: [{ type: 'text', text: '\u001B[31ma\u001B[0m' }] }), { ...ENABLED, tools: [] });
    assert.equal(out, null);
  });

  test('multi-part content is left untouched', () => {
    const out = runPipeline(ev({ content: [{ type: 'text', text: '\u001B[31ma\u001B[0m' }, { type: 'text', text: 'b' }] }), ENABLED);
    assert.equal(out, null);
  });

  test('image content is left untouched', () => {
    const out = runPipeline(ev({ content: [{ type: 'image', data: 'x' }] }), ENABLED);
    assert.equal(out, null);
  });

  test('empty text → no-op', () => {
    const out = runPipeline(ev({ content: [{ type: 'text', text: '' }] }), ENABLED);
    assert.equal(out, null);
  });
});

describe('pipeline composition', () => {
  let runPipeline: PipelineModule['runPipeline'];
  test.before(async () => {
    const mod = (await import(pipelineUrl)) as PipelineModule;
    runPipeline = mod.runPipeline;
  });

  test('lossless rules compose: ANSI + trailing ws + blank collapse', () => {
    const text = '\u001B[32mok\u001B[0m   \n\n\n\n\nafter';
    const out = runPipeline(ev({ content: [{ type: 'text', text }] }), ENABLED);
    assert.deepEqual(out?.patch.content, [{ type: 'text', text: 'ok\n\nafter' }]);
  });

  test('JSON minify fires end-to-end', () => {
    const pretty = '{\n  "a": 1,\n  "b": 2\n}';
    const out = runPipeline(ev({ content: [{ type: 'text', text: pretty }] }), ENABLED);
    assert.deepEqual(out?.patch.content, [{ type: 'text', text: '{"a":1,"b":2}' }]);
  });

  test('already-lean output → no-op (no patch returned)', () => {
    const out = runPipeline(ev({ content: [{ type: 'text', text: 'a\nb' }] }), ENABLED);
    assert.equal(out, null);
  });

  test('patch carries only content (no details/isError) for lossless changes', () => {
    const out = runPipeline(ev({ content: [{ type: 'text', text: '\u001B[31ma\u001B[0m' }] }), ENABLED);
    assert.ok(out);
    assert.equal('details' in out.patch, false);
    assert.equal('isError' in out.patch, false);
  });
});

describe('pipeline rule toggles', () => {
  let runPipeline: PipelineModule['runPipeline'];
  test.before(async () => {
    const mod = (await import(pipelineUrl)) as PipelineModule;
    runPipeline = mod.runPipeline;
  });

  test('a disabled rule is skipped entirely (never fires)', () => {
    // ANSI + trailing ws: with ansi disabled, only trim-trailing-whitespace fires.
    const cfg: Config = { enabled: true, profile: 'default', rules: { ansi: false, whitespace: true, blankRun: true, jsonMinify: true, lsLong: false, gitLog: false, grepGroup: false } };
    const out = runPipeline(ev({ content: [{ type: 'text', text: '\u001B[31ma\u001B[0m   ' }] }), cfg);
    assert.ok(out);
    // ANSI escapes are preserved (ansi-strip skipped); trailing ws stripped.
    assert.deepEqual(out?.patch.content, [{ type: 'text', text: '\u001B[31ma\u001B[0m' }]);
    assert.deepEqual(out?.meta.rules, ['trim-trailing-whitespace']);
  });

  test('an enabled rule fires normally', () => {
    const cfg: Config = { enabled: true, profile: 'default', rules: { ansi: true, whitespace: false, blankRun: true, jsonMinify: true, lsLong: false, gitLog: false, grepGroup: false } };
    const out = runPipeline(ev({ content: [{ type: 'text', text: '\u001B[31ma\u001B[0m   ' }] }), cfg);
    assert.ok(out);
    // Only ansi-strip fires (whitespace disabled); trailing ws preserved.
    assert.deepEqual(out?.patch.content, [{ type: 'text', text: 'a   ' }]);
    assert.deepEqual(out?.meta.rules, ['ansi-strip']);
  });

  test('disabling json minify keeps pretty JSON intact', () => {
    const cfg: Config = { enabled: true, profile: 'default', rules: { ansi: true, whitespace: true, blankRun: true, jsonMinify: false, lsLong: false, gitLog: false, grepGroup: false } };
    const pretty = '{\n  "a": 1\n}';
    const out = runPipeline(ev({ content: [{ type: 'text', text: pretty }] }), cfg);
    assert.equal(out, null);
  });
});

describe('pipeline metadata (analytics)', () => {
  let runPipeline: PipelineModule['runPipeline'];
  test.before(async () => {
    const mod = (await import(pipelineUrl)) as PipelineModule;
    runPipeline = mod.runPipeline;
  });

  test('meta.rules lists only the rules that fired, in order', () => {
    // ANSI strip + trailing-ws fire; blank-collapse and minify do not.
    const out = runPipeline(ev({ content: [{ type: 'text', text: '\u001B[31ma\u001B[0m   ' }] }), ENABLED);
    assert.deepEqual(out?.meta.rules, ['ansi-strip', 'trim-trailing-whitespace']);
  });

  test('meta.beforeText is the pre-pruning text, meta.afterText the result', () => {
    const text = '\u001B[31mhi\u001B[0m';
    const out = runPipeline(ev({ content: [{ type: 'text', text }] }), ENABLED);
    assert.equal(out?.meta.beforeText, text);
    assert.equal(out?.meta.afterText, 'hi');
  });

  test('no meta when nothing changed (null result)', () => {
    const out = runPipeline(ev({ content: [{ type: 'text', text: 'lean' }] }), ENABLED);
    assert.equal(out, null);
  });
});

const LS_L = `total 24\ndrwxr-xr-x  2 user group 4096 Jul  6 12:34 src\n-rw-r--r--  1 user group  123 Jul  6 12:34 readme.md\n`;
const GIT_LOG = `commit a1b2c3d4e5f6789012345678901234567890abcd (HEAD -> main)\nAuthor: X <x@x>\nDate:   Fri Jul 4 12:00:00 2025\n\n    Fix the widget\n`;

describe('pipeline lossy tier', () => {
  let runPipeline: PipelineModule['runPipeline'];
  test.before(async () => {
    const mod = (await import(pipelineUrl)) as PipelineModule;
    runPipeline = mod.runPipeline;
  });

  test('ls -l fires under default profile and yields names-only', () => {
    const out = runPipeline(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: LS_L }] }), ENABLED);
    assert.ok(out);
    assert.deepEqual(out?.meta.recallRules, ['ls-long']);
    assert.deepEqual(out?.meta.markers, ['2 entries → names only']);
    // patch.content is the lossy text WITHOUT the fidelity marker (index.ts
    // prepends the marker after the stash write, since it carries the raw path).
    const lossyText = (out?.patch.content?.[0] as { text: string } | undefined)?.text;
    assert.equal(lossyText, 'src/\nreadme.md\n');
    assert.equal(out?.meta.afterText, 'src/\nreadme.md\n');
  });

  test('git log fires under default profile and yields oneline', () => {
    const out = runPipeline(ev({ input: { command: 'git log' }, content: [{ type: 'text', text: GIT_LOG }] }), ENABLED);
    assert.ok(out);
    assert.deepEqual(out?.meta.recallRules, ['git-log']);
    assert.equal(out?.meta.afterText, 'a1b2c3d Fix the widget (HEAD -> main)\n');
  });

  test('lossy rules do NOT fire under the security profile (lossless still runs)', () => {
    const sec: Config = { enabled: true, profile: 'security', rules: { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: true, gitLog: true, grepGroup: true }, tools: null };
    const out = runPipeline(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: LS_L }] }), sec);
    // LS_L has no lossless-opportunity (no ANSI/extra ws/blank-run/JSON), so
    // under security (lossy off) nothing fires → null.
    assert.equal(out, null);
  });

  test('a disabled lossy rule does not fire (toggle gate)', () => {
    const cfg: Config = { enabled: true, profile: 'default', rules: { ansi: true, whitespace: true, blankRun: true, jsonMinify: true, lsLong: false, gitLog: false, grepGroup: false } };
    const out = runPipeline(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: LS_L }] }), cfg);
    assert.equal(out, null);
  });

  test('lossless runs before lossy: ANSI stripped, then ls-long parses clean bytes', () => {
    const colored = '\u001B[31m' + LS_L + '\u001B[0m';
    const out = runPipeline(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: colored }] }), ENABLED);
    assert.ok(out);
    assert.deepEqual(out?.meta.rules, ['ansi-strip', 'ls-long']);
    assert.equal(out?.meta.afterText, 'src/\nreadme.md\n');
    // losslessText is the ANSI-stripped but still -l-shaped intermediate.
    assert.equal(out?.meta.losslessText, LS_L);
  });

  test('meta.losslessText holds the lossless-only result (fallback target)', () => {
    const out = runPipeline(ev({ input: { command: 'ls -l' }, content: [{ type: 'text', text: LS_L }] }), ENABLED);
    assert.ok(out);
    assert.equal(out?.meta.losslessText, LS_L);
    assert.deepEqual(out?.meta.rules.includes('ls-long'), true);
  });
});