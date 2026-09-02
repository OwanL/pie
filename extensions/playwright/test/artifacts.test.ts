import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { artifactDirectory, canonicalSessionPath, sanitizeArtifactSegment } from '../src/artifacts.js';

test('sanitize keeps safe filename segments', () => {
  assert.equal(sanitizeArtifactSegment('pw-1234_ab.cd'), 'pw-1234_ab.cd');
  assert.equal(sanitizeArtifactSegment('pw with spaces/../etc'), 'pw-with-spaces-..-etc');
  assert.equal(sanitizeArtifactSegment('***'), 'session');
  assert.ok(sanitizeArtifactSegment('x'.repeat(500)).length <= 80);
});

test('canonicalSessionPath resolves real paths and keeps missing ones absolute', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pw-artifacts-'));
  try {
    const file = path.join(dir, 'session.jsonl');
    await writeFile(file, '');
    assert.equal(await canonicalSessionPath(file), await realpath(file));
    const missing = path.join(dir, 'missing.jsonl');
    assert.equal(await canonicalSessionPath(missing), path.resolve(missing));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('artifactDirectory nests under the pie session directory partitioned by playwright session', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pw-artifacts-'));
  try {
    const sessionFile = path.join(dir, 'my chat.jsonl');
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, '');
    const a = await artifactDirectory(sessionFile, 'pw-one');
    const b = await artifactDirectory(sessionFile, 'pw two');
    const collisionA = await artifactDirectory(sessionFile, 'pw?same');
    const collisionB = await artifactDirectory(sessionFile, 'pw!same');
    const secondSessionFile = path.join(dir, 'my-chat.log');
    await writeFile(secondSessionFile, '');
    const durableCollision = await artifactDirectory(secondSessionFile, 'pw-one');
    await access(a); await access(b); await access(collisionA); await access(collisionB); await access(durableCollision);
    assert.notEqual(a, b);
    assert.notEqual(collisionA, collisionB, 'lossy sanitized IDs must retain distinct artifact partitions');
    assert.notEqual(a, durableCollision, 'lossy durable-session basenames must retain distinct artifact partitions');
    assert.ok(a.includes(`${path.sep}playwright${path.sep}`));
    const canonicalDir = path.dirname(await realpath(sessionFile));
    assert.ok(a.startsWith(canonicalDir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
