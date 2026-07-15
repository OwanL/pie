import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSensitiveText } from '../../src/shared/sensitive-redaction';

test('redactSensitiveText removes labeled, bearer, query, and recognizable credentials', () => {
  const standalone = `sk-${'a'.repeat(24)}`;
  const input = [
    'req-42 failed',
    'Authorization: Bearer bearer-value-123',
    '"apiKey":"json-secret-value"',
    'https://example.test/run?access_token=query-secret&safe=ok',
    standalone,
  ].join(' | ');

  const output = redactSensitiveText(input);

  assert.match(output, /req-42 failed/, 'diagnostic correlation remains useful');
  assert.match(output, /Authorization: \[redacted\]/);
  assert.match(output, /"apiKey":"\[redacted\]"/);
  assert.match(output, /access_token=\[redacted\]&safe=ok/);
  assert.doesNotMatch(output, /bearer-value|json-secret|query-secret/);
  assert.doesNotMatch(output, new RegExp(standalone));
});

test('redactSensitiveText removes private-key blocks without swallowing surrounding context', () => {
  const output = redactSensitiveText([
    'before',
    '-----BEGIN PRIVATE KEY-----',
    'sensitive-key-material',
    '-----END PRIVATE KEY-----',
    'after',
  ].join('\n'));

  assert.equal(output, 'before\n[private key redacted]\nafter');
});
