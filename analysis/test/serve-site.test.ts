import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import test from 'node:test';

import { listenOnLocalhost } from '../scripts/serve-site-listen.ts';
import { resolveSiteRequestPath } from '../scripts/serve-site-paths.ts';

const SITE_ROOT = path.resolve('analysis/site');

test('listenOnLocalhost reports a port conflict without an unhandled server error', async () => {
  const occupied = http.createServer();
  await listenOnLocalhost(occupied, 0);
  try {
    const address = occupied.address();
    assert.ok(address && typeof address === 'object');
    const contender = http.createServer();
    await assert.rejects(
      listenOnLocalhost(contender, address.port),
      new RegExp(`Port ${address.port} is already in use.*--port <port>`),
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      occupied.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('resolveSiteRequestPath serves canonical allowed data files only', () => {
  assert.equal(
    resolveSiteRequestPath(SITE_ROOT, '/data/manifest.json'),
    path.resolve(SITE_ROOT, 'data', 'manifest.json'),
  );
  assert.equal(
    resolveSiteRequestPath(SITE_ROOT, '/data/Manifest.json'),
    path.resolve(SITE_ROOT, 'data', 'manifest.json'),
  );
  assert.equal(
    resolveSiteRequestPath(SITE_ROOT, '/dist/../data/manifest.json'),
    path.resolve(SITE_ROOT, 'data', 'manifest.json'),
  );
});

test('resolveSiteRequestPath rejects unapproved or escaped data paths', () => {
  assert.throws(
    () => resolveSiteRequestPath(SITE_ROOT, '/data/run-analytics.json'),
    /Not found/,
  );
  assert.throws(
    () => resolveSiteRequestPath(SITE_ROOT, '/DATA/run-analytics.json'),
    /Not found/,
  );
  assert.throws(
    () => resolveSiteRequestPath(SITE_ROOT, '/../outside.txt'),
    /Invalid path/,
  );
});

test('resolveSiteRequestPath serves non-data assets and strips query strings', () => {
  assert.equal(
    resolveSiteRequestPath(SITE_ROOT, '/dist/app.js?cache=1'),
    path.resolve(SITE_ROOT, 'dist', 'app.js'),
  );
});

test('resolveSiteRequestPath rejects nested data paths after decoding', () => {
  assert.throws(
    () => resolveSiteRequestPath(SITE_ROOT, '/data/nested/manifest.json'),
    /Not found/,
  );
  assert.throws(
    () => resolveSiteRequestPath(SITE_ROOT, '/data%2Fnested%2Fmanifest.json'),
    /Not found/,
  );
});

test('resolveSiteRequestPath rejects cross-drive absolute paths on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.throws(
    () => resolveSiteRequestPath('C:\\site-root', 'D:/outside.txt'),
    /Invalid path/,
  );
});
