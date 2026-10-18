import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CANONICAL_CAPTURE_NAMESPACE, resolveCanonicalCaptureNamespace } from '../recording/capture-namespace.js';

const { DatabaseSync } = createRequire(process.execPath)('node:sqlite');

function fixture(run: (file: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'pie-namespace-'));
  try { run(path.join(directory, 'analytics.sqlite')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function database(file: string, version: number, generations: string[]): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA user_version = ${version};
      CREATE TABLE analytics_observations (generation_id TEXT);
      CREATE TABLE analytics_detail_payloads (generation_id TEXT);`);
    if (version >= 3) db.exec('CREATE TABLE analytics_generations (generation_id TEXT)');
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO analytics_observations VALUES (?)');
    for (const id of generations) insert.run(id);
    db.exec('COMMIT');
  } finally { db.close(); }
}

test('missing and empty databases select a database-scoped constant without writes', () => fixture((file) => {
  assert.equal(resolveCanonicalCaptureNamespace(file), CANONICAL_CAPTURE_NAMESPACE);
  assert.equal(existsSync(file), false);
  new DatabaseSync(file).close();
  const before = readFileSync(file);
  assert.equal(resolveCanonicalCaptureNamespace(file), CANONICAL_CAPTURE_NAMESPACE);
  assert.deepEqual(readFileSync(file), before);
}));

for (const version of [1, 2, 3, 14, 15]) {
  test(`schema ${version}: reuse sole namespace without migration`, () => fixture((file) => {
    database(file, version, ['existing', 'existing']);
    const before = readFileSync(file);
    assert.equal(resolveCanonicalCaptureNamespace(file), 'existing');
    assert.deepEqual(readFileSync(file), before);
  }));
}

test('registry retains namespace after deletion of facts', () => fixture((file) => {
  database(file, 15, []);
  const db = new DatabaseSync(file);
  db.exec("INSERT INTO analytics_generations VALUES ('retained')");
  db.close();
  assert.equal(resolveCanonicalCaptureNamespace(file), 'retained');
}));

test('ambiguity fails closed even when canonical appears among over 1000 namespaces', () => fixture((file) => {
  database(file, 15, [...Array.from({ length: 1001 }, (_, i) => `generation-${i}`), CANONICAL_CAPTURE_NAMESPACE]);
  assert.throws(() => resolveCanonicalCaptureNamespace(file), /Ambiguous/);
}));

for (const kind of ['corrupt', 'foreign', 'newer']) {
  test(`${kind} database fails closed unchanged`, () => fixture((file) => {
    if (kind === 'corrupt') writeFileSync(file, 'not sqlite');
    else if (kind === 'newer') database(file, 16, []);
    else {
      const db = new DatabaseSync(file);
      db.exec('CREATE TABLE unrelated (value TEXT)');
      db.close();
    }
    const before = readFileSync(file);
    assert.throws(() => resolveCanonicalCaptureNamespace(file));
    assert.deepEqual(readFileSync(file), before);
  }));
}
