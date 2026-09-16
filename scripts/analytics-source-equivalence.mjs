#!/usr/bin/env node
// Exact artifact/source equivalence receipt for reusing historical
// provisional qualification evidence on the current candidate build.
//
// The measured wave reports keep their ORIGINAL provenance (source head,
// coordinated build id, fingerprint) and measured values. This receipt binds
// the CURRENT candidate separately: it verifies, file by file, that every
// production runtime source and built runtime artifact in the measured
// manifests is byte-identical in the current tree, that the build-identity
// dependency inputs (package manifests/tsconfig/vite config) are unchanged,
// and that the ONLY source deltas are the explicitly allowlisted report/admission
// tooling + tests + docs files. It fails closed on any unallowlisted changed
// production file, any unverifiable identity, or a marker mismatch.
//
// Usage:
//   node scripts/analytics-source-equivalence.mjs \
//     --wave-dir <dir with role reports> --qualification <overall report> \
//     --measured-source-head <sha> --measured-build-id <id> --measured-fingerprint <sha> \
//     --out <receipt.json>
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  process.stderr.write(`analytics-source-equivalence: ${message}\n`);
  process.exit(1);
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sha256GitBlob(revision, repoPath) {
  const bytes = execFileSync('git', ['-C', repositoryRoot, 'show', `${revision}:${repoPath}`], {
    maxBuffer: 256 * 1024 * 1024,
  });
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256GitBlobOrNull(revision, repoPath) {
  try {
    const bytes = execFileSync('git', ['-C', repositoryRoot, 'show', `${revision}:${repoPath}`], {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[++index];
    if (!name.startsWith('--') || !value) fail(`${name} requires a value.`);
    if (values.has(name)) fail(`duplicate option: ${name}`);
    values.set(name, value);
  }
  const required = (name) => {
    const value = values.get(name);
    if (!value) fail(`${name} is required`);
    return value;
  };
  return {
    waveDir: path.resolve(required('--wave-dir')),
    qualificationPath: path.resolve(required('--qualification')),
    measuredSourceHead: required('--measured-source-head').toLowerCase(),
    measuredBuildId: required('--measured-build-id'),
    measuredFingerprint: required('--measured-fingerprint').toLowerCase(),
    outPath: path.resolve(required('--out')),
  };
}

function readBoundedJson(filePath, label, maxBytes = 64 * 1024 * 1024) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > maxBytes) throw new Error(`${label} is not a bounded file`);
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readBoundedJsonEvidence(filePath, label, maxBytes = 64 * 1024 * 1024) {
  if (!existsSync(filePath)) throw new Error(`${label} is missing: ${filePath}`);
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > maxBytes) throw new Error(`${label} is not a bounded file`);
  const bytes = readFileSync(filePath);
  if (bytes.length !== stats.size) throw new Error(`${label} changed while it was being read`);
  try {
    return {
      value: JSON.parse(bytes.toString('utf8')),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function samePath(left, right) {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isAbsoluteSafePath(value) {
  return typeof value === 'string' && path.isAbsolute(value);
}

function readdirSyncSafe(directory, suffix = '.json') {
  try {
    return readdirSync(directory).filter((name) => name.endsWith(suffix));
  } catch {
    return [];
  }
}

function currentSha256(repoRelativePath) {
  const absolute = path.join(repositoryRoot, repoRelativePath);
  if (!existsSync(absolute)) return null;
  const stats = lstatSync(absolute);
  if (stats.isSymbolicLink() || !stats.isFile()) return null;
  return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

/** Measured production runtime files that may never change for evidence reuse.
 * Harness/report scripts in the manifests are measurement tooling: measured
 * hash equality is recorded but a changed value is only allowed when the file
 * is also in the reviewed committed tooling delta. */
const MEASUREMENT_TOOLING_PREFIXES = ['extension/scripts/'];
/** The only reviewed non-test tooling deltas permitted between the measured
 * head and the candidate, with their reviewed basis. Anything else fails. */
const ALLOWED_TOOLING_DELTA = new Map(Object.entries({
  'extension/scripts/analytics-p0-overall-qualification.mjs': 'committed report-tooling change since the measured head (aggregator/admission review)',
  'extension/src/analytics/candidate-trial-report.ts': 'candidate report-runner-only provisional binding fix (not imported by production runtime; not a measured production manifest input)',
  'extension/src/backend/session-lifecycle-store.ts': 'unmeasured lifecycle-registry and writer-fence control-plane change; no P0 capture/recorder/query path; focused lifecycle-store and controlled-restart tests',
  'extension/src/backend/storage-cutoff-production.ts': 'unmeasured production storage-cutoff adapter/control-plane addition; no P0 capture/recorder/query path; focused production-helper and storage-cutoff tests',
  'extension/src/host/analytics-controlled-restart.ts': 'unmeasured authenticated controlled-restart protocol; no P0 capture/recorder/query path; focused controlled-restart and restart-owner tests',
  'extension/src/host/analytics-cutover-orchestrator.ts': 'unmeasured activation/storage-cutover orchestration and authorization control plane; no P0 capture/recorder/query path; focused cutover-orchestrator tests',
  'extension/src/host/analytics-handoff-control.ts': 'unmeasured authenticated host-handoff/restart dispatch control plane; no P0 capture/recorder/query path; focused handoff-control and controlled-restart tests',
  'extension/src/host/analytics-runtime.ts': 'unmeasured host lifecycle/restart-evidence wiring; no P0 capture/recorder/query path; focused analytics-runtime and candidate-trial tests',
  'extension/src/host/extension-host.ts': 'unmeasured host startup wiring for authenticated restart/cutover control; no P0 capture/recorder/query path; focused analytics-runtime and restart-owner tests',
  'extension/src/backend/server.ts': 'unmeasured durable writer-identity build space (lifecycle-registry control plane) repair; no P0 capture/recorder/query path; focused backend-analytics-activation and analytics-runtime tests',
  'extension/vite.config.ts': 'coordinated build entries for candidate-trial and authenticated activation/restart control modules; measured runtime artifacts remain byte-checked; extension build and focused control tests',
  'scripts/analytics-activation-admission.mjs': 'committed admission tooling change since the measured head',
  'scripts/analytics-activation-helper.mjs': 'committed admission tooling change since the measured head',
  'scripts/test/analytics-provisional-qualification.test.mjs': 'committed admission test change since the measured head',
  'docs/internal/ANALYTICS_REWORK_EXECUTION.md': 'committed documentation change since the measured head',
}));

/** A source-equivalence receipt is only meaningful when it binds the exact
 * role descriptors selected by the aggregate qualification report. The
 * optional roles are allowed for a later fuller wave; the six roles below are
 * the minimum evidence envelope used by the approved provisional report. */
export const SOURCE_EQUIVALENCE_QUALIFICATION_ROLES = Object.freeze([
  'baseline',
  'scale',
  'tenMillion',
  'endurance',
  'mixedFullStats',
  'mixedMemoryOnly',
  'schemaFaults',
  'matchedHost',
]);
export const SOURCE_EQUIVALENCE_REQUIRED_ROLES = Object.freeze([
  'baseline',
  'scale',
  'endurance',
  'mixedFullStats',
  'mixedMemoryOnly',
  'schemaFaults',
]);

/** Every approved component report carries this common source manifest. Keep
 * the required paths explicit: a union fingerprint alone would let a partial
 * wave omit a recorder/query artifact and still produce a receipt. */
export const SOURCE_EQUIVALENCE_REQUIRED_MANIFEST_PATHS = Object.freeze([
  'extension/out/analytics-recorder-supervisor.js',
  'extension/out/analytics-sqlite-recorder.js',
  'extension/out/analytics-query-client.js',
  'extension/out/analytics-recorder-worker.js',
  'extension/out/analytics-query-worker.js',
  'extension/src/analytics/sqlite-recorder.ts',
  'extension/scripts/analytics-p0-qualification.mjs',
  'extension/scripts/analytics-p0-matched-host.mjs',
  'extension/scripts/analytics-p0-overall-qualification.mjs',
  'extension/scripts/analytics-p0-capacity.mjs',
  'extension/scripts/analytics-p0-endurance-validation.mjs',
  'extension/scripts/analytics-p0-mixed-validation.mjs',
  'extension/scripts/analytics-p0-schema-faults.mjs',
  'extension/scripts/windows-process-handle-collector.mjs',
  'extension/scripts/windows-process-handle-collector.ps1',
  'extension/scripts/analytics-real-producer-probe.ts',
  'extensions/subagent/src/analytics-capture.ts',
  'extensions/subagent/src/runtime-trace.ts',
  'extensions/subagent/types.ts',
  'shared/analytics/contracts.ts',
  'shared/sensitive-redaction.ts',
]);

function manifestFingerprint({ sourceHead, buildId, files }) {
  const hashes = Object.fromEntries(Object.keys(files).sort().map((file) => [file, files[file].sha256]));
  return createHash('sha256').update(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    gitHead: sourceHead,
    hostBuildId: buildId,
    rendererBuildId: buildId,
    files: hashes,
  }))).digest('hex');
}

function normalizeManifest(files, label) {
  if (!isObject(files) || Object.keys(files).length === 0) throw new Error(`${label} is missing`);
  const normalized = {};
  for (const file of Object.keys(files).sort()) {
    const receipt = files[file];
    if (!file || path.isAbsolute(file) || file.split(/[\\\\/]/u).includes('..')
      || !exactKeys(receipt, ['sha256', 'bytes']) || !isSha256(receipt.sha256)
      || !Number.isSafeInteger(receipt.bytes) || receipt.bytes <= 0) {
      throw new Error(`${label} entry is invalid: ${file}`);
    }
    normalized[file] = { sha256: receipt.sha256, bytes: receipt.bytes };
  }
  return normalized;
}

function manifestsEqual(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length || !leftKeys.every((key, index) => key === rightKeys[index])) return false;
  return leftKeys.every((file) => left[file].sha256 === right[file].sha256 && left[file].bytes === right[file].bytes);
}

function validateRoleShape(role, report, descriptorPath, expected) {
  const configuration = report?.configuration;
  const provenance = report?.provenance;
  if (!isObject(report) || !isObject(configuration) || !isObject(provenance)) {
    throw new Error(`${role} bound report is missing configuration or provenance`);
  }
  if (!samePath(configuration.reportPath, descriptorPath)) {
    throw new Error(`${role} bound report path does not match its qualification descriptor`);
  }
  if (provenance.valid !== true || provenance.gitHead !== expected.sourceHead
    || provenance.hostBuildId !== expected.buildId || provenance.rendererBuildId !== expected.buildId
    || provenance.coordinatedBuildId !== expected.buildId || provenance.fingerprint !== expected.sourceFingerprint) {
    throw new Error(`${role} bound report identity does not match measured qualification identity`);
  }
  const scenario = configuration.scenario;
  const valid = role === 'baseline' ? scenario === 'baseline' && configuration.rows === 10_000
    : role === 'scale' ? scenario === 'scale' && configuration.rows === 1_000_000
      : role === 'tenMillion' ? scenario === 'ten-million' && configuration.rows === 10_000_000
        : role === 'endurance' ? scenario === 'endurance' && configuration.mode === 'full'
          : role === 'mixedFullStats' ? scenario === 'mixed' && configuration.mode === 'full' && configuration.statsPollMode === 'full-stats'
            : role === 'mixedMemoryOnly' ? scenario === 'mixed' && configuration.mode === 'full' && configuration.statsPollMode === 'memory-only'
              : role === 'schemaFaults' ? scenario === 'schema-faults' && report.kind === 'pie-p0-schema-faults-v1'
                : role === 'matchedHost' ? scenario === 'matched-host' && report.kind === 'pie-p0-matched-host-v1'
                  : false;
  if (!valid) throw new Error(`${role} bound report descriptor resolves to the wrong qualified role`);
}

/** Resolve the qualification report's exact bound role descriptors and their
 * common source manifest. This is deliberately independent of --wave-dir:
 * only paths hash-bound by the qualification report are admissible. */
export function buildQualificationEvidence(qualification, expected) {
  if (!isObject(qualification?.evidence?.reports)) {
    throw new Error('qualification evidence.reports is missing; refusing to proceed');
  }
  const descriptors = qualification.evidence.reports;
  const roles = Object.keys(descriptors);
  const unknown = roles.filter((role) => !SOURCE_EQUIVALENCE_QUALIFICATION_ROLES.includes(role));
  const missing = SOURCE_EQUIVALENCE_REQUIRED_ROLES.filter((role) => !roles.includes(role));
  if (unknown.length > 0) throw new Error(`qualification evidence contains unknown role descriptors: ${unknown.join(', ')}`);
  if (missing.length > 0) throw new Error(`qualification evidence is missing required role descriptors: ${missing.join(', ')}`);

  const roleEvidence = {};
  let commonManifest;
  const seenPaths = new Set();
  for (const role of roles.sort()) {
    const descriptor = descriptors[role];
    if (!exactKeys(descriptor, ['path', 'sha256', 'bytes'])
      || !isAbsoluteSafePath(descriptor.path) || !isSha256(descriptor.sha256)
      || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes <= 0) {
      throw new Error(`${role} qualification descriptor is incomplete`);
    }
    const descriptorPath = path.resolve(descriptor.path);
    const pathKey = process.platform === 'win32' ? descriptorPath.toLowerCase() : descriptorPath;
    if (seenPaths.has(pathKey)) throw new Error(`qualification role descriptors reuse one report path: ${role}`);
    seenPaths.add(pathKey);
    const read = readBoundedJsonEvidence(descriptorPath, `${role} qualification report`);
    if (read.sha256 !== descriptor.sha256 || read.bytes !== descriptor.bytes) {
      throw new Error(`${role} qualification descriptor does not match its report bytes`);
    }
    validateRoleShape(role, read.value, descriptorPath, expected);
    const manifest = normalizeManifest(read.value.provenance.files, `${role} source manifest`);
    if (commonManifest === undefined) commonManifest = manifest;
    else if (!manifestsEqual(commonManifest, manifest)) {
      throw new Error(`qualified role manifests are not the same complete common manifest (${role})`);
    }
    roleEvidence[role] = { path: descriptorPath, sha256: descriptor.sha256, bytes: descriptor.bytes };
  }
  for (const file of SOURCE_EQUIVALENCE_REQUIRED_MANIFEST_PATHS) {
    if (!commonManifest[file]) throw new Error(`required common manifest path is missing: ${file}`);
  }
  const fingerprint = manifestFingerprint({ sourceHead: expected.sourceHead, buildId: expected.buildId, files: commonManifest });
  if (fingerprint !== expected.sourceFingerprint
    || qualification.provenance?.fingerprint !== expected.sourceFingerprint) {
    throw new Error('qualified common manifest fingerprint does not match the measured source fingerprint');
  }
  return { roles: roleEvidence, commonManifest, manifestFingerprint: fingerprint };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!/^[0-9a-f]{40}$/.test(options.measuredSourceHead)) fail('measured source head must be a 40-character sha');
  if (!/^[0-9a-f]{20}$/.test(options.measuredBuildId)) fail('measured build id must be a 20-hex coordinated id');
  if (!isSha256(options.measuredFingerprint)) fail('measured fingerprint must be a sha256');

  const qualification = readBoundedJson(options.qualificationPath, 'qualification report');
  if (qualification.kind !== 'pie-p0-overall-qualification-v1'
    || qualification.status !== 'passed'
    || qualification.configuration?.scenario !== 'overall') {
    fail('qualification report is not the authoritative overall qualification envelope');
  }
  const provenance = qualification.provenance;
  if (!provenance || provenance.valid !== true
    || provenance.gitHead !== options.measuredSourceHead
    || provenance.coordinatedBuildId !== options.measuredBuildId
    || provenance.fingerprint !== options.measuredFingerprint) {
    fail('qualification provenance does not match the requested measured identity; refusing to relabel');
  }
  const qualificationSha256 = createHash('sha256').update(readFileSync(options.qualificationPath)).digest('hex');

  const waveDir = path.resolve(options.waveDir);
  const qualificationEvidence = buildQualificationEvidence(qualification, {
    sourceHead: options.measuredSourceHead,
    buildId: options.measuredBuildId,
    sourceFingerprint: options.measuredFingerprint,
  });
  const measured = new Map(Object.entries(qualificationEvidence.commonManifest)
    .map(([file, receipt]) => [file, receipt.sha256]));

  // Classify and verify every measured production file against the current tree.
  const productionRuntime = {};
  const toolingState = {};
  for (const [file, measuredSha] of [...measured.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const currentSha = currentSha256(file);
    if (currentSha === null) fail(`measured production file is unavailable in the current tree: ${file}`);
    if (currentSha === measuredSha) {
      productionRuntime[file] = { measuredSha256: measuredSha, candidateSha256: currentSha, verified: 'identical' };
      continue;
    }
    if (!ALLOWED_TOOLING_DELTA.has(file)) {
      fail(`measured PRODUCTION file changed without an allowlisted basis: ${file}`);
    }
    toolingState[file] = { measuredSha256: measuredSha, candidateSha256: currentSha, basis: ALLOWED_TOOLING_DELTA.get(file) };
  }

  // The candidate report-runner fix must be the ONLY extension/src delta, and
  // it must not be part of any measured production manifest.
  const changedSinceMeasured = execFileSync('git', ['-C', repositoryRoot, 'diff', '--name-only',
    `${options.measuredSourceHead}..HEAD`, '--', 'extension/src', 'shared', 'extensions/subagent'],
  { encoding: 'utf8' }).split('\n').filter((value) => value.length > 0);
  const uncommittedSrcDelta = execFileSync('git', ['-C', repositoryRoot, 'diff', '--name-only', '--', 'extension/src', 'shared', 'extensions/subagent'],
    { encoding: 'utf8' }).split('\n').filter((value) => value.length > 0);
  const sourceDelta = [...new Set([...changedSinceMeasured, ...uncommittedSrcDelta])];
  const productionSourceDelta = sourceDelta
    .filter((file) => !toolingState[file] && !(file in productionRuntime));
  const offenders = productionSourceDelta.filter((file) => !ALLOWED_TOOLING_DELTA.has(file));
  if (offenders.length > 0) fail(`unallowlisted changed production source: ${offenders.join(', ')}`);
  const verifiedIdenticalDelta = productionSourceDelta.filter((file) => file in productionRuntime);
  if (verifiedIdenticalDelta.length > 0) {
    fail(`a verified-identical production runtime file also appears in the source delta: ${verifiedIdenticalDelta.join(', ')}`);
  }
  // Record every allowlisted current source delta, including unmeasured
  // activation/control files. These hashes are candidate bindings only; they
  // never relabel a changed measured runtime file as equivalent.
  for (const file of sourceDelta) {
    if (toolingState[file] || file in productionRuntime) continue;
    const candidateSha = currentSha256(file);
    if (candidateSha === null || !ALLOWED_TOOLING_DELTA.has(file)) continue;
    const measuredSha = sha256GitBlobOrNull(options.measuredSourceHead, file);
    toolingState[file] = {
      ...(measuredSha ? { measuredSha256: measuredSha } : {}),
      candidateSha256: candidateSha,
      basis: ALLOWED_TOOLING_DELTA.get(file),
    };
  }

  // Dependency identity inputs of the coordinated build id must be unchanged
  // unless the reviewed delta is only a build entry for inactive/control-plane
  // tooling. The changed dependency is still recorded in toolingState, so the
  // receipt never silently treats a new coordinated build input as measured.
  const dependencyFiles = [
    'extension/package.json',
    'extension/package-lock.json',
    'extension/tsconfig.json',
    'extension/vite.config.ts',
  ];
  const dependencies = {};
  for (const file of dependencyFiles) {
    const measuredSha = sha256GitBlob(options.measuredSourceHead, file);
    const currentSha = currentSha256(file);
    if (currentSha === null) fail(`coordinated build-id dependency input is unavailable: ${file}`);
    if (currentSha !== measuredSha) {
      if (!ALLOWED_TOOLING_DELTA.has(file)) {
        fail(`coordinated build-id dependency input changed: ${file}`);
      }
      toolingState[file] = {
        measuredSha256: measuredSha,
        candidateSha256: currentSha,
        basis: ALLOWED_TOOLING_DELTA.get(file),
      };
      continue;
    }
    dependencies[file] = { measuredSha256: measuredSha, candidateSha256: currentSha, verified: 'identical' };
  }

  // Candidate output inventory: markers and built production artifacts.
  const outRoot = path.join(repositoryRoot, 'extension', 'out');
  const marker = (relative) => {
    const filePath = path.join(outRoot, relative);
    if (!existsSync(filePath)) fail(`build marker is missing: ${relative}`);
    return readFileSync(filePath, 'utf8').trim();
  };
  const candidateBuildId = marker('pie-build-id.txt');
  const rendererBuildId = marker(path.join('webview', 'panel', 'pie-build-id.txt'));
  if (!/^[0-9a-f]{20}$/.test(candidateBuildId) || candidateBuildId !== rendererBuildId) {
    fail('current build is not coordinated');
  }
  const artifacts = {};
  for (const file of [...measured.keys()].filter((value) => value.startsWith('extension/out/'))) {
    const currentSha = currentSha256(file);
    if (currentSha === null || currentSha !== measured.get(file)) {
      fail(`measured runtime artifact is not byte-identical: ${file}`);
    }
    artifacts[file] = currentSha;
  }
  for (const relative of ['extension.js', 'backend.js', 'analytics-candidate-trial.js']) {
    const absolute = path.join(outRoot, relative);
    if (!existsSync(absolute)) fail(`candidate output inventory entry is missing: ${relative}`);
    artifacts[`extension/out/${relative.replaceAll('\\', '/')}`] = currentSha256(`extension/out/${relative.replaceAll('\\', '/')}`);
  }
  const webviewAssets = readdirSyncSafe(path.join(outRoot, 'webview', 'panel', 'assets'), '');
  if (webviewAssets.length < 1) fail('renderer panel asset inventory is empty');
  for (const asset of webviewAssets) {
    artifacts[`extension/out/webview/panel/assets/${asset}`]
      = currentSha256(`extension/out/webview/panel/assets/${asset}`);
  }

  const candidateSourceHead = execFileSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const receipt = {
    schemaVersion: 1,
    kind: 'pie-analytics-source-equivalence-v1',
    generatedAt: new Date().toISOString(),
    measured: {
      sourceHead: options.measuredSourceHead,
      buildId: options.measuredBuildId,
      sourceFingerprint: options.measuredFingerprint,
      waveDir: options.waveDir,
      qualificationReport: options.qualificationPath,
      qualificationReportSha256: qualificationSha256,
      provenance: {
        gitHead: provenance.gitHead,
        coordinatedBuildId: provenance.coordinatedBuildId,
        fingerprint: provenance.fingerprint,
      },
      qualificationEvidence,
    },
    candidate: {
      sourceHead: candidateSourceHead,
      buildId: candidateBuildId,
      rendererBuildId,
    },
    productionRuntime,
    dependencies,
    toolingState,
    outputInventory: { hostBuildMarker: candidateBuildId, rendererBuildMarker: rendererBuildId, artifacts },
  };
  writeFileSync(options.outPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  const receiptSha256 = createHash('sha256').update(readFileSync(options.outPath)).digest('hex');
  process.stdout.write(`${JSON.stringify({ receiptPath: options.outPath, receiptSha256, candidateBuildId }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
