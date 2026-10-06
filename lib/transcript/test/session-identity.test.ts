import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Compare both exports within one loader graph, including under the legacy ESM runner.
const require = createRequire(import.meta.url);
const { resolveSessionIdentity, sessionPathHash } = require('../session-identity.js') as typeof import('../session-identity.js');
const compatibility = require('../../../harness/session-storage/ownership/session-identity.js') as typeof import('../../../harness/session-storage/ownership/session-identity.js');

test('session identity compatibility exports use the neutral implementation', () => {
  assert.equal(compatibility.resolveSessionIdentity, resolveSessionIdentity);
  assert.equal(compatibility.sessionPathHash, sessionPathHash);
});

test('path fallback normalizes Windows drive and UNC paths but preserves POSIX casing', () => {
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  assert.equal(sessionPathHash(' C:\\Repo\\Session.jsonl '), hash('c:/repo/session.jsonl'));
  assert.equal(sessionPathHash('\\\\SERVER\\Share\\Session.jsonl'), hash('//server/share/session.jsonl'));
  assert.equal(sessionPathHash('/Repo///Session.jsonl'), hash('/Repo/Session.jsonl'));
  assert.notEqual(sessionPathHash('/Repo/Session.jsonl'), sessionPathHash('/repo/session.jsonl'));
});

test('header reader preserves first-line, UTF-8, EOF, bounded-read and no-mint fallback behavior', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-session-identity-'));
  const file = path.join(directory, 'session.jsonl');
  const fallback = { sessionId: sessionPathHash(file), identityFallback: true };
  try {
    assert.deepEqual(resolveSessionIdentity(file), fallback);
    assert.equal(fs.existsSync(file), false);
    const cases: Array<[string, string | undefined]> = [
      ['\n \r\n{"type":"session","id":" stable "}\r\n{"id":"ignored"}', 'stable'],
      ['{"type":"session","id":"終わり"}', '終わり'],
      [' '.repeat(4095) + '{"type":"session","id":"é😀"}\n', 'é😀'],
      ['{"type":"message","id":"wrong"}\n{"type":"session","id":"later"}\n', undefined],
      ['broken\n{"type":"session","id":"later"}\n', undefined],
      ['{"type":"session","id":" "}\n', undefined],
      ['{"type":"session","id":123}\n', undefined],
      ['', undefined],
      [' '.repeat(1024 * 1024) + '{"type":"session","id":"too-late"}\n', undefined],
    ];
    for (const [contents, id] of cases) {
      fs.writeFileSync(file, contents, 'utf8');
      assert.deepEqual(resolveSessionIdentity(file), id === undefined ? fallback : { sessionId: id, identityFallback: false });
      assert.equal(fs.readFileSync(file, 'utf8'), contents);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
