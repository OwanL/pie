import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { copyPackageSkeleton, parseQualificationArgs, qualificationStages, qualifyDelivery, runQualificationStage, validateBrowserExecutable } from '../qualify-delivery.mjs';
import { watchChildProcess } from '../../lib/process-watchdog.mjs';
import { createOwnerRequire } from '../../lib/package-resolution.mjs';
import { extractCandidate, fingerprintCandidate, runtimeTargetPlatform, validateCandidateContainer, verifyCandidateIdentity } from '../lib/vsix-candidate.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const confirmed = { code: 0, outerConfirmed: true, innerConfirmed: true };

const candidateFingerprint = { sha256: 'a'.repeat(64), size: 123 };
const candidateIdentity = { extensionId: 'pie.pie', version: '1.2.3', target: 'win32-x64', buildId: 'b'.repeat(20), piRuntimeIdentity: 'fixture-runtime' };

async function candidateFixture(t, overrides = {}) {
  return fixture(t, {
    fingerprintCandidate: async () => ({ ...candidateFingerprint }),
    extractCandidate: async () => ({ ...candidateIdentity }),
    verifyCandidateIdentity: async () => ({ ...candidateIdentity }),
    ...overrides,
  });
}

test('managed exact candidate must finish registration before pass evidence', async t => {
  const selection = { vsix: path.join(os.tmpdir(), 'candidate.vsix'), managedIntegration: { stageRoot: os.tmpdir(), receiptPath: path.join(os.tmpdir(), 'receipt.json') } };
  for (const failed of [true, false]) {
    let called = false;
    const f = await candidateFixture(t, { qualifyRegistration: async options => {
      called = true;
      assert.equal(options.candidateRoot, f.packageRoot);
      assert.deepEqual(options.managedIntegration, selection.managedIntegration);
      assert.equal((await readdir(f.packageRoot)).includes('qualification-evidence.json'), false);
      if (failed) throw Error('registration failed');
      return { evidencePath: 'private-registration-evidence' };
    } });
    if (failed) { await assert.rejects(qualifyDelivery(selection, undefined, f.dependencies), /registration failed/); await assertNoSuccessEvidence(f); }
    else { const result = await qualifyDelivery(selection, undefined, f.dependencies); assert.deepEqual(JSON.parse(await readFile(result.evidencePath, 'utf8')).registration, { evidencePath: 'private-registration-evidence' }); }
    assert.ok(called);
  }
});

test('managed marker identity cannot bypass stage/receipt registration requirement', async t => {
  const f = await candidateFixture(t, { verifyCandidateIdentity: async () => ({ ...candidateIdentity, managedIntegration: {} }) });
  await assert.rejects(qualifyDelivery({ vsix: path.join(os.tmpdir(), 'candidate.vsix') }, undefined, f.dependencies), /original stage and receipt/);
  await assertNoSuccessEvidence(f);
});

async function assertNoSuccessEvidence(f) {
  assert.equal((await readdir(f.packageRoot)).includes('qualification-evidence.json'), false);
  assert.equal(f.events.some(event => event.startsWith('qualified:')), false);
  assert.equal(f.events.includes('remove'), false);
  assert.ok(f.events.some(event => event.includes(`RETAINED ${f.packageRoot}`)));
}

test('VSIX parser requires absolute paths, rejects duplicates and runtime combinations', () => {
  const vsix = path.join(os.tmpdir(), 'candidate.vsix');
  const nodeRuntime = path.join(os.tmpdir(), 'prepared-node-runtime');
  const playwrightRuntime = path.join(os.tmpdir(), 'prepared-playwright-runtime');
  assert.deepEqual(parseQualificationArgs(['--vsix', vsix]), { vsix });
  assert.deepEqual(parseQualificationArgs([`--vsix=${vsix}`]), { vsix });
  assert.deepEqual(parseQualificationArgs(['--vsix', vsix, '--node-runtime', nodeRuntime]), { vsix, nodeRuntimeDir: nodeRuntime });
  assert.deepEqual(parseQualificationArgs(['--vsix', vsix, '--playwright-runtime', playwrightRuntime]), {
    vsix, playwrightRuntimeDir: playwrightRuntime,
  });
  assert.deepEqual(parseQualificationArgs([`--playwright-runtime=${playwrightRuntime}`, `--vsix=${vsix}`]), {
    vsix, playwrightRuntimeDir: playwrightRuntime,
  });
  for (const args of [['--vsix'], ['--vsix='], ['--vsix', 'relative.vsix'],
    ['--vsix', vsix, `--vsix=${vsix}`], ['--vsix', vsix, '--pi-runtime', os.tmpdir()],
    ['--pi-runtime', os.tmpdir(), '--vsix', vsix], ['--playwright-runtime', playwrightRuntime],
    ['--vsix', vsix, '--playwright-runtime'], ['--vsix', vsix, '--playwright-runtime', 'relative'],
    ['--vsix', vsix, '--playwright-runtime', playwrightRuntime, '--playwright-runtime', playwrightRuntime],
    ['--vsix', vsix, '--node-runtime'], ['--vsix', vsix, '--node-runtime', 'relative'],
    ['--vsix', vsix, '--node-runtime', nodeRuntime, '--node-runtime', nodeRuntime]]) {
    assert.throws(() => parseQualificationArgs(args));
  }
});

