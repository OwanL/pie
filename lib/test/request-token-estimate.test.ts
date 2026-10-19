import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

// Same loading convention as lib/test/tokenization.test.ts: the owner source
// is required through createRequire so plain tsx/node:test runs resolve it.
const require = createRequire(import.meta.url);
const {
  estimateRequestPrefixTokens,
  estimateToolDefinitionsTokens,
} = require('../request-token-estimate.ts') as typeof import('../request-token-estimate');
const {
  tokenizerAvailable,
} = require('../tokenization.ts') as typeof import('../tokenization');
const { encode } = require('gpt-tokenizer/encoding/cl100k_base') as typeof import('gpt-tokenizer/encoding/cl100k_base');

const modern = { id: 'gpt-6-astra', provider: 'openai-codex', api: 'openai-codex-responses' };
const { encode: modernEncode } = require('gpt-tokenizer/encoding/o200k_base') as typeof import('gpt-tokenizer/encoding/o200k_base');
const modernTokens = (text: string) => modernEncode(text, { disallowedSpecial: new Set<string>() }).length;

test('model-aware literal text preserves whitespace and reserved spellings', () => {
  const text = '  日本語 中文 한국어 😀 <|im_end|>\n  ';
  for (const id of ['gpt-4o', 'gpt-4.1-mini', 'gpt-5', 'gpt-6-astra', 'o1', 'o3-mini', 'o4-mini']) {
    assert.equal(estimateRequestPrefixTokens(text, [], { ...modern, id }), modernTokens(text));
  }
  for (const provider of ['openai', 'openai-codex', 'github-copilot']) {
    for (const api of ['openai-completions', 'openai-responses', 'openai-codex-responses']) {
      assert.equal(estimateRequestPrefixTokens(text, [], { ...modern, provider, api }), modernTokens(text));
    }
  }
  for (const model of [undefined, { ...modern, api: 'anthropic-messages' }, { ...modern, id: 'claude-sonnet-4', provider: 'github-copilot' }, { ...modern, provider: 'other' }, { ...modern, id: 'gpt-4' }]) {
    assert.equal(estimateRequestPrefixTokens(text, [], model), literalTokens(text));
  }
});

const obj = (properties: Record<string, unknown> = {}, required: string[] = [], extra = {}) => ({ type: 'object', properties, required, ...extra });
const str = (description: string) => ({ type: 'string', description });
test('recorded provider holdout removal delta 86 versus unindented structural estimate 70 plus 12-token tools-block overhead', () => {
  const parameters = obj({ jobs: { type: 'array', description: 'Ordered processing jobs.', items: obj({ operation: { type: 'string', description: 'Operation.', enum: ['insert', 'delete', 'replace'] }, target: obj({ path: str('Relative path.'), recursive: { type: 'boolean', description: 'Include descendants.' } }, ['path'], { additionalProperties: false }) }, ['operation', 'target'], { additionalProperties: false }) }, dry_run: { type: 'boolean', description: 'Preview without writing.' } }, ['jobs'], { additionalProperties: false });
  assert.equal(estimateToolDefinitionsTokens([{ name: 'synthetic_inspect', description: 'Inspect synthetic data.', parameters }], modern), 70 + 12);
  assert.equal(estimateToolDefinitionsTokens([{ name: 'synthetic_inspect', description: 'Inspect synthetic data.', parameters: obj() }], modern), 17 + 12);
});

test('supported annotations render as compact comments before the annotated member line', () => {
  // Frozen ask_user-shaped copy: bounds/default values are rendered, never
  // silently dropped; key-colon comment lines keep the estimate close to
  // the provider's structural rendering (recorded live-probe accuracy).
  const parameters = obj({
    question: { type: 'string', minLength: 3, maxLength: 40, description: 'The question to present to the user.' },
    ratio: { type: 'number', minimum: 0.25, maximum: 4 },
    options: { type: 'array', minItems: 0, maxItems: 6, description: 'Preset answers.', items: str('A suggested short answer (~1–6 words).') },
    mode: { type: 'boolean', default: true, description: 'Whether custom replies are allowed.' },
  }, ['question', 'options'], { additionalProperties: false });
  const declaration = '// \ntype ask_user = (_: {\n'
    + '// The question to present to the user.\n// minLength: 3, maxLength: 40\nquestion: string,\n'
    + '// minimum: 0.25, maximum: 4\nratio?: number,\n'
    + '// Preset answers.\n// minItems: 0, maxItems: 6\noptions: Array<\n// A suggested short answer (~1–6 words).\nstring>,\n'
    + '// Whether custom replies are allowed.\n// default: true\nmode?: boolean,\n'
    + '}) => any;';
  assert.equal(estimateToolDefinitionsTokens([{ name: 'ask_user', description: '', parameters }], modern), modernTokens(declaration) + 12);
});

