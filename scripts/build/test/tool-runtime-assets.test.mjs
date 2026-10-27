import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createToolRuntimeAssetsPlugin, copyPreparedPlaywrightHeadlessPayload, parsePlaywrightPayloadOption, parsePlaywrightRuntimeOption, readToolRuntimeAssets, resolvePlaywrightHeadlessPayloadExpected, TOOL_RUNTIME_FILES, TOOL_RUNTIME_DIRECTORY, TOOL_RUNTIME_MANIFEST, toolRuntimeManifest, verifyPlaywrightHeadlessPayloadOutput } from '../tool-runtime-assets.mjs';
import { verifyToolRuntimeOutput } from '../bundled-extension-verification.mjs';
import { preparePlaywrightHeadlessPayload } from '../playwright-payload.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-tool-assets-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  return temp;
}
function copySources(target) {
  for (const file of TOOL_RUNTIME_FILES) {
    fs.mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(target, file));
  }
}

test('raw code-only closure emits byte-identically and verifies after relocation', async t => {
  const temp = fixture(t);
  const output = path.join(temp, 'output');
  const watched = [];
  const plugin = createToolRuntimeAssetsPlugin(root);
  plugin.buildStart.call({ addWatchFile: file => watched.push(file) });
  for (const file of TOOL_RUNTIME_FILES) assert.ok(watched.includes(path.join(root, file)));
  plugin.generateBundle.call({ emitFile({ fileName, source }) {
    const target = path.join(output, fileName);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source);
  } });
  const relocated = path.join(temp, 'relocated');
  fs.renameSync(output, relocated);
  await verifyToolRuntimeOutput(relocated);
  for (const file of TOOL_RUNTIME_FILES) assert.deepEqual(fs.readFileSync(path.join(relocated, TOOL_RUNTIME_DIRECTORY, file)), fs.readFileSync(path.join(root, file)));
  fs.unlinkSync(path.join(relocated, TOOL_RUNTIME_DIRECTORY, TOOL_RUNTIME_FILES[0]));
  await assert.rejects(verifyToolRuntimeOutput(relocated), /ENOENT/);
});

test('curated source closure includes literal dynamic imports and rejects missing/escaping imports', t => {
  const temp = fixture(t);
  copySources(temp);
  assert.equal(readToolRuntimeAssets(temp).length, TOOL_RUNTIME_FILES.length);
  const entry = path.join(temp, TOOL_RUNTIME_FILES[0]);
  fs.appendFileSync(entry, '\nimport("./uncurated.mjs");');
  assert.throws(() => readToolRuntimeAssets(temp), /outside curated closure/);
  fs.copyFileSync(path.join(root, TOOL_RUNTIME_FILES[0]), entry);
  fs.unlinkSync(entry);
  assert.throws(() => readToolRuntimeAssets(temp), /ENOENT/);
});

test('verifier rejects marker traversal, extras and missing marker', async t => {
  const temp = fixture(t);
  await assert.rejects(verifyToolRuntimeOutput(temp), /ENOENT/);
  fs.mkdirSync(path.dirname(path.join(temp, TOOL_RUNTIME_MANIFEST)), { recursive: true });
  for (const files of [['../../escape.mjs'], [...TOOL_RUNTIME_FILES, 'node_modules/native.node']]) {
    fs.writeFileSync(path.join(temp, TOOL_RUNTIME_MANIFEST), JSON.stringify({ ...toolRuntimeManifest(), files }));
    await assert.rejects(verifyToolRuntimeOutput(temp), /Invalid code-only/);
  }
});