test('exact candidate runs only delivered hosts and retains identity/fingerprint evidence', async t => {
  const vsix = path.join(os.tmpdir(), 'candidate.vsix');
  const f = await candidateFixture(t, {
    copySkeleton: async () => assert.fail('candidate must not copy skeleton'),
    verifyRuntime: async () => assert.fail('candidate must not use checkout runtime'),
    extractCandidate: async (file, destination) => { assert.equal(file, vsix); assert.equal(destination, f.packageRoot); return { ...candidateIdentity }; },
  });
  const result = await qualifyDelivery({ vsix }, undefined, f.dependencies);
  assert.equal(result.code, 0);
  assert.deepEqual(f.stages.map(item => item.stage.name), ['delivered-hosts']);
  assert.equal(f.stages[0].stage.env.PIE_DELIVERED_HOST_ROOT, f.packageRoot);
  assert.equal(f.stages[0].stage.env.PIE_DELIVERED_BROWSER_EXECUTABLE, process.execPath);
  assert.deepEqual(result.candidate, { path: vsix, ...candidateFingerprint, ...candidateIdentity });
  assert.deepEqual(JSON.parse(await readFile(result.evidencePath, 'utf8')), { candidate: result.candidate, packageRoot: f.packageRoot, qualification: 'passed: private standalone and mocked VS Code adapters plus headless browser first paint', installed: false, published: false });
  assert.equal(f.events.includes('remove'), false);
  assert.ok(f.events.some(event => event.includes(`RETAINED ${f.packageRoot}`)));
});

test('exact VSIX validates selected Playwright identity and extracted bytes, recording only verified identity', async t => {
  const vsix = path.join(os.tmpdir(), 'candidate.vsix');
  const playwrightRuntimeDir = path.join(os.tmpdir(), 'prepared-playwright-runtime');
  const playwrightRuntimeIdentity = 'f'.repeat(64);
  const managedIntegration = { stageRoot: path.join(os.tmpdir(), 'managed-stage'), receiptPath: path.join(os.tmpdir(), 'managed-proof.json') };
  const validations = [];
  const outputChecks = [];
  const f = await candidateFixture(t, {
    validatePlaywrightRuntimePayload: async selection => {
      validations.push(selection);
      return { directory: selection.directory, identity: playwrightRuntimeIdentity };
    },
    verifyCandidateIdentity: async (destination, selection) => {
      assert.equal(destination, f.packageRoot);
      assert.deepEqual(selection, { managedIntegration, expectedPlaywrightRuntimeIdentity: playwrightRuntimeIdentity });
      return { ...candidateIdentity, playwrightRuntimeIdentity, managedIntegration: { verified: true } };
    },
    verifyPlaywrightRuntimePayloadOutput: async (out, selection) => {
      outputChecks.push({ out, selection });
      return { identity: playwrightRuntimeIdentity };
    },
    qualifyRegistration: async selection => {
      assert.equal(selection.candidateRoot, f.packageRoot);
      assert.deepEqual(selection.managedIntegration, managedIntegration);
      assert.equal(selection.expectedPlaywrightRuntimeIdentity, playwrightRuntimeIdentity);
      return { evidencePath: 'registration-evidence' };
    },
  });
  const result = await qualifyDelivery({ vsix, playwrightRuntimeDir, managedIntegration }, undefined, f.dependencies);
  assert.deepEqual(validations, [
    { directory: playwrightRuntimeDir, repositoryRoot: root },
    { directory: playwrightRuntimeDir, repositoryRoot: root },
  ]);
  assert.deepEqual(outputChecks, [{
    out: path.join(f.packageRoot, 'out'),
    selection: { repositoryRoot: root, expectedIdentity: playwrightRuntimeIdentity },
  }]);
  assert.equal(result.candidate.playwrightRuntimeIdentity, playwrightRuntimeIdentity);
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
  assert.equal(evidence.candidate.playwrightRuntimeIdentity, playwrightRuntimeIdentity);
  assert.equal(Object.hasOwn(evidence, 'readiness'), false);
  assert.deepEqual(f.stages.map(item => item.stage.name), ['delivered-hosts']);
  assert.equal(f.events.some(event => event.startsWith('verify:')), false);
});

test('exact VSIX validates selected Node identity and extracted bytes without rebuilding', async t => {
  const vsix = path.join(os.tmpdir(), 'candidate.vsix');
  const nodeRuntimeDir = path.join(os.tmpdir(), 'prepared-node-runtime');
  const nodeRuntimeIdentity = '8'.repeat(64);
  const validations = [];
  const outputChecks = [];
  const f = await candidateFixture(t, {
    copySkeleton: async () => assert.fail('exact VSIX must not copy a package skeleton'),
    verifyRuntime: async () => assert.fail('exact VSIX must not use checkout runtime'),
    validateNodeRuntimePayload: async selection => {
      validations.push(selection);
      return { directory: nodeRuntimeDir, identity: nodeRuntimeIdentity };
    },
    extractCandidate: async (file, destination) => {
      assert.equal(file, vsix);
      assert.equal(destination, f.packageRoot);
      return { ...candidateIdentity, nodeRuntimeIdentity };
    },
    verifyCandidateIdentity: async (destination, selection) => {
      assert.equal(destination, f.packageRoot);
      assert.deepEqual(selection, {
        managedIntegration: undefined,
        expectedNodeRuntimeIdentity: nodeRuntimeIdentity,
        repositoryRoot: root,
      });
      return { ...candidateIdentity, nodeRuntimeIdentity };
    },
    validateNodeRuntimeOutput: async selection => {
      outputChecks.push(selection);
      return { identity: nodeRuntimeIdentity };
    },
  });
  const result = await qualifyDelivery({ vsix, nodeRuntimeDir }, undefined, f.dependencies);
  assert.deepEqual(validations, [
    { directory: nodeRuntimeDir, repositoryRoot: root },
    { directory: nodeRuntimeDir, repositoryRoot: root },
  ]);
  assert.deepEqual(outputChecks, [{ directory: path.join(f.packageRoot, 'out/resources/node-runtime'), repositoryRoot: root }]);
  assert.deepEqual(f.stages.map(item => item.stage.name), ['delivered-hosts']);
  assert.equal(result.candidate.nodeRuntimeIdentity, nodeRuntimeIdentity);
  const evidence = JSON.parse(await readFile(result.evidencePath, 'utf8'));
  assert.equal(evidence.candidate.nodeRuntimeIdentity, nodeRuntimeIdentity);
  assert.equal(f.events.includes('verify:undefined'), false);
});

