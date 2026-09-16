#!/usr/bin/env node
// One-shot P7a bootstrap launcher for the supported launch channel.
//
// A normal VS Code window cannot gain new launch environment, so a first
// analytics activation needs one owner-controlled close/relaunch of Code with
// the handoff key ingress present. This launcher is that single invocation:
//
//   1. mint the owner bootstrap handoff key into durable, owner-controlled
//      files (key material is never printed, logged, or committed; a re-run
//      mints a fresh key and replaces the map, which is safe because old keys
//      die with the hosts they authenticated);
//   2. wait for the user to close running pie hosts normally (it never kills
//      a process, never edits global environment or machine state, and never
//      uses desktop automation);
//   3. relaunch VS Code with PIE_ANALYTICS_HANDOFF_KEY and the storage-cutoff
//      authorization, with any data-root override removed so hosts resolve
//      the canonical root themselves;
//   4. settle stale lifecycle evidence of confirmed-dead writers only, with
//      complete-census proof: registry rows the dead host itself would have
//      marked stopped, and stale runtime lease files of dead pids;
//   5. bind the registered production-workspace hosts into the owner key map
//      the activation plan references;
//   6. verify the same census the preflight will demand, optionally by
//      running the read-only preflight itself.
//
// The launcher is finite: it exits after verification and runs no daemon.
//
// Usage:
//   node scripts/analytics-bootstrap-launcher.mjs --plan <plan.json> [--preflight]
//       [--keys-path <file>] [--code-path <Code.exe>]
//       [--wait-close-ms N] [--wait-register-ms N]

import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');
const helperPath = path.join(repositoryRoot, 'scripts', 'analytics-activation-helper.mjs');
const outRoot = path.join(repositoryRoot, 'extension', 'out');
const BOOTSTRAP_ENV_KEYS_TO_CLEAR = ['PIE_DATA_DIR', 'PIE_ANALYTICS_DIR'];
const STORAGE_CUTOFF_AUTHORIZATION_ENV = 'PIE_STORAGE_CUTOFF_AUTHORIZATION';
const STORAGE_CUTOFF_AUTHORIZATION_VALUE = 'p7b-authorized-v1';
const HANDOFF_KEY_ENV = 'PIE_ANALYTICS_HANDOFF_KEY';
const DEFAULT_WAIT_CLOSE_MS = 10 * 60_000;
const DEFAULT_WAIT_REGISTER_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const BOUNDED_JSON_BYTES = 256 * 1024;

function fail(message) {
  process.stderr.write(`analytics-bootstrap-launcher: ${message}\n`);
  process.exit(1);
}

function out(message) {
  process.stdout.write(`${message}\n`);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) fail(`unexpected argument: ${name}`);
    const key = name.slice(2);
    if (key === 'preflight') { values.set(key, 'true'); continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`option ${name} requires a value`);
    values.set(key, value);
    index += 1;
  }
  if (!values.has('plan')) fail('--plan is required');
  return values;
}

function readBoundedJson(filePath, label) {
  try {
    if (statSync(filePath).size > BOUNDED_JSON_BYTES) fail(`${label} exceeds its bounded size`);
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadModules() {
  const load = async (name) => import(pathToFileURL(path.join(outRoot, `${name}.js`)).href);
  const [adapters, lifecycle, census, discovery] = await Promise.all([
    load('analytics-production-adapters'),
    load('session-lifecycle-store'),
    load('analytics-process-census'),
    load('analytics-handoff-discovery'),
  ]);
  return {
    SessionLifecycleStore: lifecycle.SessionLifecycleStore,
    createProductionAnalyticsHostAdapters: adapters.createProductionAnalyticsHostAdapters,
    readProcessCensus: census.readProcessCensus,
    readRuntimeLeaseEvidence: discovery.readRuntimeLeaseEvidence,
  };
}

function atomicWriteJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${process.pid}`);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 1)}\n`, 'utf8');
  writeFileSync(temporary, bytes, { mode: 0o600 });
  renameSync(temporary, filePath);
}

/** Durable owner file that outlives the launcher; it holds only the bootstrap
 * key and never leaves the owner directory. */
function bootstrapKeyPath(keysPath) {
  return path.join(path.dirname(keysPath), 'bootstrap-handoff-key-v1.json');
}

function mintBootstrapKey(keysPath) {
  const key = randomBytes(32).toString('base64url');
  atomicWriteJson(bootstrapKeyPath(keysPath), {
    schemaVersion: 1,
    kind: 'pie-analytics-bootstrap-handoff-key-v1',
    bootstrapKey: key,
    mintedAt: new Date().toISOString(),
    note: 'Owner-controlled launch-channel bootstrap key. Never commit or log this file.',
  });
  return key;
}

function resolveCodeExecutable(explicit) {
  if (explicit) return explicit;
  const candidates = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined,
    'C:\\Program Files\\Microsoft VS Code\\Code.exe',
  ].filter((candidate) => candidate && existsSync(candidate));
  if (candidates.length === 0) fail('VS Code executable was not found; pass --code-path explicitly');
  return candidates[0];
}