test('array item descriptions render before the nested item type and root descriptions render at the head', () => {
  const nestedItems = obj({
    tags: { type: 'array', description: 'Outer record tags.', items: { type: 'array', items: { type: 'number', description: 'Weighted value.' } } },
  }, [], { additionalProperties: false });
  const declaration = '// \ntype nested = (_: {\n// Outer record tags.\ntags?: Array<Array<\n// Weighted value.\nnumber>>,\n}) => any;';
  assert.equal(estimateToolDefinitionsTokens([{ name: 'nested', description: '', parameters: nestedItems }], modern), modernTokens(declaration) + 12);
  const rooted = { type: 'object', description: 'Root schema description.', properties: { x: { type: 'string' } }, additionalProperties: false } as const;
  const rootDeclaration = '// \ntype rooted = (_: // Root schema description.\n{\nx?: string,\n}) => any;';
  assert.equal(estimateToolDefinitionsTokens([{ name: 'rooted', description: '', parameters: rooted }], modern), modernTokens(rootDeclaration) + 12);
});

test('invalid annotation values use compact fallback instead of rendering', () => {
  for (const parameters of [{ type: 'string', minLength: -1 }, { type: 'number', maximum: NaN }, { type: 'string', default: { nested: undefined } }, { type: 'string', minItems: 2 }, { type: 'string', minimum: 'low' }]) {
    const tools = [{ name: 'test', parameters }];
    assert.equal(estimateToolDefinitionsTokens(tools, modern), modernTokens(JSON.stringify(tools)) + 12);
  }
});

test('recognized-model tool-block overhead counts once per request, never per tool; empty and non-modern stay unchanged', () => {
  const first = { name: 'first', description: 'First tool.', parameters: obj({ x: { type: 'string' } }) };
  const second = { name: 'second', description: 'Second tool.', parameters: obj({ y: { type: 'integer' } }) };
  const singleFirst = estimateToolDefinitionsTokens([first], modern);
  const singleSecond = estimateToolDefinitionsTokens([second], modern);
  assert.equal(estimateToolDefinitionsTokens([first, second], modern), (singleFirst - 12) + (singleSecond - 12) + 12,
    'per-tool declaration costs sum once plus one 12-token block');
  assert.equal(estimateToolDefinitionsTokens([], modern), 0);
  // Compact-JSON basis keeps no framing overhead: non-modern estimates are
  // unaffected on the tools side.
  const prompt = 'Prompt';
  assert.equal(estimateRequestPrefixTokens(prompt, [first]), literalTokens(prompt) + literalTokens(JSON.stringify([{ name: 'first', description: 'First tool.', parameters: first.parameters }])));
});

test('unsupported or malformed schemas use compact fallback; cycles never crash', () => {
  for (const parameters of [true, null, { type: 'string', minLength: -1 }, { anyOf: [{ type: 'string' }] }, { $ref: '#/x' }, obj({ x: { type: 'array' } }), obj({}, ['missing']), { type: 'object', properties: [] }, obj({ x: { type: 'string', pattern: 'a+' } }), obj({}, [], { additionalProperties: true }), { type: ['string', 'null'] }, { type: 'string', enum: [3] }, { type: 'string', minimum: 'low' }, { type: 'array', minItems: -1, items: str('x') }]) {
    const tools = [{ name: 'test', description: 'Test.', parameters }];
    assert.equal(estimateToolDefinitionsTokens(tools, modern), modernTokens(JSON.stringify(tools)) + 12);
  }
  const cyclic: Record<string, unknown> = { type: 'object' }; cyclic.properties = { cycle: cyclic };
  assert.doesNotThrow(() => estimateToolDefinitionsTokens([{ name: 'test', parameters: cyclic }], modern));
});

