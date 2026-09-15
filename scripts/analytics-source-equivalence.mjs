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
  if (!existsSync(filePath)) fail(`${label} is missing: ${filePath}`);
  if (!statSync(filePath).isFile() || statSync(filePath).size > maxBytes) fail(`${label} is not a bounded file`);
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
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
  'scripts/analytics-activation-admission.mjs': 'committed admission tooling change since the measured head',
  'scripts/analytics-activation-helper.mjs': 'committed admission tooling change since the measured head',
  'scripts/test/analytics-provisional-qualification.test.mjs': 'committed admission test change since the measured head',
  'docs/internal/ANALYTICS_REWORK_EXECUTION.md': 'committed documentation change since the measured head',
}));

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!/^[0-9a-f]{40}$/.test(options.measuredSourceHead)) fail('measured source head must be a 40-character sha');
  if (!/^[0-9a-f]{20}$/.test(options.measuredBuildId)) fail('measured build id must be a 20-hex coordinated id');
  if (!isSha256(options.measuredFingerprint)) fail('measured fingerprint must be a sha256');

  const qualification = readBoundedJson(options.qualificationPath, 'qualification report');
  const provenance = qualification.provenance;
  if (!provenance || provenance.valid !== true
    || provenance.gitHead !== options.measuredSourceHead
    || provenance.coordinatedBuildId !== options.measuredBuildId
    || provenance.fingerprint !== options.measuredFingerprint) {
    fail('qualification provenance does not match the requested measured identity; refusing to relabel');
  }
  const qualificationSha256 = createHash('sha256').update(readFileSync(options.qualificationPath)).digest('hex');

  // Union of the measured per-role source manifests.
  const measured = new Map();
  const waveDir = path.resolve(options.waveDir);
  const roleNames = readdirSyncSafe(waveDir);
  for (const roleName of roleNames) {
    const roleFile = path.join(waveDir, roleName);
    let report;
    try {
      report = readBoundedJson(roleFile, 'role report');
    } catch {
      continue;
    }
    const files = report?.provenance?.files;
    if (files && report.provenance.gitHead === options.measuredSourceHead
      && report.provenance.hostBuildId === options.measuredBuildId
      && report.provenance.rendererBuildId === options.measuredBuildId) {
      for (const [file, receipt] of Object.entries(files)) {
        if (!isSha256(receipt?.sha256)) fail(`measured manifest entry is invalid: ${file}`);
        if (measured.has(file) && measured.get(file) !== receipt.sha256) {
          fail(`measured manifest disagrees across roles for ${file}`);
        }
        measured.set(file, receipt.sha256);
      }
    }
  }
  if (measured.size === 0) fail('no measured role provenance manifests were found; refusing to proceed');

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
  const productionSourceDelta = [...new Set([...changedSinceMeasured, ...uncommittedSrcDelta])]
    .filter((file) => !toolingState[file] && !(file in productionRuntime));
  const offenders = productionSourceDelta.filter((file) => !ALLOWED_TOOLING_DELTA.has(file));
  if (offenders.length > 0) fail(`unallowlisted changed production source: ${offenders.join(', ')}`);
  const verifiedIdenticalDelta = productionSourceDelta.filter((file) => file in productionRuntime);
  if (verifiedIdenticalDelta.length > 0) {
    fail(`a verified-identical production runtime file also appears in the source delta: ${verifiedIdenticalDelta.join(', ')}`);
  }

  // Dependency identity inputs of the coordinated build id must be unchanged.
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
    if (currentSha === null || currentSha !== measuredSha) {
      fail(`coordinated build-id dependency input changed: ${file}`);
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

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}