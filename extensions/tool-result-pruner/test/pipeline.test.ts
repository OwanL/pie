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
type Config = { enabled: boolean; profile: string };
type Patch = { content?: ToolContent[]; details?: unknown; isError?: boolean };
type PruningMeta = { rules: string[]; beforeText: string; afterText: string };
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

const ENABLED: Config = { enabled: true, profile: 'default' };

describe('pipeline guards', () => {
  let runPipeline: PipelineModule['runPipeline'];
  test.before(async () => {
    const mod = (await import(pipelineUrl)) as PipelineModule;
    runPipeline = mod.runPipeline;
  });

  test('disabled config → no-op', () => {
    const out = runPipeline(ev({ content: [{ type: 'text', text: '\u001B[31ma\u001B[0m' }] }), { enabled: false, profile: 'default' });
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