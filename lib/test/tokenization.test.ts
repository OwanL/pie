import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { countTokens, tokenizerAvailable } = require('../tokenization.ts') as typeof import('../tokenization');
const { encode } = require('gpt-tokenizer/encoding/cl100k_base') as typeof import('gpt-tokenizer/encoding/cl100k_base');

function assertRealTokenizerAvailable(): void {
  assert.equal(tokenizerAvailable(), true, 'regression tests must exercise gpt-tokenizer, not the fallback');
}

function expectedLiteralTextTokens(text: string): number {
  return encode(text, { disallowedSpecial: new Set<string>() }).length;
}

test('countTokens preserves ordinary and empty text counts', () => {
  assertRealTokenizerAvailable();
  const ordinaryText = 'A regular sentence, with punctuation and numbers: 123.';
  assert.equal(countTokens(ordinaryText), expectedLiteralTextTokens(ordinaryText));
  assert.equal(countTokens(''), 0);
});

test('countTokens treats reserved token spellings in literal content as ordinary text', () => {
  assertRealTokenizerAvailable();
  const literalContents = [
    'Literal prompt marker: <|im_start|>',
    'Literal message terminator: <|im_end|>',
    'Literal end-of-text marker: <|endoftext|>',
    'Literal fill-in-the-middle prefix: <|fim_prefix|>',
  ];

  for (const text of literalContents) {
    assert.equal(countTokens(text), expectedLiteralTextTokens(text), `literal content: ${text}`);
  }
});