test('candidate hash or size mutation rejects without success evidence', async t => {
  for (const mutation of [{ sha256: 'c'.repeat(64) }, { size: 124 }]) {
    let fingerprints = 0;
    const f = await candidateFixture(t, { fingerprintCandidate: async () => ({ ...candidateFingerprint, ...(fingerprints++ ? mutation : {}) }) });
    await assert.rejects(qualifyDelivery({ vsix: path.join(os.tmpdir(), 'candidate.vsix') }, undefined, f.dependencies), /changed during qualification/u);
    assert.equal(fingerprints, 2);
    await assertNoSuccessEvidence(f);
  }
});

test('candidate uncertain completion, nested 125 and cancellation retain without success evidence', async t => {
  for (const mode of ['outer', 'inner', '125', 'cancel']) {
    const controller = new AbortController();
    const f = await candidateFixture(t, { runStage: async () => {
      if (mode === 'cancel') controller.abort();
      return { ...confirmed, ...(mode === 'outer' ? { outerConfirmed: false } : mode === 'inner' ? { innerConfirmed: false } : mode === '125' ? { code: 125 } : {}) };
    } });
    await assert.rejects(qualifyDelivery({ vsix: path.join(os.tmpdir(), 'candidate.vsix') }, controller.signal, f.dependencies));
    await assertNoSuccessEvidence(f);
  }
});

function containerEntries({ id = 'pie', publisher = 'pie', version = '1.2.3', target = 'win32-x64', installation = 'Microsoft.VisualStudio.Code', asset = 'extension/package.json' } = {}) {
  return [
    ['extension.vsixmanifest', `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata><Identity Id="${id}" Publisher="${publisher}" Version="${version}" TargetPlatform="${target}"/></Metadata>
  <Installation><InstallationTarget Id="${installation}" Version="[1.90.0,)"/></Installation>
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="${asset}"/></Assets>
</PackageManifest>`],
    ['[Content_Types].xml', '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>'],
  ];
}

