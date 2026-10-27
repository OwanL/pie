import assert from 'node:assert/strict';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PLAYWRIGHT_HEADLESS_ABOUT,
  PLAYWRIGHT_HEADLESS_EXECUTABLE,
  PLAYWRIGHT_HEADLESS_LICENSE,
  PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST,
  PLAYWRIGHT_HEADLESS_PAYLOAD_TREE,
  preparePlaywrightHeadlessPayload,
  validatePlaywrightHeadlessPayload,
} from '../playwright-payload.mjs';

const expected = Object.freeze({
  target: Object.freeze({ platform: 'win32', arch: 'x64' }),
  playwrightVersion: '1.62.1',
  browserVersion: '151.0.7922.34',
  browserRevision: '1234',
});
const archiveDeclaration = Object.freeze({
  url: 'https://cdn.playwright.dev/builds/cft/151.0.7922.34/win64/chrome-headless-shell-win64.zip',
  sha256: 'a'.repeat(64),
  sizeBytes: 120106945,
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-playwright-payload-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'selected-shell-tree');
  await mkdir(path.join(sourceDir, 'locales'), { recursive: true });
  await writeFile(path.join(sourceDir, 'chrome-headless-shell.exe'), Buffer.from('synthetic headless shell executable\0'));
  await writeFile(path.join(sourceDir, 'ABOUT'), 'Synthetic ABOUT notice\n');
  await writeFile(path.join(sourceDir, 'LICENSE.headless_shell'), 'Synthetic license text\n');
  await writeFile(path.join(sourceDir, 'locales', 'en-US.pak'), Buffer.from([0, 1, 2, 255]));
  return { root, sourceDir };
}

async function prepare(sourceDir, destinationDir, overrides = {}) {
  return preparePlaywrightHeadlessPayload({ sourceDir, destinationDir, expected, ...overrides });
}

async function copyPayload(source, destination) {
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
  return destination;
}

async function listBytes(root, relative = '') {
  const output = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    const child = relative ? `${relative}/${name}` : name;
    const absolute = path.join(root, child);
    const info = await lstat(absolute);
    if (info.isDirectory()) output.push(...await listBytes(root, child));
    else output.push([child, await readFile(absolute)]);
  }
  return output;
}