test('unsupported tool preserves its whole schema without resetting supported neighbors', () => {
  const supported = { name: 'read', parameters: obj({ path: { type: 'string' } }) };
  const unsupported = { name: 'ask_user', parameters: obj({ questions: { type: 'array', minItems: 1, pattern: 'a+' } }) };
  const fallback = modernTokens(JSON.stringify([unsupported]));
  assert.notEqual(fallback, literalTokens(JSON.stringify([unsupported])));
  // One 12-token tools-block overhead for the whole request, never per tool.
  const supportedSingle = estimateToolDefinitionsTokens([supported], modern) - 12;
  assert.equal(estimateToolDefinitionsTokens([supported, unsupported, supported], modern), 2 * supportedSingle + fallback + 12);
});

test('nested descriptions preserve newlines and unusual names are quoted', () => {
  const tools = [{ name: 'odd-name', description: 'one\ntwo', parameters: obj({ 'a-b': str('first\nsecond <|im_end|>') }) }];
  const declaration = '// one\n// two\ntype "odd-name" = (_: {\n// first\n// second <|im_end|>\n"a-b"?: string,\n}) => any;';
  assert.equal(estimateToolDefinitionsTokens(tools, modern), modernTokens(declaration) + 12);
  const escaped = [{ name: 'quoted"name', parameters: obj({ 'a"b': { type: 'string', enum: ['a"b', 'a\\b'] } }) }];
  const escapedDeclaration = '// \ntype ' + JSON.stringify(escaped[0].name) + ' = (_: {\n' + JSON.stringify('a"b') + '?: ' + ['a"b', 'a\\b'].map(value => JSON.stringify(value)).join(' | ') + ',\n}) => any;';
  assert.equal(estimateToolDefinitionsTokens(escaped, modern), modernTokens(escapedDeclaration) + 12);
});

type RequestEstimateTool = import('../request-token-estimate').RequestEstimateTool;

function assertRealTokenizerAvailable(): void {
  assert.equal(tokenizerAvailable(), true, 'regression tests must exercise gpt-tokenizer, not the fallback');
}

/** Literal cl100k count of ordinary content, matching the shared tokenizer basis. */
function literalTokens(text: string): number {
  return text ? encode(text, { disallowedSpecial: new Set<string>() }).length : 0;
}

const readParameters = {
  type: 'object',
  required: ['path'],
  properties: { path: { type: 'string', description: 'Absolute file path' } },
};

