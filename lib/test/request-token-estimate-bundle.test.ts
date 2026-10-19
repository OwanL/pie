import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Same loading convention as lib/test/tokenization.test.ts: the owner source
// is required through createRequire so plain tsx/node:test runs resolve it.
const require = createRequire(import.meta.url);
const { encode: cl100kEncode } = require('gpt-tokenizer/encoding/cl100k_base') as typeof import('gpt-tokenizer/encoding/cl100k_base');
const { encode: o200kEncode } = require('gpt-tokenizer/encoding/o200k_base');
const { build } = require('esbuild') as typeof import('esbuild');

const literalOptions = { disallowedSpecial: new Set<string>() };
const cl100kTokens = (text: string) => (text ? cl100kEncode(text, literalOptions).length : 0);
const o200kTokens = (text: string) => (text ? o200kEncode(text, literalOptions).length : 0);

const modern = { id: 'gpt-6-astra', provider: 'openai-codex', api: 'openai-codex-responses' };

// Frozen holdout copied from the recorded delivery probe fixtures; no expected
// counts or estimator serialization constructs it.
const obj = (properties: Record<string, unknown> = {}, required: string[] = [], extra = {}) => ({ type: 'object', properties, required, ...extra });
const str = (description: string) => ({ type: 'string', description });
const holdoutParameters = obj({ jobs: { type: 'array', description: 'Ordered processing jobs.', items: obj({ operation: { type: 'string', description: 'Operation.', enum: ['insert', 'delete', 'replace'] }, target: obj({ path: str('Relative path.'), recursive: { type: 'boolean', description: 'Include descendants.' } }, ['path'], { additionalProperties: false }) }, ['operation', 'target'], { additionalProperties: false }) }, dry_run: { type: 'boolean', description: 'Preview without writing.' } }, ['jobs'], { additionalProperties: false });

test('relocated bundle without checkout node_modules ancestry keeps exact o200k and cl100k literal counts', async () => {
  // The delivered host bundles this module and executes it relocated. A
  // dynamic runtime require of gpt-tokenizer silently falls back there (no
  // node_modules between the bundle and the filesystem root), so the bundle
  // must inline both encodings through explicit static imports.
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const temp = await mkdtemp(path.join(os.tmpdir(), 'pie-token-estimate-bundle-'));
  try {
    const output = path.join(temp, 'estimate.cjs');
    await build({
      stdin: { contents: `export { estimateRequestPrefixTokens, estimateToolDefinitionsTokens } from './lib/request-token-estimate';`, resolveDir: repositoryRoot, loader: 'ts' },
      outfile: output, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    });
    // No runtime resolution seam may remain: a dynamic require would leave
    // `require("gpt-tokenizer/...")` spelled in the bundle and fail silently
    // when relocated, while bundled imports inline the BPE data itself.
    const bundledSource = await readFile(output, 'utf8');
    assert.ok(!/(?:require|import)\((?:"|')gpt-tokenizer/.test(bundledSource), 'bundled output must inline both tokenizers instead of requiring gpt-tokenizer at runtime');

    const bundled = require(output) as typeof import('../request-token-estimate');
    const multilingual = '  日本語 中文 한국어 😀 <|im_end|>\n  ';
    assert.equal(bundled.estimateRequestPrefixTokens(multilingual, [], modern), o200kTokens(multilingual));
    assert.equal(
      bundled.estimateToolDefinitionsTokens([{ name: 'synthetic_inspect', description: 'Inspect synthetic data.', parameters: holdoutParameters }], modern),
      70 + 12,
    );
    assert.equal(bundled.estimateToolDefinitionsTokens([{ name: 'synthetic_inspect', description: 'Inspect synthetic data.', parameters: obj() }], modern), 17 + 12);
    // Unknown models keep the compact-JSON/cl100k basis; whitespace around the
    // prompt remains ordinary literal content with no trim anywhere in the path.
    const padded = `  \nYou are a coding assistant.\n\n  `;
    assert.equal(bundled.estimateRequestPrefixTokens(padded, []), cl100kTokens(padded));
    assert.equal(bundled.estimateRequestPrefixTokens(multilingual, []), cl100kTokens(multilingual));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});