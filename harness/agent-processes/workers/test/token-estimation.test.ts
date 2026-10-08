import assert from 'node:assert/strict';
import test from 'node:test';
import { countTokens, encode } from 'gpt-tokenizer/encoding/cl100k_base';

import { estimateTextTokens } from '../../../../lib/token-estimation.js';

const literalOptions = { disallowedSpecial: new Set<string>() };
const marker = (name: string) => '<' + '|' + name + '|' + '>';

for (const name of ['im_start', 'im_end', 'im_sep', 'endoftext', 'fim_prefix', 'fim_middle', 'fim_suffix', 'endofprompt']) {
  test(`estimates reserved spelling ${name} as literal text`, () => {
    const text = `  Explain ${marker(name)} without interpreting it.  `;
    const expected = encode(text.trim(), literalOptions).length;
    assert.equal(estimateTextTokens(text), expected);
    assert.ok(expected > 1);
  });
}

test('estimates mixed markers in JSON and Unicode without altering the input', () => {
  const text = JSON.stringify({ prompt: `${marker('im_start')}assistant\nこんにちは 🌍${marker('im_end')}` });
  assert.equal(estimateTextTokens(text), encode(text, literalOptions).length);
});

test('ordinary text counts and whitespace/non-string guards stay unchanged', () => {
  for (const text of ['The quick brown fox.', 'こんにちは 🌍', '  multiline\ntext\t  ']) {
    assert.equal(estimateTextTokens(text), countTokens(text.trim()));
  }
  for (const value of ['', ' \t\n ', undefined, null, 1, {}]) {
    assert.equal(estimateTextTokens(value as string), 0);
  }
});