async function createJunctionOrSkip(t, target, linkPath) {
  try {
    await symlink(target, linkPath, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Windows did not permit a synthetic junction: ${error.code}`);
      return false;
    }
    throw error;
  }
  return true;
}

test('prepares and validates a canonical shell-only payload against trusted pins', async t => {
  const { root, sourceDir } = await fixture(t);
  const destinationDir = path.join(root, 'prepared');
  const prepared = await prepare(sourceDir, destinationDir, { sourceArchiveDeclaration: archiveDeclaration });
  const verified = await validatePlaywrightHeadlessPayload({ directory: destinationDir, expected });
  const text = await readFile(path.join(destinationDir, PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST), 'utf8');
  const manifest = JSON.parse(text);

  assert.equal(prepared.identity, verified.identity);
  assert.equal(prepared.identity, manifest.payloadIdentity);
  assert.equal(text, `${JSON.stringify(manifest, null, 2)}\n`, 'manifest serialization is canonical');
  const reorderedDir = path.join(root, 'noncanonical');
  await copyPayload(destinationDir, reorderedDir);
  const reorderedPath = path.join(reorderedDir, PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST);
  await writeFile(reorderedPath, `${JSON.stringify({ kind: manifest.kind, ...manifest }, null, 2)}\n`);
  await assert.rejects(validatePlaywrightHeadlessPayload({ directory: reorderedDir, expected }), /not in canonical serialized form/u);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'playwright-headless-shell');
  assert.deepEqual(manifest.target, expected.target);
  assert.deepEqual(manifest.pins, {
    playwrightVersion: expected.playwrightVersion,
    browserVersion: expected.browserVersion,
    browserRevision: expected.browserRevision,
  });
  assert.equal(manifest.executableRelativePath, PLAYWRIGHT_HEADLESS_EXECUTABLE);
  assert.deepEqual(manifest.notices, {
    aboutRelativePath: PLAYWRIGHT_HEADLESS_ABOUT,
    licenseRelativePath: PLAYWRIGHT_HEADLESS_LICENSE,
  });
  assert.deepEqual(manifest.files.map(entry => entry.relativePath), [
    'headless-shell/ABOUT',
    'headless-shell/LICENSE.headless_shell',
    'headless-shell/chrome-headless-shell.exe',
    'headless-shell/locales/en-US.pak',
  ]);
  assert.deepEqual(manifest.sourceArchiveDeclaration, {
    ...archiveDeclaration,
    verification: 'declaration-only',
  }, 'archive metadata is not misrepresented as tree correspondence evidence');
  assert.deepEqual((await readdir(destinationDir)).sort(), [PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE].sort());
  assert.equal(await readFile(path.join(destinationDir, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE, 'chrome-headless-shell.exe'), 'utf8'), 'synthetic headless shell executable\0');
});

test('relocation is byte-identical and identity is stable but content-sensitive', async t => {
  const { root, sourceDir } = await fixture(t);
  const first = await prepare(sourceDir, path.join(root, 'first'));
  const relocatedDir = path.join(root, 'relocated', 'payload');
  await mkdir(path.dirname(relocatedDir));
  await copyPayload(first.directory, relocatedDir);
  const relocated = await validatePlaywrightHeadlessPayload({ directory: relocatedDir, expected });
  const second = await prepare(sourceDir, path.join(root, 'second'));

  assert.equal(first.identity, relocated.identity);
  assert.equal(first.identity, second.identity);
  assert.deepEqual(await listBytes(first.directory), await listBytes(relocatedDir));
  await writeFile(path.join(sourceDir, 'ABOUT'), 'Changed notice bytes\n');
  const changed = await prepare(sourceDir, path.join(root, 'changed'));
  assert.notEqual(changed.identity, first.identity);
});

test('trusted pin and target contract mismatches are rejected', async t => {
  const { root, sourceDir } = await fixture(t);
  const differentlyPinned = await prepare(sourceDir, path.join(root, 'other-pins'), {
    expected: { ...expected, playwrightVersion: '1.62.2' },
  });
  await assert.rejects(
    validatePlaywrightHeadlessPayload({ directory: differentlyPinned.directory, expected }),
    /version pins do not match the trusted build-owner contract/u,
  );
  await assert.rejects(
    prepare(sourceDir, path.join(root, 'wrong-target'), {
      expected: { ...expected, target: { platform: 'win32', arch: 'arm64' } },
    }),
    /only the explicitly selected win32\/x64/u,
  );
  await assert.rejects(
    validatePlaywrightHeadlessPayload({ directory: differentlyPinned.directory, expected: { ...expected, target: { platform: 'linux', arch: 'x64' } } }),
    /only the explicitly selected win32\/x64/u,
  );
});

test('validation rejects a directory manifest before reading it', async t => {
  const { root, sourceDir } = await fixture(t);
  const prepared = await prepare(sourceDir, path.join(root, 'directory-manifest'));
  const manifestPath = path.join(prepared.directory, PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST);
  await rm(manifestPath);
  await mkdir(manifestPath);

  await assert.rejects(
    validatePlaywrightHeadlessPayload({ directory: prepared.directory, expected }),
    /manifest.json must be a regular file, not a symlink or special entry/u,
  );
});

test('validation rejects an external manifest symlink', async t => {
  const { root, sourceDir } = await fixture(t);
  const prepared = await prepare(sourceDir, path.join(root, 'symlink-manifest'));
  const manifestPath = path.join(prepared.directory, PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST);
  const externalManifestPath = path.join(root, 'external-manifest.json');
  await writeFile(externalManifestPath, await readFile(manifestPath));
  await rm(manifestPath);
  try {
    await symlink(externalManifestPath, manifestPath, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error.code)) {
      t.skip(`Platform did not permit a synthetic manifest symlink: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    validatePlaywrightHeadlessPayload({ directory: prepared.directory, expected }),
    /manifest.json must be a regular file, not a symlink or special entry/u,
  );
});