function launchCode(executable, bootstrapKey) {
  const childEnv = { ...process.env };
  for (const key of BOOTSTRAP_ENV_KEYS_TO_CLEAR) delete childEnv[key];
  childEnv[HANDOFF_KEY_ENV] = bootstrapKey;
  childEnv[STORAGE_CUTOFF_AUTHORIZATION_ENV] = STORAGE_CUTOFF_AUTHORIZATION_VALUE;
  const child = spawn(executable, [], {
    detached: true, stdio: 'ignore', env: childEnv, cwd: path.dirname(executable),
  });
  child.unref();
  return child.pid;
}

function listWorkspaceHosts(modules, lifecycleStorePath, workspaceId) {
  const store = new modules.SessionLifecycleStore(lifecycleStorePath, { readOnly: true });
  try {
    const hosts = [];
    let cursor;
    for (;;) {
      const page = store.listAnalyticsHosts(workspaceId, { limit: 64, ...(cursor ? { cursor } : {}) });
      hosts.push(...page.hosts);
      if (!page.truncated) return hosts;
      if (!page.nextCursor || page.nextCursor === cursor) fail('lifecycle registry pagination is incomplete');
      cursor = page.nextCursor;
    }
  } finally {
    store.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Live VS Code processes of any kind. A running VS Code main process would
 * swallow a second Code.exe spawn (it merely opens a window in the old main
 * process without the new environment), so the relaunch requires that every
 * VS Code process has exited normally first. */
function readLiveCodePids() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq Code.exe', '/NH', '/FO', 'CSV'], {
      timeout: 15_000, windowsHide: true, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) fail(`cannot read the VS Code process list: ${error.message}`);
      const pids = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const match = /^"Code\.exe","(\d+)"/.exec(line.trim());
        if (match) pids.push(Number(match[1]));
      }
      resolve(pids);
    });
  });
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const plan = readBoundedJson(path.resolve(options.get('plan')), 'activation plan');
  if (typeof plan.workspaceId !== 'string' || plan.workspaceId.trim().length === 0) {
    fail('activation plan carries no workspaceId');
  }
  if (!plan.stateDir || !plan.runtimeRootPath || !plan.runtimeIdentity) {
    fail('activation plan is missing stateDir, runtimeRootPath, or runtimeIdentity');
  }
  const keysPath = path.resolve(options.get('keys-path') ?? plan.keyChannel?.ownerControlledMapPath
    ?? path.join(process.env.APPDATA ?? os.homedir(), 'pie-owner-keys', 'host-handoff-keys-v1.json'));
  const modules = await loadModules();
  const lifecycleStorePath = plan.lifecycleStorePath ?? path.join(plan.stateDir, 'session-lifecycle.sqlite');

  // 1. Current pie runtime activity, from durable runtime leases only.
  const leases = await modules.readRuntimeLeaseEvidence(plan.runtimeRootPath, plan.runtimeIdentity);
  if (leases.complete !== true) {
    fail(`runtime lease evidence is incomplete: ${leases.reasons.map((entry) => entry.code).join(', ')}`);
  }
  let census = await modules.readProcessCensus();
  if (census.complete !== true) {
    fail(`process census is incomplete: ${census.reasons.map((entry) => entry.code).join(', ')}`);
  }
  const livePiePids = leases.leases
    .filter((lease) => census.processes.some((entry) => entry.processId === lease.processId))
    .map((lease) => lease.processId);

  // 2. A user-side normal close is the only supported way to retire the
  // unbootstrapped hosts, and every VS Code process must exit so the relaunch
  // starts a fresh main process that carries the launch environment. The
  // launcher waits; it never kills or restarts anything.
  {
    const waitCloseMs = Number(options.get('wait-close-ms') ?? DEFAULT_WAIT_CLOSE_MS);
    const deadline = Date.now() + waitCloseMs;
    let stillRunning = livePiePids;
    for (;;) {
      const codePids = await readLiveCodePids();
      if (stillRunning.length === 0 && codePids.length === 0) break;
      if (Date.now() >= deadline) {
        fail(`VS Code processes are still running after the close wait: ` +
          `pie pids ${stillRunning.join(', ') || 'none'}, Code pids ${codePids.join(', ') || 'none'}`);
      }
      if (stillRunning.length > 0) {
        out(`pie hosts are still running (pids ${stillRunning.join(', ')}); close all VS Code windows normally (unsaved work is preserved by hot exit). Waiting.`);
      } else {
        out(`VS Code is still running (pids ${codePids.join(', ')}); a fresh main process is required, so close the remaining VS Code windows too. Waiting.`);
      }
      await sleep(POLL_INTERVAL_MS);
      census = await modules.readProcessCensus();
      if (census.complete !== true) {
        fail(`process census is incomplete during the close wait: ${census.reasons.map((entry) => entry.code).join(', ')}`);
      }
      stillRunning = stillRunning.filter((pid) => census.processes.some((entry) => entry.processId === pid));
    }
  }

  // 3. Relaunch VS Code with the bootstrap launch-channel environment.
  const bootstrapKey = mintBootstrapKey(keysPath);
  const codeExecutable = resolveCodeExecutable(options.get('code-path'));
  const codePid = launchCode(codeExecutable, bootstrapKey);
  out(`launched VS Code (pid ${codePid}) with the bootstrap handoff key channel.`);

  // 4. Wait for at least one production-workspace host to register.
  const waitRegisterMs = Number(options.get('wait-register-ms') ?? DEFAULT_WAIT_REGISTER_MS);
  const registerDeadline = Date.now() + waitRegisterMs;
  let registered = [];
  for (;;) {
    registered = listWorkspaceHosts(modules, lifecycleStorePath, plan.workspaceId)
      .filter((host) => host.state === 'registered');
    if (registered.length > 0) break;
    if (Date.now() >= registerDeadline) {
      fail(`no pie host registered for the production workspace within ${waitRegisterMs} ms; check VS Code started normally`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  out(`${registered.length} host(s) registered for the production workspace.`);

  // 5. Settle stale evidence of confirmed-dead writers with census proof.
  const settledCensus = await modules.readProcessCensus();
  if (settledCensus.complete !== true) {
    fail(`process census is incomplete before settlement: ${settledCensus.reasons.map((entry) => entry.code).join(', ')}`);
  }
  const livePids = new Set(settledCensus.processes.map((entry) => entry.processId));
  const settledLeases = await modules.readRuntimeLeaseEvidence(plan.runtimeRootPath, plan.runtimeIdentity);
  const leasesForDeadPids = settledLeases.leases.filter((lease) => !livePids.has(lease.processId));
  for (const lease of leasesForDeadPids) {
    rmSync(path.join(plan.runtimeRootPath, 'leases', lease.leaseFileName), { force: true });
  }
  const backendHostPids = new Set(settledCensus.backendOwners.map((owner) => owner.hostProcessId));
  const settledRows = { stopped: 0 };
  {
    const store = new modules.SessionLifecycleStore(lifecycleStorePath);
    try {
      for (const host of listWorkspaceHosts(modules, lifecycleStorePath, plan.workspaceId)) {
        if (host.state !== 'registered' && host.state !== 'stopping') continue;
        // A pid absent from the complete census and owning no live backend is
        // a confirmed-dead writer; its stale lease file (if any) was released
        // above, so the census can no longer require its reconciliation.
        if (livePids.has(host.processId)) continue;
        if (backendHostPids.has(host.processId)) continue;
        store.markAnalyticsHostState(host.hostInstanceId, host.processId, host.generationId, 'stopped', Date.now());
        settledRows.stopped += 1;
      }
    } finally {
      store.close();
    }
  }
  out(`settled ${leasesForDeadPids.length} stale lease file(s) and ${settledRows.stopped} stale registry row(s) of confirmed-dead pids.`);

  // 6. Bind the live registered hosts into the owner key map and verify the
  // same census the preflight will demand.
  const boundHosts = listWorkspaceHosts(modules, lifecycleStorePath, plan.workspaceId)
    .filter((host) => host.state === 'registered');
  const keyMap = {};
  for (const host of boundHosts) keyMap[host.hostInstanceId] = bootstrapKey;
  atomicWriteJson(keysPath, keyMap);
  out(`bound ${Object.keys(keyMap).length} host key(s) into ${keysPath}.`);

  const store = new modules.SessionLifecycleStore(lifecycleStorePath, { readOnly: true });
  let verified;
  try {
    const adapters = modules.createProductionAnalyticsHostAdapters({
      workspaceId: plan.workspaceId,
      registry: store,
      runtimeRootPath: plan.runtimeRootPath,
      runtimeIdentity: plan.runtimeIdentity,
      allowAbsentAnalyticsDescriptor: true,
      keyForHost: (host) => keyMap[host.hostInstanceId],
    });
    verified = await adapters.discover({ ignoreStoppedHosts: true });
  } finally {
    store.close();
  }
  const unregisteredLeases = verified.unregisteredRuntimeLeases.length;
  const unregisteredBackends = verified.unregisteredBackendOwners.length;
  if (verified.complete === true && verified.hosts.length > 0
    && unregisteredLeases === 0 && unregisteredBackends === 0) {
    out('bootstrap verified: the authenticated host census is complete for first activation.');
  } else {
    out('bootstrap verification is incomplete; census reasons follow.');
    for (const entry of verified.reasons.slice(0, 32)) {
      out(`  - ${entry.code}${entry.processId === undefined ? '' : ` [pid ${entry.processId}]`}`);
    }
    process.exitCode = 2;
  }

  if (options.get('preflight') === 'true') {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(process.execPath, [helperPath, '--preflight', '--plan', path.resolve(options.get('plan'))], {
      cwd: repositoryRoot, encoding: 'utf8', windowsHide: true,
    });
    process.stdout.write(result.stdout ?? '');
    if (result.stderr) process.stderr.write(result.stderr);
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = result.status === 0 ? 0 : 2;
  } else {
    out(`next: node scripts/analytics-activation-helper.mjs --preflight --plan ${path.resolve(options.get('plan'))}`);
    out(`then: node scripts/analytics-activation-helper.mjs --detach --plan ${path.resolve(options.get('plan'))}`);
  }
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));