test('prepared Playwright CLI selections require explicit absolute one-shot delivery inputs', () => {
  const directory = path.resolve('prepared-playwright-payload');
  const runtime = path.resolve('prepared-playwright-runtime');
  assert.equal(parsePlaywrightPayloadOption(['--delivery', '--playwright-payload', directory], { requireDelivery: true }), directory);
  assert.equal(parsePlaywrightPayloadOption(['--delivery', `--playwright-payload=${directory}`], { requireDelivery: true }), directory);
  assert.equal(parsePlaywrightPayloadOption(['--delivery']), undefined);
  assert.equal(parsePlaywrightRuntimeOption(['--delivery', '--playwright-runtime', runtime], { requireDelivery: true }), runtime);
  assert.equal(parsePlaywrightRuntimeOption(['--delivery', `--playwright-runtime=${runtime}`], { requireDelivery: true }), runtime);
  assert.equal(parsePlaywrightRuntimeOption(['--delivery']), undefined);
  for (const [parser, flag, value] of [
    [parsePlaywrightPayloadOption, '--playwright-payload', directory],
    [parsePlaywrightRuntimeOption, '--playwright-runtime', runtime],
  ]) {
    for (const argv of [
      [flag, value],
      ['--delivery', flag, 'relative'],
      ['--delivery', flag],
      ['--delivery', flag, value, flag, value],
      ['--delivery', flag, value, '--watch'],
      ['--delivery', flag, value, '--publish'],
      ['--delivery', flag, value, '--activate'],
    ]) assert.throws(() => parser(argv, { requireDelivery: true }));
  }
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

test('trusted Playwright pins resolve through the extension package and its own playwright-core', async t => {
  const temp = fixture(t);
  const repository = path.join(temp, 'repo');
  const extension = path.join(repository, 'extensions/playwright');
  const playwright = path.join(extension, 'node_modules/playwright');
  const ownCore = path.join(playwright, 'node_modules/playwright-core');
  const hoistedCore = path.join(extension, 'node_modules/playwright-core');
  writeJson(path.join(extension, 'package.json'), { name: 'pie-playwright', dependencies: { playwright: '1.62.1' } });
  writeJson(path.join(playwright, 'package.json'), { name: 'playwright', version: '1.62.1' });
  writeJson(path.join(ownCore, 'package.json'), { name: 'playwright-core', version: '1.62.1' });
  writeJson(path.join(ownCore, 'browsers.json'), { browsers: [
    { name: 'chromium', revision: '1111', browserVersion: '140.1.2.3' },
    { name: 'chromium-headless-shell', revision: '2222', browserVersion: '140.1.2.3' },
  ] });
  writeJson(path.join(hoistedCore, 'package.json'), { name: 'playwright-core', version: '9.9.9' });
  const expected = await resolvePlaywrightHeadlessPayloadExpected(repository);
  assert.deepEqual(expected, {
    target: { platform: 'win32', arch: 'x64' }, playwrightVersion: '1.62.1',
    browserVersion: '140.1.2.3', browserRevision: '2222',
  });
  writeJson(path.join(playwright, 'package.json'), { name: 'playwright', version: '1.62.0' });
  await assert.rejects(resolvePlaywrightHeadlessPayloadExpected(repository), /Playwright version.*does not match/);
  writeJson(path.join(playwright, 'package.json'), { name: 'playwright', version: '1.62.1' });
  writeJson(path.join(ownCore, 'package.json'), { name: 'playwright-core', version: '1.62.0' });
  await assert.rejects(resolvePlaywrightHeadlessPayloadExpected(repository), /playwright-core version.*does not match/);
});

const fixturePins = {
  target: { platform: 'win32', arch: 'x64' }, playwrightVersion: '1.2.3',
  browserVersion: '140.1.2.3', browserRevision: '2222',
};

async function preparedFixture(temp, expected = fixturePins, name = 'prepared') {
  const source = path.join(temp, `${name}-source`);
  const shell = path.join(source, 'headless-shell');
  fs.mkdirSync(shell, { recursive: true });
  fs.writeFileSync(path.join(shell, 'chrome-headless-shell.exe'), `${name}-binary`);
  fs.writeFileSync(path.join(shell, 'ABOUT'), 'fixture about');
  fs.writeFileSync(path.join(shell, 'LICENSE.headless_shell'), 'fixture license');
  return preparePlaywrightHeadlessPayload({
    sourceDir: shell, destinationDir: path.join(temp, `${name}-root`), expected,
  });
}

async function outputOwner(temp, name) {
  const output = path.join(temp, name);
  fs.mkdirSync(path.join(output, TOOL_RUNTIME_DIRECTORY), { recursive: true });
  return output;
}

test('composite selection emits exact v2 availability while no-input and shell builds remain v1', async t => {
  const temp = fixture(t);
  const payloadIdentity = 'a'.repeat(64);
  assert.deepEqual(toolRuntimeManifest(), {
    version: 1, codeOnly: true,
    entries: { 'computer-use': 'harness/tools/computer-use/sidecar.mjs', playwright: 'harness/tools/playwright/sidecar.mjs' },
    files: [...TOOL_RUNTIME_FILES],
  });
  const expected = {
    version: 2,
    entries: { 'computer-use': 'harness/tools/computer-use/sidecar.mjs', playwright: 'harness/tools/playwright/sidecar.mjs' },
    files: [...TOOL_RUNTIME_FILES],
    availability: {
      'computer-use': 'unavailable',
      playwright: { state: 'prepared', payloadDirectory: 'playwright-runtime', identity: payloadIdentity },
    },
  };
  assert.deepEqual(toolRuntimeManifest({ playwrightRuntimeIdentity: payloadIdentity }), expected);
  assert.throws(() => toolRuntimeManifest({ playwrightRuntimeIdentity: 'not-an-identity' }), /SHA-256/);

  const previousIdentity = process.env.PIE_BUILD_PLAYWRIGHT_PAYLOAD_IDENTITY;
  const previousRuntime = process.env.PIE_BUILD_PLAYWRIGHT_RUNTIME;
  try {
    process.env.PIE_BUILD_PLAYWRIGHT_PAYLOAD_IDENTITY = payloadIdentity;
    process.env.PIE_BUILD_PLAYWRIGHT_RUNTIME = '1';
    const output = path.join(temp, 'composite-output');
    const plugin = createToolRuntimeAssetsPlugin(root);
    plugin.generateBundle.call({ emitFile({ fileName, source }) {
      const target = path.join(output, fileName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, TOOL_RUNTIME_MANIFEST), 'utf8')), expected);
    await verifyToolRuntimeOutput(output, { playwrightRuntimeIdentity: payloadIdentity });
    await assert.rejects(verifyToolRuntimeOutput(output), /Invalid code-only/);

    process.env.PIE_BUILD_PLAYWRIGHT_RUNTIME = '';
    const shellOutput = path.join(temp, 'shell-output');
    plugin.generateBundle.call({ emitFile({ fileName, source }) {
      const target = path.join(shellOutput, fileName);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    } });
    await verifyToolRuntimeOutput(shellOutput);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shellOutput, TOOL_RUNTIME_MANIFEST), 'utf8')), toolRuntimeManifest());
  } finally {
    if (previousIdentity === undefined) delete process.env.PIE_BUILD_PLAYWRIGHT_PAYLOAD_IDENTITY;
    else process.env.PIE_BUILD_PLAYWRIGHT_PAYLOAD_IDENTITY = previousIdentity;
    if (previousRuntime === undefined) delete process.env.PIE_BUILD_PLAYWRIGHT_RUNTIME;
    else process.env.PIE_BUILD_PLAYWRIGHT_RUNTIME = previousRuntime;
  }
});

