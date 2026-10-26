// Read-only qualification proof verification. Never imports staged package code.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { verifyPreparedManagedClosure } from '../../lib/managed-packages/prepare-managed-closure.mjs';
import { verifyPiRuntimeArtifact } from '../../lib/pi-runtime/artifact.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export const hash = value => createHash('sha256').update(value).digest('hex');
export const inside = (a, b) => { const r = path.relative(a, b); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)); };
export const check = (condition, message) => { if (!condition) throw new Error(message); };
export const recipe = 'managed-integrations-provider-free-v1';
const sourceNames = ['fixtures/managed-integrations-child.mjs', 'fixtures/managed-recheck-child.mjs', 'fixtures/managed-integrations-static.mjs', 'fixtures/keyring-denied-facade.mjs', 'fixtures/image-worker-guard.mjs', 'fixtures/image-worker-preload.mjs', 'qualify-managed-integrations.mjs', 'managed-qualification-receipt.mjs'];
export async function qualificationInputs(checkout = root) {
  const inputs = {};
  for (const name of sourceNames) inputs[name] = hash(await readFile(path.join(checkout, 'scripts', 'verification', name)));
  return inputs;
}
export function qualificationRecipeDigest(inputs) {
  check(inputs && typeof inputs === 'object' && !Array.isArray(inputs) && isDeepStrictEqual(Object.keys(inputs).sort(), [...sourceNames].sort()) && Object.values(inputs).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)), 'Invalid qualification recipe inputs');
  return hash(JSON.stringify(Object.keys(inputs).sort().map(key => [key, inputs[key]])));
}
export async function qualificationSnapshot(stageRoot, artifactDir, deps = {}) {
  const target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
  const stage = await (deps.verifyStage ?? verifyPreparedManagedClosure)(stageRoot, { requireReady: false });
  check(await realpath(stage.root) === stageRoot, 'Stage canonical root mismatch');
  check(stage.receipt.disposition?.name === 'omit-optional-canvas-3.2.3' && stage.receipt.pendingOptionalBuilds.length === 0, 'Expected omitted canvas disposition and zero pending builds');
  const receiptSha256 = hash(await readFile(path.join(stageRoot, 'closure-receipt.json')));
  const runtime = await (deps.verifyRuntime ?? verifyPiRuntimeArtifact)(artifactDir, { target });
  check(await realpath(runtime.artifactDir) === artifactDir && isDeepStrictEqual(runtime.manifest.target, target), 'Runtime canonical root or target mismatch');
  return { stage, runtime, binding: { receiptSha256, inventorySha256: stage.receipt.inventorySha256, runtimeIdentity: runtime.identity, target: runtime.manifest.target } };
}
export async function resolveFile(stage, from, name, entry) {
  for (let dir = from; inside(stage.root, dir); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name, entry);
    if (!stage.receipt.inventory.some(item => path.resolve(stage.root, item.path) === candidate)) continue;
    const canonical = await realpath(candidate);
    check(canonical === candidate && inside(stage.root, canonical), 'Redirected staged entry');
    return canonical;
  }
  throw new Error(`Missing inventoried ${name}/${entry}`);
}
export function validateReport(name, report, stage) {
  check(report?.ok === true && Array.isArray(report.denied) && report.denied.length === 0, `${name}: failed or denied operations`);
  if (name === 'managed-integrations') {
    check(Array.isArray(report.errors) && report.errors.length === 0 && report.identity === true &&
      Array.isArray(report.denyDiagnostics) && report.denyDiagnostics.length === 0 &&
      ['esmWrapper', 'cjsWrapper', 'cjsNative'].every(key => report.moduleExportLoad?.[key] === true) &&
      ['esmDefault', 'esmNamed', 'cjsWrapper', 'cjsNative'].every(key => report.facadeBinding?.[key] === true) &&
      Array.isArray(report.extensions) && report.extensions.length === 3 && report.extensions.every(x => typeof x?.path === 'string' && path.isAbsolute(x.path) && Array.isArray(x.tools)) &&
      isDeepStrictEqual(report.extensions.map(x => x.tools), [['web_search', 'source_check', 'fetch_content', 'get_search_content'], ['mcpScript', 'mcp'], []]) &&
      isDeepStrictEqual(report.requests, ['https://fixture.example/article', 'https://fixture.example/static.pdf', 'https://fixture.example/static.png']) &&
      Array.isArray(report.results) && report.results.length === 3 && report.results.every((x, i) => x && !x.error && x.url === report.requests[i]) &&
      report.results[0].content?.includes('Qualification paragraph') && report.results[1].content?.includes('saved to: ') && report.results[2].thumbnail &&
      Array.isArray(report.imageWorker) && report.imageWorker.length === 1 && report.imageWorker.every(x => x.messages === 1 && x.results === 1 && x.exitCode === 0 && x.exited === true && Array.isArray(x.errors) && x.errors.length === 0) &&
      Array.isArray(report.legacySmoke) && report.legacySmoke.length === 2 &&
      report.legacySmoke.every((x, i) => x.disabled === Boolean(i) && x.scope === 'project' && x.suppressed === true && Array.isArray(x.errors) && x.errors.length === 0), 'Incomplete managed integration report');
    check(stage && report.extensions[0].path === path.join(stage.packages['pi-web-access'], 'index.ts') && report.extensions[1].path === path.join(stage.packages['pi-mcp-adapter'], 'index.ts') && !inside(stage.root, report.extensions[2].path), 'Managed factory stage binding mismatch');
  } else {
    check(name === 'managed-recheck' && !report.error && report.result?.status === 'safe' && report.result.source === '^a+$' && report.result.flags === '' && report.result.checker === 'automaton' && report.result.complexity?.type === 'linear' && Array.isArray(report.observed) && report.observed.length === 1 &&
      typeof report.observed[0].executable === 'string' && /^[a-f0-9]{64}$/.test(report.observed[0].sha256), 'Incomplete recheck report');
  }
}
export async function validateRecheck(stage, report) {
  const executable = await resolveFile(stage, stage.root, 'recheck-windows-x64', 'recheck.exe');
  check(report.observed[0].executable === executable && report.observed[0].sha256 === hash(await readFile(executable)), 'Recheck executable identity mismatch');
}

