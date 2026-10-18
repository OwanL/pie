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