test('validation rejects mutated, missing, and extra files', async t => {
  const { root, sourceDir } = await fixture(t);
  const prepared = await prepare(sourceDir, path.join(root, 'original'));

  const mutated = path.join(root, 'mutated');
  await copyPayload(prepared.directory, mutated);
  await writeFile(path.join(mutated, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE, 'ABOUT'), 'tampered\n');
  await assert.rejects(validatePlaywrightHeadlessPayload({ directory: mutated, expected }), /payload file is missing, extra, or mutated/u);

  const missing = path.join(root, 'missing');
  await copyPayload(prepared.directory, missing);
  await rm(path.join(missing, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE, 'locales', 'en-US.pak'));
  await assert.rejects(validatePlaywrightHeadlessPayload({ directory: missing, expected }), /missing or extra files|missing, extra, or mutated|empty directories/u);

  const extra = path.join(root, 'extra');
  await copyPayload(prepared.directory, extra);
  await writeFile(path.join(extra, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE, 'surprise.bin'), 'extra');
  await assert.rejects(validatePlaywrightHeadlessPayload({ directory: extra, expected }), /missing or extra files|missing, extra, or mutated/u);
});

test('path safety rejects traversal, symlinks, and overlapping source/output', async t => {
  const { root, sourceDir } = await fixture(t);
  await assert.rejects(
    prepare(sourceDir, path.join(sourceDir, 'nested-output')),
    /must not overlap/u,
  );
  const nonShellSource = path.join(root, 'non-shell-source');
  await cp(sourceDir, nonShellSource, { recursive: true });
  await writeFile(path.join(nonShellSource, 'ffmpeg-win64.exe'), 'not needed');
  await assert.rejects(prepare(nonShellSource, path.join(root, 'non-shell-output')), /non-headless browser or ffmpeg/u);
  const prepared = await prepare(sourceDir, path.join(root, 'prepared'));

  const traversal = path.join(root, 'traversal');
  await copyPayload(prepared.directory, traversal);
  const traversalManifestPath = path.join(traversal, PLAYWRIGHT_HEADLESS_PAYLOAD_MANIFEST);
  const manifest = JSON.parse(await readFile(traversalManifestPath, 'utf8'));
  manifest.files[0].relativePath = '../outside';
  await writeFile(traversalManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(validatePlaywrightHeadlessPayload({ directory: traversal, expected }), /unsafe canonical relative path|unsafe path segment/u);

  const externalTree = path.join(root, 'external-tree');
  await mkdir(externalTree);
  const payloadLink = path.join(prepared.directory, PLAYWRIGHT_HEADLESS_PAYLOAD_TREE, 'linked-tree');
  if (await createJunctionOrSkip(t, externalTree, payloadLink)) {
    await assert.rejects(validatePlaywrightHeadlessPayload({ directory: prepared.directory, expected }), /symbolic links are forbidden/u);
  }

  const inputLinkRoot = path.join(root, 'source-with-link');
  await cp(sourceDir, inputLinkRoot, { recursive: true });
  const inputLink = path.join(inputLinkRoot, 'outside-tree');
  if (await createJunctionOrSkip(t, externalTree, inputLink)) {
    await assert.rejects(prepare(inputLinkRoot, path.join(root, 'linked-source-output')), /symbolic links are forbidden/u);
  }
});

test('existing immutable destination is refused without changing its bytes', async t => {
  const { root, sourceDir } = await fixture(t);
  const destinationDir = path.join(root, 'immutable');
  const first = await prepare(sourceDir, destinationDir);
  const before = await listBytes(destinationDir);
  await assert.rejects(prepare(sourceDir, destinationDir), /already exists; immutable payload destinations are never overwritten/u);
  assert.deepEqual(await listBytes(destinationDir), before);
  assert.equal(first.identity, (await validatePlaywrightHeadlessPayload({ directory: destinationDir, expected })).identity);
});