function buildProviderToolFixture(): RequestEstimateTool[] {
  return [
    {
      name: 'read',
      description: 'Read a file.',
      // Non-request bookkeeping fields (snippets, guidelines, source info) ride
      // along on SDK tool objects but are not part of the provider payload.
      promptSnippet: 'Read file contents',
      promptGuidelines: ['Use read instead of shell cat.'],
      parameters: readParameters,
    },
    {
      name: 'bash',
      description: 'Run a shell command.',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  ];
}

test('tool definitions serialize the actual name/description/parameters as one compact JSON array', () => {
  assertRealTokenizerAvailable();
  const tools = buildProviderToolFixture();
  const expected = literalTokens(JSON.stringify([
    { name: 'read', description: 'Read a file.', parameters: readParameters },
    { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  ]));
  assert.equal(estimateToolDefinitionsTokens(tools), expected);
});

test('definitions count compact JSON, not Markdown catalogs or pretty-printed whitespace', () => {
  assertRealTokenizerAvailable();
  const tools = buildProviderToolFixture();
  const compact = estimateToolDefinitionsTokens(tools);
  const pretty = literalTokens(JSON.stringify([
    { name: 'read', description: 'Read a file.', parameters: readParameters },
    { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
  ], null, 2));
  const markdownCatalog = tools.map((tool) => {
    let entry = `## ${tool.name}\n\n${tool.description || '(no description)'}`;
    if (tool.parameters !== undefined) {
      entry += `\n\n**Parameters:**\n\`\`\`json\n${JSON.stringify(tool.parameters, null, 2)}\n\`\`\``;
    }
    return entry;
  }).join('\n\n---\n\n');
  assert.ok(compact < pretty, 'compact JSON must count less than pretty-printed definitions');
  assert.ok(compact < literalTokens(markdownCatalog), 'compact JSON must count less than a Markdown tool catalog');
});

test('definition numbering is deterministic and independent of caller key order and extra fields', () => {
  assertRealTokenizerAvailable();
  const orderedFields = buildProviderToolFixture()[0];
  const shuffledFields = {
    promptGuidelines: orderedFields.promptGuidelines,
    parameters: orderedFields.parameters,
    promptSnippet: orderedFields.promptSnippet,
    description: orderedFields.description,
    name: orderedFields.name,
  };
  assert.equal(estimateToolDefinitionsTokens([orderedFields]), estimateToolDefinitionsTokens([shuffledFields]));
  // Repeated calls on identical input produce the identical total.
  assert.equal(estimateToolDefinitionsTokens([orderedFields]), estimateToolDefinitionsTokens([orderedFields]));
});

test('legacy legacy-free and explicit-undefined optional schema fields serialize name-only', () => {
  assertRealTokenizerAvailable();
  const legacyNameOnly = { name: 'hidden_inventory' };
  const explicitUndefined = { name: 't', description: undefined, parameters: undefined };
  assert.equal(estimateToolDefinitionsTokens([legacyNameOnly]), literalTokens('[{"name":"hidden_inventory"}]'));
  assert.equal(estimateToolDefinitionsTokens([explicitUndefined]), literalTokens('[{"name":"t"}]'));
  // An empty-string description is actual provider content and stays in the payload.
  assert.equal(estimateToolDefinitionsTokens([{ name: 't', description: '' }]), literalTokens('[{"name":"t","description":""}]'));
});

test('empty tool arrays count zero while an empty prompt alone counts zero', () => {
  assertRealTokenizerAvailable();
  assert.equal(estimateToolDefinitionsTokens([]), 0);
  assert.equal(estimateRequestPrefixTokens('', []), 0);
  // Tools alone still count without prompt text.
  assert.equal(estimateRequestPrefixTokens('', [{ name: 'read' }]), estimateToolDefinitionsTokens([{ name: 'read' }]));
});

test('prompt whitespace is preserved rather than trimmed like estimateTextTokens', () => {
  assertRealTokenizerAvailable();
  const trimmed = 'You are a coding assistant.';
  const padded = `  \n${trimmed}\n\n  `;
  assert.equal(estimateRequestPrefixTokens(padded, []), literalTokens(padded));
  assert.ok(
    estimateRequestPrefixTokens(padded, []) > estimateRequestPrefixTokens(trimmed, []),
    'whitespace surrounding the prompt must contribute tokens on this basis',
  );
});

test('reserved spellings in prompts and schemas count as ordinary literal text', () => {
  assertRealTokenizerAvailable();
  for (const reserved of ['<|im_end|>', '<|fim_prefix|>', '   ']) {
    const tools: RequestEstimateTool[] = [{
      name: 'bash',
      description: `Terminator literal: ${reserved}`,
      parameters: { type: 'object', properties: { raw: { type: 'string', description: `marker ${reserved}` } } },
    }];
    const prompt = `System prompt with a literal ${reserved} marker.`;
    assert.equal(estimateRequestPrefixTokens(prompt, tools), literalTokens(JSON.stringify([
      { name: 'bash', description: `Terminator literal: ${reserved}`, parameters: tools[0].parameters },
    ])) + literalTokens(prompt));
  }
});

test('estimation never mutates its inputs and tolerates frozen readonly tools', () => {
  assertRealTokenizerAvailable();
  const prompt = 'System prompt with double  whitespace and tabs:\t\tpath.';
  const tools = buildProviderToolFixture();
  const snapshot = structuredClone(tools);
  estimateRequestPrefixTokens(prompt, tools);
  estimateToolDefinitionsTokens(tools);
  assert.deepEqual(tools, snapshot);
  // Both the array and each definition may be frozen readonly inputs.
  const frozen = Object.freeze(buildProviderToolFixture().map((tool) => Object.freeze({ ...tool })));
  assert.ok(estimateToolDefinitionsTokens(frozen) > 0);
  assert.equal(estimateRequestPrefixTokens(prompt, frozen), literalTokens(prompt) + estimateToolDefinitionsTokens(frozen));
});

test('request-prefix totals sum prompt and definitions on one shared literal basis', () => {
  assertRealTokenizerAvailable();
  const prompt = 'You are a coding assistant operating inside Pie.';
  const tools = buildProviderToolFixture();
  assert.equal(
    estimateRequestPrefixTokens(prompt, tools),
    literalTokens(prompt) + estimateToolDefinitionsTokens(tools),
    'the whole total and its parts must be counted on the same tokenizer basis',
  );
});