test('complete prepared payload is copied, identity-checked and detects output tampering', async t => {
  const temp = fixture(t);
  const prepared = await preparedFixture(temp);
  const output = await outputOwner(temp, 'output');
  const copied = await copyPreparedPlaywrightHeadlessPayload({ directory: prepared.directory, buildDirectory: output, expected: fixturePins });
  assert.equal(copied.identity, prepared.identity);
  assert.equal(toolRuntimeManifest().codeOnly, true, 'headless bytes do not promote the curated code-only marker');
  assert.equal(fs.readFileSync(path.join(output, TOOL_RUNTIME_DIRECTORY, 'playwright-headless-shell/headless-shell/chrome-headless-shell.exe'), 'utf8'), 'prepared-binary');
  await assert.rejects(verifyPlaywrightHeadlessPayloadOutput(output, { expected: fixturePins, expectedIdentity: 'f'.repeat(64) }), /identity mismatch/);
  fs.writeFileSync(path.join(output, TOOL_RUNTIME_DIRECTORY, 'playwright-headless-shell/headless-shell/chrome-headless-shell.exe'), 'tampered');
  await assert.rejects(verifyPlaywrightHeadlessPayloadOutput(output, { expected: fixturePins, expectedIdentity: prepared.identity }), /mutated/);
});

test('prepared payload content changes its content identity', async t => {
  const temp = fixture(t);
  const first = await preparedFixture(temp, fixturePins, 'first');
  const second = await preparedFixture(temp, fixturePins, 'second');
  assert.notEqual(first.identity, second.identity);
});