async function zipFixture(directory, entries, rewrite) {
  const yazl = createRequire(createOwnerRequire().resolve('@vscode/vsce/package.json'))('yazl');
  const zip = new yazl.ZipFile();
  const chunks = [];
  const bytes = new Promise((resolve, reject) => {
    zip.outputStream.on('data', chunk => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
  for (const [name, content, options] of entries) zip.addBuffer(Buffer.from(content), name, options);
  zip.end();
  const file = path.join(directory, 'candidate.vsix');
  const buffer = await bytes;
  await writeFile(file, rewrite ? rewrite(buffer) : buffer);
  return file;
}

test('real extractor subprocess completes every entry including empty and deflated files', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'vsix-subprocess-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  // Deterministic xorshift bytes exercise backpressure without compressing away.
  const payload = Buffer.alloc(2 * 1024 * 1024 + 17);
  let state = 0x12345678;
  for (let i = 0; i < payload.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    payload[i] = state & 0xff;
  }
  const files = [['package.json', Buffer.from('{}'), false], ['empty', Buffer.alloc(0), false],
    ['nested/stored.bin', payload, false], ['nested/deflated.bin', payload, true], ['last.txt', Buffer.from('last'), true]];
  const file = await zipFixture(sandbox, [...files.map(([name, content, compress]) => [`extension/${name}`, content, { compress }]), ...containerEntries()]);
  const destination = path.join(sandbox, 'extracted');
  const moduleUrl = new URL('../lib/vsix-candidate.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { extractCandidate } from ${JSON.stringify(moduleUrl)};
     extractCandidate(${JSON.stringify(file)}, ${JSON.stringify(destination)}).then(() => console.log('EXTRACTION_COMPLETE')).catch(error => { console.error(error); process.exitCode = 1; });`],
  { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /EXTRACTION_COMPLETE/, `exit zero without completion is not success: ${result.stderr}`);
  for (const [name, content] of files) assert.deepEqual(await readFile(path.join(destination, name)), content);
});

test('real extractor awaits source descriptor close before resolving', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-vsix-awaited-close-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const file = await zipFixture(sandbox, [['extension/package.json', '{}'], ...containerEntries()]);
  const destination = path.join(sandbox, 'extracted');
  const moduleUrl = new URL('../lib/vsix-candidate.mjs', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const source = ${JSON.stringify(file)};
    const originalOpen = fs.promises.open;
    let closeCount = 0;
    let extractionResolved = false;
    let releaseClose;
    const closeGate = new Promise(resolve => { releaseClose = resolve; });
    fs.promises.open = async function(filePath, ...args) {
      const handle = await originalOpen.call(this, filePath, ...args);
      if (filePath !== source) return handle;
      const originalClose = handle.close.bind(handle);
      handle.close = async () => {
        await originalClose();
        closeCount++;
        await closeGate;
      };
      return handle;
    };
    syncBuiltinESMExports();
    const { extractCandidate } = await import(${JSON.stringify(moduleUrl)});
    const extraction = extractCandidate(source, ${JSON.stringify(destination)}).then(value => {
      extractionResolved = true;
      return value;
    });
    for (let i = 0; i < 200 && closeCount === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(closeCount, 1, 'source descriptor close was invoked exactly once');
    assert.equal(extractionResolved, false, 'extraction remains pending while close is pending');
    releaseClose();
    await extraction;
    assert.equal(closeCount, 1);
    console.log('AWAITED_CLOSE_CONFIRMED');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /AWAITED_CLOSE_CONFIRMED/u, result.stderr);
});

test('real VSIX extraction excludes metadata and rejects duplicate, symlink and traversal entries', async t => {
  for (const mode of ['good', 'duplicate', 'symlink', 'traversal', 'unsafe-metadata']) {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-vsix-extract-'));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    const entries = [['extension/package.json', '{"name":"pie"}'], ...containerEntries()];
    if (mode === 'duplicate') entries.push(['extension/package.json', 'duplicate']);
    if (mode === 'symlink') entries.push(['extension/link', 'target', { mode: 0o120777 }]);
    if (mode === 'traversal') entries.push(['extension/xx/file', 'escape']);
    if (mode === 'unsafe-metadata') entries.push(['metadata/CON', 'unsafe']);
    const file = await zipFixture(sandbox, entries, mode === 'traversal'
      ? buffer => Buffer.from(buffer.toString('latin1').replaceAll('extension/xx/file', 'extension/../file'), 'latin1') : undefined);
    const destination = path.join(sandbox, 'extracted');
    if (mode === 'good') {
      assert.deepEqual(await extractCandidate(file, destination), { extensionId: 'pie.pie', version: '1.2.3', target: 'win32-x64' });
      assert.deepEqual(await readdir(destination), ['package.json']);
      assert.equal(await readFile(path.join(destination, 'package.json'), 'utf8'), '{"name":"pie"}');
    } else await assert.rejects(extractCandidate(file, destination), /Duplicate|Nonregular|Unsafe|invalid relative path/u);
  }
});

test('real extractor rejects invalid ZIP initialization and preserves existing destinations', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-vsix-invalid-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const file = path.join(sandbox, 'invalid.vsix');
  await writeFile(file, 'not a ZIP archive');
  await assert.rejects(extractCandidate(file, path.join(sandbox, 'invalid-output')), /central directory|zipfile|ZIP/i);
  const valid = await zipFixture(sandbox, [['extension/package.json', '{}'], ...containerEntries()]);
  const destination = path.join(sandbox, 'existing');
  await mkdir(destination);
  await writeFile(path.join(destination, 'package.json'), 'preserve me', { flag: 'wx' });
  await assert.rejects(extractCandidate(valid, destination), /empty nonsymlink directory/);
  assert.equal(await readFile(path.join(destination, 'package.json'), 'utf8'), 'preserve me');
});

test('real VSIX container identity agrees with payload version, publisher, name and native target', async t => {
  const identity = { ...candidateIdentity, target: runtimeTargetPlatform({ platform: 'win32', arch: 'x64' }) };
  for (const [patch, mismatch] of [
    [{}, undefined], [{ version: '1.2.4' }, 'version'], [{ publisher: 'other' }, 'extensionId'],
    [{ id: 'other' }, 'extensionId'], [{ target: 'universal' }, 'target'], [{ target: 'linux-x64' }, 'target'],
  ]) {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-vsix-container-'));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    const file = await zipFixture(sandbox, [['extension/package.json', JSON.stringify({ publisher: 'pie', name: 'pie', version: identity.version })], ...containerEntries(patch)]);
    const container = await extractCandidate(file, path.join(sandbox, 'extracted'));
    if (mismatch) assert.throws(() => validateCandidateContainer(container, identity), new RegExp(`${mismatch} mismatch`, 'u'));
    else assert.doesNotThrow(() => validateCandidateContainer(container, identity));
  }
});

test('real VSIX rejects missing XML, invalid installation target and package asset', async t => {
  for (const mode of ['manifest', 'types', 'malformed', 'installation', 'asset']) {
    const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-vsix-invalid-container-'));
    t.after(() => rm(sandbox, { recursive: true, force: true }));
    let entries = containerEntries(mode === 'installation' ? { installation: 'Other.Host' } : mode === 'asset' ? { asset: 'extension/other.json' } : {});
    if (mode === 'manifest') entries = entries.filter(([name]) => name !== 'extension.vsixmanifest');
    if (mode === 'types') entries = entries.filter(([name]) => name !== '[Content_Types].xml');
    if (mode === 'malformed') entries[0][1] = '<broken>';
    const file = await zipFixture(sandbox, [['extension/package.json', '{}'], ...entries]);
    await assert.rejects(extractCandidate(file, path.join(sandbox, 'extracted')), /XML|Unexpected|Unclosed|InstallationTarget|package manifest asset/u);
  }
});

test('qualifier rejects mismatched container metadata before launching hosts', async t => {
  for (const patch of [{ version: 'other' }, { extensionId: 'other.pie' }, { extensionId: 'pie.other' }, { target: 'universal' }, { target: 'linux-x64' }]) {
    const f = await candidateFixture(t, { extractCandidate: async () => ({ ...candidateIdentity, ...patch }) });
    await assert.rejects(qualifyDelivery({ vsix: path.join(os.tmpdir(), 'candidate.vsix') }, undefined, f.dependencies), /VSIX container .* mismatch/u);
    assert.equal(f.stages.length, 0);
    await assertNoSuccessEvidence(f);
  }
});

test('candidate helper fingerprints bytes and rejects malformed package/build identity', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-vsix-identity-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const file = path.join(sandbox, 'candidate.vsix');
  await writeFile(file, 'candidate bytes');
  assert.deepEqual(await fingerprintCandidate(file), { sha256: createHash('sha256').update('candidate bytes').digest('hex'), size: 15 });
  await assert.rejects(fingerprintCandidate(sandbox), /regular nonsymlink/u);
  await mkdir(path.join(sandbox, 'out/webview/panel'), { recursive: true });
  const valid = { publisher: 'pie', name: 'pie', main: './runtime/bootstrap.cjs', version: '1.0.0' };
  for (const patch of [{ publisher: 'other' }, { name: 'other' }, { main: './out/main.js' }, { version: '' }]) {
    await writeFile(path.join(sandbox, 'package.json'), JSON.stringify({ ...valid, ...patch }));
    await assert.rejects(verifyCandidateIdentity(sandbox), /Invalid candidate package identity/u);
  }
  await writeFile(path.join(sandbox, 'package.json'), JSON.stringify(valid));
  for (const [build, panel] of [['malformed', 'malformed'], ['a'.repeat(20), 'b'.repeat(20)]]) {
    await writeFile(path.join(sandbox, 'out/pie-build-id.txt'), build);
    await writeFile(path.join(sandbox, 'out/webview/panel/pie-build-id.txt'), panel);
    await assert.rejects(verifyCandidateIdentity(sandbox), /matching 20-hex/u);
  }
});

async function fixture(t, overrides = {}) {
  const packageRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'pie-qualification-unit-')));
  // Unit doubles launch no children, so their temp files are always safe to remove.
  t.after(() => rm(packageRoot, { recursive: true, force: true }));
  const events = [];
  const stages = [];
  const dependencies = {
    root,
    env: { NODE_TEST_CONTEXT: 'child-v8', PIE_AGENT_PROCESS_ID: 'parent' },
    status: message => events.push(message),
    resolveBrowserExecutable: async () => { events.push('browser-resolve'); return process.execPath; },
    createPackage: async () => { events.push('create'); return packageRoot; },
    verifyRuntime: async artifact => { events.push(`verify:${artifact}`); },
    verifyCandidateIdentity: async () => ({}),
    copySkeleton: async () => { events.push('copy'); },
    remove: async directory => { assert.equal(directory, packageRoot); events.push('remove'); },
    runStage: async (stage, options) => { stages.push({ stage, options }); events.push(stage.name); return confirmed; },
    ...overrides,
  };
  return { packageRoot, dependencies, events, stages };
}

test('managed CLI selection requires an explicit pair and build runtime, but exact VSIX uses extracted runtime', () => {
  const stageRoot = path.join(os.tmpdir(), 'external-managed-stage');
  const receiptPath = path.join(os.tmpdir(), 'external-managed-proof.json');
  const artifactDir = path.join(os.tmpdir(), 'selected-runtime');
  const vsix = path.join(os.tmpdir(), 'candidate.vsix');
  const pair = ['--managed-stage', stageRoot, '--managed-qualification-receipt', receiptPath];
  assert.deepEqual(parseQualificationArgs(['--pi-runtime', artifactDir, ...pair]), { artifactDir, managedIntegration: { stageRoot, receiptPath } });
  assert.deepEqual(parseQualificationArgs(['--vsix', vsix, ...pair]), { vsix, managedIntegration: { stageRoot, receiptPath } });
  for (const args of [pair, ['--pi-runtime', artifactDir, '--managed-stage', stageRoot], ['--vsix', vsix, ...pair, '--managed-stage', stageRoot], ['--vsix', vsix, '--managed-stage', 'relative', '--managed-qualification-receipt', receiptPath]]) assert.throws(() => parseQualificationArgs(args));
});

test('managed private build forwards proof and verifies payload before delivered-host tests', async t => {
  const managedIntegration = { stageRoot: path.join(os.tmpdir(), 'managed-stage'), receiptPath: path.join(os.tmpdir(), 'managed-proof.json') };
  const artifactDir = path.join(os.tmpdir(), 'runtime');
  const bindings = { runtimeIdentity: 'runtime', closureInventorySha256: 'closure', qualificationRecipeSha256: 'recipe' };
  const seen = [];
  const f = await fixture(t, { verifyCandidateIdentity: async (destination, options) => { seen.push({ destination, options }); return { managedIntegration: bindings }; } });
  const result = await qualifyDelivery({ artifactDir, managedIntegration }, undefined, f.dependencies);
  const build = f.stages.find(x => x.stage.name === 'delivery-build');
  assert.deepEqual(build.stage.args.slice(-4), ['--managed-stage', managedIntegration.stageRoot, '--managed-qualification-receipt', managedIntegration.receiptPath]);
  assert.deepEqual(seen, [{ destination: f.packageRoot, options: { managedIntegration } }]);
  assert.deepEqual(result.managedIntegration, bindings);
  assert.equal(JSON.stringify(result).includes(managedIntegration.receiptPath), false);
});

test('exact managed VSIX forwards external proof and preserves payload rejection', async t => {
  const managedIntegration = { stageRoot: path.join(os.tmpdir(), 'managed-stage'), receiptPath: path.join(os.tmpdir(), 'managed-proof.json') };
  const vsix = path.join(os.tmpdir(), 'candidate.vsix');
  let calls = 0;
  const f = await candidateFixture(t, { verifyCandidateIdentity: async (destination, options) => {
    calls++;
    assert.equal(destination, f.packageRoot);
    assert.deepEqual(options, { managedIntegration });
    throw Error('managed marker invalid');
  } });
  await assert.rejects(qualifyDelivery({ vsix, managedIntegration }, undefined, f.dependencies), /managed marker invalid/);
  assert.equal(calls, 1);
});

test('strict options: help, absolute runtime, duplicate/missing/unknown rejection', () => {
  assert.deepEqual(parseQualificationArgs([]), { artifactDir: undefined });
  assert.deepEqual(parseQualificationArgs(['--help']), { help: true });
  assert.deepEqual(parseQualificationArgs(['-h']), { help: true });
  const artifact = path.join(os.tmpdir(), 'caller-runtime');
  assert.deepEqual(parseQualificationArgs([`--pi-runtime=${artifact}`]), { artifactDir: path.resolve(artifact) });
  assert.deepEqual(parseQualificationArgs(['--pi-runtime', artifact]), { artifactDir: path.resolve(artifact) });
  for (const args of [['--pi-runtime'], ['--pi-runtime='], ['--pi-runtime', 'relative'], ['--publish'], ['--help', '--publish'], ['--pi-runtime', artifact, '--pi-runtime', artifact]]) {
    assert.throws(() => parseQualificationArgs(args));
  }
});

test('stage plan delegates build and native tests without publishing/installing or SDK override', () => {
  const packageRoot = path.join(os.tmpdir(), 'qualification-package');
  const artifact = path.join(os.tmpdir(), 'caller-runtime');
  const stages = qualificationStages(root, packageRoot, artifact, process.execPath);
  assert.equal(stages.length, 2);
  assert.deepEqual(stages[0].args, [path.join(root, 'scripts/build/build.mjs'), '--delivery', '--no-sync', '--output-dir', path.join(packageRoot, 'out'), '--pi-runtime', artifact]);
  assert.deepEqual(stages[1].args, [path.join(root, 'scripts/verification/test-node.mjs'), 'scripts/verification/test/delivered-hosts.test.mjs']);
  assert.deepEqual(stages[1].env, { PIE_RUN_DELIVERED_HOST_TESTS: '1', PIE_RUN_DELIVERED_BROWSER_TESTS: '1', PIE_DELIVERED_HOST_ROOT: packageRoot, PIE_DELIVERED_BROWSER_EXECUTABLE: process.execPath });
});

test('private qualification build forwards its selected prepared Node runtime', () => {
  const packageRoot = path.join(os.tmpdir(), 'qualification-package');
  const nodeRuntimeDir = path.join(os.tmpdir(), 'prepared-node-runtime');
  const stages = qualificationStages(root, packageRoot, undefined, undefined, undefined, nodeRuntimeDir);
  assert.deepEqual(stages[0].args, [path.join(root, 'scripts/build/pi-workspace.mjs')]);
  assert.deepEqual(stages[1].args, [path.join(root, 'scripts/build/build.mjs'), '--delivery', '--no-sync', '--output-dir', path.join(packageRoot, 'out'), '--node-runtime', nodeRuntimeDir]);
});

test('default compilation precedes new package, build, host/browser lane and confirmed cleanup', async t => {
  const f = await fixture(t);
  const result = await qualifyDelivery({}, undefined, f.dependencies);
  assert.equal(result.code, 0);
  assert.deepEqual(f.events.filter(event => ['pi-compile', 'create', 'copy', 'delivery-build', 'delivered-hosts', 'remove'].includes(event)), ['pi-compile', 'create', 'copy', 'delivery-build', 'delivered-hosts', 'remove']);
  assert.equal(f.stages[0].stage.args[0], path.join(root, 'scripts/build/pi-workspace.mjs'));
  assert.equal(f.stages[1].stage.args.includes('--pi-runtime'), false);
  assert.equal(f.stages[2].options.env.NODE_TEST_CONTEXT, undefined);
  assert.equal(f.stages[2].stage.env.PIE_DELIVERED_BROWSER_EXECUTABLE, process.execPath);
  assert.equal(f.stages[0].stage.env?.PIE_DELIVERED_BROWSER_EXECUTABLE, undefined);
  assert.ok(f.events.indexOf('browser-resolve') < f.events.indexOf('pi-compile'));
  assert.ok(f.events.some(event => event.includes('NOT installed/published')));
});

test('explicit runtime is verified/reused without compilation or caller deletion', async t => {
  const f = await fixture(t);
  const artifactDir = path.join(os.tmpdir(), 'caller-artifact');
  await qualifyDelivery({ artifactDir }, undefined, f.dependencies);
  assert.ok(f.events.includes(`verify:${artifactDir}`));
  assert.ok(f.events.indexOf('browser-resolve') < f.events.indexOf(`verify:${artifactDir}`));
  assert.equal(f.stages[1].stage.env.PIE_DELIVERED_BROWSER_EXECUTABLE, process.execPath);
  assert.deepEqual(f.stages.map(item => item.stage.name), ['delivery-build', 'delivered-hosts']);
  assert.deepEqual(f.stages[0].stage.args.slice(-2), ['--pi-runtime', artifactDir]);
  assert.equal(f.events.filter(event => event === 'remove').length, 1);
});

test('missing or invalid browser fails before compilation, artifact verification or package creation', async t => {
  for (const explicit of [false, true]) {
    for (const executable of ['relative-chromium', path.join(os.tmpdir(), 'pie-missing-browser', 'chrome.exe'), os.tmpdir()]) {
      const f = await fixture(t, { resolveBrowserExecutable: async () => executable });
      await assert.rejects(qualifyDelivery(explicit ? { artifactDir: path.join(os.tmpdir(), 'runtime') } : {}, undefined, f.dependencies), /Delivered-browser blocker/u);
      assert.equal(f.stages.length, 0);
      assert.equal(f.events.includes('create'), false);
      assert.equal(f.events.some(event => event.startsWith('verify:')), false);
      assert.equal(f.events.includes('remove'), false);
    }
  }
  assert.equal(await validateBrowserExecutable(process.execPath), process.execPath);
});

test('failed verification or compilation never creates a delivery package', async t => {
  for (const explicit of [false, true]) {
    const f = await fixture(t, {
      verifyRuntime: async () => { throw new Error('bad artifact'); },
      runStage: async () => ({ ...confirmed, code: 1 }),
    });
    await assert.rejects(qualifyDelivery(explicit ? { artifactDir: path.join(os.tmpdir(), 'runtime') } : {}, undefined, f.dependencies));
    assert.equal(f.events.includes('create'), false);
    assert.equal(f.events.includes('remove'), false);
  }
});

test('build failure/uncertainty and nested tests 125/failure retain package and stop sequencing', async t => {
  for (const [failedStage, result] of [
    ['delivery-build', { ...confirmed, code: 1 }],
    ['delivery-build', { ...confirmed, outerConfirmed: false }],
    ['delivery-build', { ...confirmed, innerConfirmed: false }],
    ['delivered-hosts', { ...confirmed, code: 125 }],
    ['delivered-hosts', { ...confirmed, code: 1 }],
    ['delivered-hosts', { ...confirmed, innerConfirmed: false }],
  ]) {
    const names = [];
    const f = await fixture(t, { runStage: async stage => { names.push(stage.name); return stage.name === failedStage ? result : confirmed; } });
    await assert.rejects(qualifyDelivery({}, undefined, f.dependencies), /retained/u);
    assert.equal(f.events.includes('remove'), false);
    assert.ok(f.events.some(event => event.includes(`RETAINED ${f.packageRoot}`)));
    assert.equal(names.at(-1), failedStage);
  }
});

test('launcher exception or cancellation during a stage retain even after outer extinction', async t => {
  for (const mode of ['throw', 'abort']) {
    const controller = new AbortController();
    const f = await fixture(t, { runStage: async stage => {
      if (stage.name === 'delivery-build') {
        if (mode === 'throw') throw new Error('watchdog failed');
        controller.abort();
      }
      return confirmed;
    } });
    await assert.rejects(qualifyDelivery({}, controller.signal, f.dependencies));
    assert.equal(f.events.includes('remove'), false);
    assert.ok(f.events.some(event => event.includes('RETAINED')));
  }
});

test('pre-aborted invocation creates no package; skeleton failure before child safely removes owned package', async t => {
  const controller = new AbortController();
  controller.abort();
  const f = await fixture(t);
  await assert.rejects(qualifyDelivery({}, controller.signal, f.dependencies));
  assert.equal(f.events.includes('create'), false);
  const failed = await fixture(t, { copySkeleton: async () => { throw new Error('copy failed'); } });
  await assert.rejects(qualifyDelivery({}, undefined, failed.dependencies), /copy failed/u);
  assert.equal(failed.events.includes('remove'), true);
});

test('skeleton copies only manifest, runtime CJS and icon, never an existing out', async t => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'pie-skeleton-unit-'));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const source = path.join(sandbox, 'application/hosts/vscode');
  const destination = path.join(sandbox, 'package');
  for (const directory of ['runtime', 'media', 'out']) await mkdir(path.join(source, directory), { recursive: true });
  await mkdir(path.join(sandbox, 'lib/windows-runtime-lock'), { recursive: true });
  await mkdir(destination);
  for (const [name, bytes] of Object.entries({ 'package.json': '{}', 'runtime/bootstrap.cjs': 'bootstrap', 'runtime/helper.cjs': 'helper', 'runtime/ignored.txt': 'ignored', 'runtime/windows-runtime-lock.cjs': 'checkout adapter', 'media/icon.svg': '<svg/>', 'out/stale.js': 'stale' })) await writeFile(path.join(source, name), bytes);
  await writeFile(path.join(sandbox, 'lib/windows-runtime-lock/windows-runtime-lock.cjs'), 'neutral primitive');
  await copyPackageSkeleton(sandbox, destination);
  assert.deepEqual((await readdir(destination)).sort(), ['media', 'package.json', 'runtime']);
  assert.deepEqual((await readdir(path.join(destination, 'runtime'))).sort(), ['bootstrap.cjs', 'helper.cjs', 'windows-runtime-lock.cjs']);
  assert.equal(await readFile(path.join(destination, 'media/icon.svg'), 'utf8'), '<svg/>');
  assert.equal(await readFile(path.join(destination, 'runtime/windows-runtime-lock.cjs'), 'utf8'), 'neutral primitive');
});

// Regression: the checkout-relative forwarding adapter cannot satisfy its
// require once the runtime CJS files are relocated outside the repository.
// The packaged startup loader must load the standalone neutral lock owner
// bytes so every relative require resolves inside the delivery package.
test('relocated packaged runtime requires stay in the package via the neutral lock primitive', async t => {
  const destination = await mkdtemp(path.join(os.tmpdir(), 'pie-skeleton-relocated-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  await copyPackageSkeleton(root, destination);
  const packagedRuntime = path.join(destination, 'runtime');
  assert.deepEqual(await readFile(path.join(packagedRuntime, 'windows-runtime-lock.cjs')),
    await readFile(path.join(root, 'lib/windows-runtime-lock/windows-runtime-lock.cjs')));
  assert.notDeepEqual(await readFile(path.join(packagedRuntime, 'windows-runtime-lock.cjs')),
    await readFile(path.join(root, 'application/hosts/vscode/runtime/windows-runtime-lock.cjs')));
  // Relative requires in the packaged runtime CJS must resolve within the
  // package; the checkout wrapper resolves outside and fails relocated.
  for (const name of ['bootstrap.cjs', 'runtime-generations.cjs', 'windows-runtime-lock.cjs']) {
    const packaged = await readFile(path.join(packagedRuntime, name), 'utf8');
    for (const [, request] of packaged.matchAll(/require\('([^']+)'\)/gu)) {
      if (!request.startsWith('./')) continue;
      const resolved = path.resolve(packagedRuntime, request);
      assert.ok(resolved.startsWith(packagedRuntime + path.sep), `packaged ${name} require ${request} stays in the package`);
      await assert.ok((await readFile(resolved)).length > 0);
    }
  }
  // End-to-end relocated require, without the checkout: the packaged startup
  // helper loads and exports its lock API (exactly the qualification fixture path).
  const relocated = createRequire(path.join(packagedRuntime, 'relocated-require.cjs'))('./runtime-generations.cjs');
  assert.equal(typeof relocated.resolveRuntimeGeneration, 'function');
});

test('no-close abort/timeout awaits identity-safe watchdog settlement, unreferences child and retains package', { timeout: 3_000 }, async t => {
  for (const reason of ['abort', 'timeout']) {
    const controller = new AbortController();
    let terminated = false;
    let settled = false;
    let unreferenced = false;
    let watchdog;
    const child = new EventEmitter();
    child.unref = () => { assert.equal(settled, true); unreferenced = true; };
    child.kill = () => assert.fail('qualifier must not add a PID-based kill fallback');
    const f = await fixture(t, { runStage: async (stage, options) => {
      if (stage.name !== 'delivery-build') return confirmed;
      const result = await runQualificationStage(stage, options, {
        spawn: (_command, _args, spawnOptions) => {
          assert.equal(spawnOptions.stdio, 'inherit');
          if (reason === 'abort') setTimeout(() => controller.abort(), 10);
          return child; // intentionally never emits close
        },
        watchChildProcess: (owned, watchOptions) => {
          watchdog = watchChildProcess(owned, {
            ...watchOptions, timeoutMs: reason === 'timeout' ? 10 : 0,
            killTree: async captured => {
              assert.equal(captured, child);
              terminated = true;
              await new Promise(resolve => setTimeout(resolve, 20));
              settled = true;
              return { gone: false, survivors: [42], diagnostics: ['creation identity unavailable; kill skipped'] };
            },
          });
          return watchdog;
        },
      });
      assert.deepEqual(result, { code: 1, outerConfirmed: false, innerConfirmed: false });
      return result;
    } });
    await assert.rejects(qualifyDelivery({}, controller.signal, f.dependencies), /retained/u);
    assert.equal(terminated, true);
    assert.equal(settled, true);
    assert.equal(unreferenced, true);
    assert.equal(watchdog.aborted, reason === 'abort');
    assert.equal(watchdog.timedOut, reason === 'timeout');
    assert.equal(child.listenerCount('close'), 0);
    assert.equal(f.events.includes('remove'), false);
    assert.ok(f.events.some(event => event.includes(`RETAINED ${f.packageRoot}`)));
  }
});

test('stage watchdog: isolated spawn, settle required, nested 125 and interruption cannot confirm inner completion', async () => {
  for (const scenario of [
    { code: 0, gone: true, safe: true },
    { code: 125, gone: true, safe: false },
    { code: 1, gone: true, safe: false },
    { code: 0, gone: false, safe: false },
    { code: 0, gone: true, aborted: true, safe: false },
    { code: 0, gone: true, timedOut: true, safe: false },
    { code: null, gone: true, childSignal: 'SIGTERM', safe: false },
  ]) {
    let settled = false;
    const result = await runQualificationStage({ name: 'delivered-hosts', args: ['authority.mjs'], env: { TEST: '1' } }, { root, env: {} }, {
      spawn: (command, args, options) => {
        assert.equal(command, process.execPath);
        assert.deepEqual(args, ['authority.mjs']);
        assert.equal(options.detached, process.platform !== 'win32');
        assert.equal(options.env.TEST, '1');
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', scenario.code, scenario.childSignal));
        return child;
      },
      watchChildProcess: () => ({ aborted: scenario.aborted, timedOut: scenario.timedOut, settle: async () => { settled = true; return { gone: scenario.gone, survivors: [] }; } }),
    });
    assert.equal(settled, true);
    assert.equal(result.code === 0 && result.outerConfirmed && result.innerConfirmed, scenario.safe);
  }
});