/** Read-only proof consumption; never starts a process or imports staged code.
 * Requires the original canonical stage, verified selected runtime, and retained
 * external receipt/report files. Returns canonical stage/runtime verification
 * results plus the validated receipt and deterministic recipe digest.
 * An identical runtime payload may be relocated; acceptance here is NOT a
 * relocation/runtime-execution qualification. No readiness or promotion change.
 * This checks local evidence consistency, not a cryptographic signature.
 * deps: verifyStage(root, {requireReady:false}), verifyRuntime(root, {target}),
 * root (recipe source checkout). No dependency acquisition or global lookup.
 */
export async function verifyManagedIntegrationQualification({ stageRoot, artifactDir, receiptPath }, deps = {}) {
  for (const value of [stageRoot, artifactDir, receiptPath]) check(typeof value === 'string' && path.isAbsolute(value), 'Explicit absolute paths required');
  [stageRoot, artifactDir, receiptPath] = await Promise.all([stageRoot, artifactDir, receiptPath].map(value => realpath(value)));
  const evidenceDir = path.dirname(receiptPath);
  for (const owned of [stageRoot, artifactDir]) check(!inside(owned, evidenceDir) && !inside(evidenceDir, owned), 'Evidence must be external and disjoint');
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  check(receipt.schemaVersion === 1 && receipt.passed === true && receipt.recipe === recipe, 'Invalid qualification receipt');
  const expected = await qualificationInputs(deps.root ?? root);
  const qualificationRecipeSha256 = qualificationRecipeDigest(receipt.inputs);
  check(isDeepStrictEqual(receipt.inputs, expected) && (receipt.qualificationRecipeSha256 === undefined || receipt.qualificationRecipeSha256 === qualificationRecipeSha256), 'Qualification recipe mismatch');
  const { stage, runtime, binding } = await qualificationSnapshot(stageRoot, artifactDir, deps);
  check(receipt.stage?.root === stageRoot && await realpath(receipt.stage.root) === stageRoot && receipt.stage.receiptSha256 === binding.receiptSha256 && receipt.stage.inventorySha256 === binding.inventorySha256, 'Qualification stage binding mismatch');
  check(typeof receipt.runtime?.artifactDir === 'string' && path.isAbsolute(receipt.runtime.artifactDir) && isDeepStrictEqual(receipt.runtime.identity, binding.runtimeIdentity) && isDeepStrictEqual(receipt.runtime.target, binding.target), 'Qualification runtime binding mismatch');
  check(receipt.teardown?.outerConfirmed === true && receipt.teardown.innerConfirmed === true && Array.isArray(receipt.children) && receipt.children.length === 2, 'Incomplete qualification teardown');
  for (const [index, name] of ['managed-integrations', 'managed-recheck'].entries()) {
    const child = receipt.children[index];
    check(child?.name === name && child.completion?.code === 0 && child.completion.outerConfirmed === true && child.completion.innerConfirmed === true, 'Invalid qualification child completion');
    check(typeof child.resultPath === 'string' && path.isAbsolute(child.resultPath) && inside(evidenceDir, child.resultPath) && child.resultPath !== receiptPath && await realpath(child.resultPath) === child.resultPath, 'Invalid report path');
    const bytes = await readFile(child.resultPath);
    check(hash(bytes) === child.resultSha256, 'Report hash mismatch');
    const report = JSON.parse(bytes.toString('utf8'));
    check(isDeepStrictEqual(report, child.report), 'Report correspondence mismatch');
    validateReport(name, report, stage);
    if (name === 'managed-recheck') await validateRecheck(stage, report);
  }
  return { stage, runtime, receipt, qualificationRecipeSha256 };
}
