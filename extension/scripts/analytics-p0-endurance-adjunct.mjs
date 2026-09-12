#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateEnduranceTerminalReceipt, validateEnduranceTrials } from './analytics-p0-endurance-validation.mjs';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag !== '--report' && flag !== '--output' && flag !== '--run-metadata') {
      throw new Error(`Unsupported option: ${flag}`);
    }
    if (options[flag]) throw new Error(`Duplicate option: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--') || !path.isAbsolute(value) || !value.toLowerCase().endsWith('.json')) {
      throw new Error(`${flag} requires an absolute JSON path`);
    }
    options[flag] = path.resolve(value);
  }
  if (!options['--report'] || !options['--output']) throw new Error('--report and --output are required');
  if (existsSync(options['--output'])) throw new Error('--output must name a new file');
  return options;
}

function observeProcess(pid) {
  try {
    process.kill(pid, 0);
    return { processObservedAlive: true };
  } catch (error) {
    // ESRCH is the only useful positive absence signal. Other errors (for
    // example EPERM) are conservatively treated as still alive/unknown.
    return { processObservedAlive: error?.code !== 'ESRCH' };
  }
}

function parseJsonBytes(bytes) {
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''));
}

const options = parseArguments(process.argv.slice(2));
const reportBytes = readFileSync(options['--report']);
const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
const report = parseJsonBytes(reportBytes);
if (report.status !== 'passed' || report.configuration?.scenario !== 'endurance' || report.configuration?.mode !== 'full') {
  throw new Error('the bound report must be a passed full endurance report');
}
if (report.cleanup?.completed !== true || report.cleanup?.rootRemoved !== true) {
  throw new Error('the bound report must record completed proof-root cleanup');
}
const endurance = report.results?.endurance;
const pacing = validateEnduranceTrials(endurance, { mode: 'full' });
if (!pacing.valid) throw new Error(`original endurance pacing or memory evidence is invalid: ${pacing.errors.join('; ')}`);

const workers = endurance.trials.flatMap((trial) => trial.workerMemory.workers.map((worker) => {
  const observation = observeProcess(worker.identity.pid);
  return {
    identity: worker.identity,
    ...observation,
    observationKind: 'post-hoc-process-absence',
    exitCodeKnown: false,
    signalKnown: false,
  };
}));
const terminalReceipt = {
  schemaVersion: 1,
  kind: 'pie-p0-endurance-terminal-receipt-v1',
  originalReportSha256: reportSha256,
  observedAt: new Date().toISOString(),
  observationKind: 'post-hoc-process-absence',
  workers,
};
const terminal = validateEnduranceTerminalReceipt(endurance, terminalReceipt, { reportSha256 });
if (!terminal.valid) throw new Error(`terminal worker observation is incomplete: ${terminal.errors.join('; ')}`);

let runMetadata;
if (options['--run-metadata']) {
  const metadataPath = options['--run-metadata'];
  const metadata = parseJsonBytes(readFileSync(metadataPath));
  const pids = [metadata.wrapperPid, metadata.childPid].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  runMetadata = {
    path: metadataPath,
    status: metadata.status ?? null,
    recordedExitCode: metadata.exitCode ?? null,
    exitCodeKnown: Number.isSafeInteger(metadata.exitCode),
    processes: pids.map((pid) => ({ pid, ...observeProcess(pid) })),
    limitation: 'The wrapper metadata recorded no reliable child exit code; this adjunct makes no exit-code or signal claim.',
  };
}

const adjunct = {
  schemaVersion: 1,
  kind: 'pie-p0-endurance-adjunct-v1',
  status: 'passed',
  generatedAt: new Date().toISOString(),
  originalReportPath: options['--report'],
  originalReportSha256: reportSha256,
  originalReport: {
    schemaVersion: report.schemaVersion,
    harnessVersion: report.harnessVersion,
    gitHead: report.provenance?.gitHead ?? null,
    provenanceFingerprint: report.provenance?.fingerprint ?? null,
    finishedAt: report.finishedAt ?? null,
  },
  pacing: {
    valid: pacing.valid,
    toleranceFraction: 0.02,
    trials: pacing.trials.map((trial) => ({ label: trial.label, ...trial.pacing })),
    source: 'recorded sampleCount divided by recorded submissionElapsedMs; the original report has no per-submit timestamp stream',
  },
  terminalReceipt,
  ...(runMetadata ? { runMetadata } : {}),
  limitations: [
    'Post-hoc process absence does not reconstruct the exact worker shutdown time.',
    'No worker shutdown lifecycle receipt, exit code, or signal is claimed.',
    'This adjunct is bound to the original report hash and does not alter that report.',
    'The workload uses the endurance harness fresh database and generated payload mix; it does not qualify the r08 1M-row history or richer UI workload.',
  ],
};
writeFileSync(options['--output'], `${JSON.stringify(adjunct, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ status: adjunct.status, originalReportSha256: reportSha256, workerCount: terminal.workerCount, output: options['--output'] }));
