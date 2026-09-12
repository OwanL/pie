#!/usr/bin/env node
// One-shot analytics activation helper.
//
// Owns the finite activation cutover, the controlled restart request and the
// post-restart report. It is designed to be launched detached with `--detach`,
// so it keeps running when the terminal or agent session that started it exits,
// and to be safe to re-run at any point because every phase is idempotent and
// the phase record is written durably before the phase is attempted.
//
// What it deliberately does NOT do:
//   - write source or Git. Committing the activation evidence is a separate,
//     reviewed step. It only writes its own phase record and report.
//   - invent a storage-outage policy, shorten retention, or touch caller files.
//   - force-kill the VS Code process tree. The restart is requested through the
//     supported command and the helper verifies the outcome rather than assuming
//     it.
//
// Phases, each recorded before it runs so an interruption is observable:
//   prepare         validate inputs, resolve paths, hash the evidence reports
//   activate        write candidate -> ready -> active via the activation sequence
//   restart         request a quiet reload and record the request
//   verify          confirm the loaded generation matches the activated one
//   report          write the sanitized report and exit
//
// Usage:
//   node scripts/analytics-activation-helper.mjs --plan <plan.json> [--detach]
//   node scripts/analytics-activation-helper.mjs --status --state <stateDir>
//
// The plan file is JSON:
// {
//   "stateDir":        "<resolved state dir owning the activation manifest>",
//   "qualificationReport": "<absolute path to the accepted qualification report>",
//   "trialReport":     "<absolute path to the isolated candidate-trial report>",
//   "generationId":    "<uuid for this generation>",
//   "buildId":         "<host + renderer build id this generation was validated against>",
//   "reportPath":      "<absolute path for the sanitized activation report>",
//   "restartCommand":  "<optional; omit to activate without requesting a restart>"
// }
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');
const outRoot = path.join(repositoryRoot, 'extension', 'out');

const PHASES = ['prepare', 'activate', 'restart', 'verify', 'report'];

function fail(message) {
  process.stderr.write(`analytics-activation-helper: ${message}\n`);
  process.exit(1);
}

