import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import { buildBlindedEvidence, normalizedPathHash, readSessionIdentity } from '../src/evidence.js';

function tempSession(lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-evidence-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

test('stable header ID survives a path move', () => {
  const file = tempSession([JSON.stringify({ type: 'session', id: 'stable-id' })]);
  const moved = path.join(path.dirname(file), 'renamed.jsonl');
  fs.renameSync(file, moved);
  assert.deepEqual(readSessionIdentity(moved), { sessionId: 'stable-id', identityFallback: false });
});

test('missing or malformed first line falls back to normalized path hash', () => {
  const file = tempSession(['not json', JSON.stringify({ type: 'session', id: 'too-late' })]);
  assert.deepEqual(readSessionIdentity(file), { sessionId: normalizedPathHash(file), identityFallback: true });
  assert.equal(normalizedPathHash('C:\\Users\\ME\\x.jsonl'), normalizedPathHash('c:/Users/ME//x.jsonl'));
  assert.equal(normalizedPathHash('\\\\SERVER\\Share\\X'), normalizedPathHash('//server/share/x'));
});

test('identity lookup reads only a bounded prefix and preserves blank-line and EOF headers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-identity-prefix-'));
  const large = path.join(dir, 'large.jsonl');
  const noNewline = path.join(dir, 'no-newline.jsonl');
  fs.writeFileSync(large, `\n\r\n${JSON.stringify({ type: 'session', id: 'bounded-id' })}\n${'x'.repeat(2 * 1024 * 1024)}`);
  fs.writeFileSync(noNewline, JSON.stringify({ type: 'session', id: 'eof-id' }));

  // A regression to readFileSync would either consume the multi-megabyte tail
  // or hit this guard and incorrectly fall back to the path hash.
  const mutableFs = createRequire(import.meta.url)('node:fs') as typeof fs;
  const originalReadFile = mutableFs.readFileSync;
  mutableFs.readFileSync = (() => { throw new Error('full-file identity read forbidden'); }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.deepEqual(readSessionIdentity(large), { sessionId: 'bounded-id', identityFallback: false });
    assert.deepEqual(readSessionIdentity(noNewline), { sessionId: 'eof-id', identityFallback: false });
  } finally {
    mutableFs.readFileSync = originalReadFile;
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized leading identity data fails closed instead of searching for a later header', () => {
  const file = tempSession([
    JSON.stringify({ type: 'session', id: 'oversized-id', padding: 'x'.repeat(70 * 1024) }),
    JSON.stringify({ type: 'session', id: 'too-late' }),
  ]);
  assert.deepEqual(readSessionIdentity(file), { sessionId: normalizedPathHash(file), identityFallback: true });
});

test('evidence hashes raw bytes, hashes the exact excerpt, and blinds model identity', () => {
  const file = tempSession([
    JSON.stringify({ type: 'session', id: 's1' }),
    JSON.stringify({ type: 'model_change', modelId: 'secret-model', provider: 'secret-provider' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'do work' } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', model: 'secret-model', content: [{ type: 'text', text: 'done' }] } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'inspect', content: [{ type: 'text', text: 'runtime author was secret-model via secret-provider' }] } }),
  ]);
  const artifact = path.join(path.dirname(file), 'changed.ts');
  fs.writeFileSync(artifact, 'export const changed = "secret-model";\n');
  const first = buildBlindedEvidence(file, 40, [{ path: artifact, kind: 'file' }]);
  assert.doesNotMatch(first.transcriptExcerpt, /secret-model|secret-provider/);
  assert.ok(first.manifest.blinding.stripped.includes('modelId'));
  assert.equal(first.manifest.rawJsonlBytes, fs.statSync(file).size);
  assert.equal(first.manifest.artifacts[0]?.path, path.resolve(artifact));
  assert.match(first.manifest.artifacts[0]?.sha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(first.artifacts[0]?.excerpt ?? '', /REDACTED_AUTHOR_IDENTITY/);
  assert.doesNotMatch(first.artifacts[0]?.excerpt ?? '', /secret-model/);
  assert.equal(first.manifest.artifacts[0]?.excerptSha256, first.artifacts[0]?.excerptSha256);

  fs.appendFileSync(file, `${JSON.stringify({ type: 'message', message: { role: 'user', content: 'again' } })}\n`);
  const second = buildBlindedEvidence(file);
  assert.notEqual(second.manifest.rawJsonlSha256, first.manifest.rawJsonlSha256);
  assert.notEqual(second.manifest.transcriptExcerptSha256, first.manifest.transcriptExcerptSha256);
});

test('derives a bounded, hashed changed-file excerpt from the captured session cwd and transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-review-derived-evidence-'));
  const changed = path.join(dir, 'generated.txt');
  fs.writeFileSync(changed, `usable changed content\n${'x'.repeat(12_000)}`, 'utf8');
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id: 's-derived', cwd: dir }),
    JSON.stringify({ type: 'message', id: 'm1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: changed, content: 'changed' } }] } }),
    JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: 'write-1', toolName: 'write', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n') + '\n', 'utf8');

  const evidence = buildBlindedEvidence(file);
  const artifact = evidence.artifacts.find((item) => item.path === changed && item.kind === 'untracked');
  assert.ok(artifact);
  assert.match(artifact.excerpt, /usable changed content/);
  assert.ok(artifact.excerptBytes <= 8 * 1024);
  assert.equal(artifact.excerptSha256, createHash('sha256').update(artifact.excerpt).digest('hex'));
  assert.equal(artifact.excerptTruncated, true);
  assert.equal('excerpt' in evidence.manifest.artifacts[0]!, false);
});

test('every internal transcript truncation is surfaced as an evidence limitation', () => {
  const file = tempSession([
    JSON.stringify({ type: 'session', id: 's-truncated' }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'x'.repeat(2_000) } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'y'.repeat(300) }, { type: 'toolCall', name: 'read', arguments: { path: `/${'z'.repeat(100)}` } }] } }),
    JSON.stringify({ type: 'message', message: { role: 'user', content: 'last' } }),
  ]);
  const evidence = buildBlindedEvidence(file, 1);
  assert.ok(evidence.limitations.some((item) => /turn selection omitted/.test(item)));
  assert.ok(evidence.limitations.some((item) => /turn body\/bodies exceeded/.test(item)));
  assert.ok(evidence.limitations.some((item) => /thinking block/.test(item)));
  assert.ok(evidence.limitations.some((item) => /tool argument hint/.test(item)));
});