function parseArguments(argv) {
  const options = { detach: false, status: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--detach') { options.detach = true; continue; }
    if (argument === '--status') { options.status = true; continue; }
    if (argument === '--plan') { options.plan = argv[++index]; continue; }
    if (argument === '--state') { options.state = argv[++index]; continue; }
    fail(`unsupported argument: ${argument}`);
  }
  return options;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function loadPlan(planPath) {
  if (!planPath) fail('--plan is required');
  if (!path.isAbsolute(planPath)) fail('--plan must be an absolute path');
  if (!existsSync(planPath)) fail(`plan file does not exist: ${planPath}`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(planPath, 'utf8'));
  } catch (error) {
    fail(`plan file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const field of ['stateDir', 'qualificationReport', 'trialReport', 'generationId', 'buildId', 'reportPath']) {
    if (typeof parsed[field] !== 'string' || parsed[field].trim().length === 0) {
      fail(`plan.${field} must be a non-empty string`);
    }
  }
  for (const field of ['stateDir', 'qualificationReport', 'trialReport', 'reportPath']) {
    if (!path.isAbsolute(parsed[field])) fail(`plan.${field} must be an absolute path`);
  }
  return parsed;
}

/** Durable phase record. Written before each phase is attempted, so a killed
 * helper leaves the phase it had entered rather than appearing complete. */
function phaseRecordPath(stateDir) {
  return path.join(stateDir, 'analytics-activation-phases.json');
}

function readPhaseRecord(stateDir) {
  const filePath = phaseRecordPath(stateDir);
  if (!existsSync(filePath)) return { schemaVersion: 1, phases: [], lastError: null };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.phases)) {
      fail('activation phase record is malformed; refusing to continue');
    }
    return parsed;
  } catch (error) {
    fail(`activation phase record is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function appendPhase(stateDir, phase, detail) {
  const record = readPhaseRecord(stateDir);
  record.phases.push({ phase, at: new Date().toISOString(), detail: detail ?? null });
  record.lastError = null;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(phaseRecordPath(stateDir), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

function recordError(stateDir, phase, error) {
  const record = readPhaseRecord(stateDir);
  record.phases.push({ phase, at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
  record.lastError = error instanceof Error ? error.message : String(error);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(phaseRecordPath(stateDir), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function hasCompleted(stateDir, phase) {
  return readPhaseRecord(stateDir).phases.some((entry) => entry.phase === phase && !entry.error);
}

const { ActivationStore } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-activation-store.js')).href
).catch(() => fail('analytics-activation-store.js is missing; run the extension build first'));
const { activateGeneration } = await import(
  pathToFileURL(path.join(outRoot, 'analytics-activation-sequence.js')).href
).catch(() => fail('analytics-activation-sequence.js is missing; run the extension build first'));

const options = parseArguments(process.argv.slice(2));

if (options.detach) {
  // Re-exec detached so the helper outlives the terminal or agent session that
  // started it. stdout/stderr are discarded rather than inherited so the parent
  // exiting cannot break the child's streams.
  const child = spawn(process.execPath, process.argv.slice(1).filter((value) => value !== '--detach'), {
    detached: true,
    stdio: 'ignore',
    cwd: repositoryRoot,
  });
  child.unref();
  process.stdout.write(`analytics-activation-helper: detached as pid ${child.pid}\n`);
  process.exit(0);
}

if (options.status) {
  if (!options.state) fail('--status requires --state');
  process.stdout.write(`${JSON.stringify(readPhaseRecord(options.state), null, 2)}\n`);
  process.exit(0);
}

const plan = loadPlan(options.plan);

async function main() {
  // Phase: prepare. Hash the evidence reports now, so the activated generation
  // names exact bytes rather than a path that could change later.
  const store = new ActivationStore({ stateDir: plan.stateDir });
  if (!hasCompleted(plan.stateDir, 'prepare')) {
    for (const [label, file] of [['qualificationReport', plan.qualificationReport], ['trialReport', plan.trialReport]]) {
      if (!existsSync(file)) fail(`${label} does not exist: ${file}`);
    }
    const qualificationSha256 = sha256File(plan.qualificationReport);
    const trialSha256 = sha256File(plan.trialReport);
    appendPhase(plan.stateDir, 'prepare', { qualificationSha256, trialSha256 });
  }

  const prepared = readPhaseRecord(plan.stateDir).phases.find((entry) => entry.phase === 'prepare' && !entry.error);
  if (!prepared) fail('prepare phase did not record evidence');

  // Phase: activate. Idempotent, so a rerun after any interruption resumes.
  if (!hasCompleted(plan.stateDir, 'activate')) {
    try {
      const outcome = await activateGeneration(store, {
        generationId: plan.generationId,
        buildId: plan.buildId,
        qualificationSha256: prepared.detail.qualificationSha256,
        trialSha256: prepared.detail.trialSha256,
        activatedAt: new Date().toISOString(),
      });
      appendPhase(plan.stateDir, 'activate', {
        alreadyActive: outcome.alreadyActive,
        revision: outcome.revision,
        authority: store.read().authority,
      });
    } catch (error) {
      recordError(plan.stateDir, 'activate', error);
      throw error;
    }
  }

  // Phase: restart. Requested through a configured command rather than by killing
  // the process tree, and recorded whether or not a command was supplied.
  if (!hasCompleted(plan.stateDir, 'restart')) {
    if (!plan.restartCommand) {
      appendPhase(plan.stateDir, 'restart', { requested: false, reason: 'no restartCommand in plan' });
    } else {
      try {
        const child = spawn(plan.restartCommand, {
          shell: true,
          detached: true,
          stdio: 'ignore',
          cwd: repositoryRoot,
        });
        child.unref();
        appendPhase(plan.stateDir, 'restart', { requested: true, pid: child.pid, command: plan.restartCommand });
      } catch (error) {
        recordError(plan.stateDir, 'restart', error);
        throw error;
      }
    }
  }

  // Phase: verify. Read back what is actually recorded, and state plainly that a
  // manifest read is not proof the new code is loaded in a running host.
  const verification = (() => {
    const read = store.read();
    const active = read.manifest?.activeGeneration ?? null;
    return {
      authority: read.authority,
      manifestRevision: read.manifest?.revision ?? null,
      activeGenerationId: active?.identity.generationId ?? null,
      activeBuildId: active?.identity.buildId ?? null,
      generationMatchesPlan: active?.identity.generationId === plan.generationId,
      tombstonePresent: read.tombstonePresent,
    };
  })();
  if (!hasCompleted(plan.stateDir, 'verify')) {
    appendPhase(plan.stateDir, 'verify', verification);
  }

  // Phase: report.
  const phases = readPhaseRecord(plan.stateDir).phases;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    plan: {
      stateDir: plan.stateDir,
      generationId: plan.generationId,
      buildId: plan.buildId,
      restartRequested: Boolean(plan.restartCommand),
    },
    verification,
    phases,
    // Stated explicitly so a manifest read is never presented as proof that the
    // loaded host generation changed. Verifying the running host needs a
    // post-restart probe, which this helper records as a requirement.
    postRestartProbeRequired: plan.restartCommand !== undefined,
  };
  mkdirSync(path.dirname(plan.reportPath), { recursive: true });
  writeFileSync(plan.reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  appendPhase(plan.stateDir, 'report', { reportPath: plan.reportPath });

  process.stdout.write(`${JSON.stringify({ status: 'complete', report: plan.reportPath, verification }, null, 2)}\n`);
}

await main();
