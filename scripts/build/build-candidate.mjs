#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOwnerRequire } from '../lib/package-resolution.mjs';
import { verifyPiRuntimeArtifact } from '../lib/pi-runtime-artifact.mjs';
import { stageExtensionForPackaging } from '../lib/delivery-package.mjs';
import { abortOnProcessSignals } from '../lib/process-watchdog.mjs';
import { withoutPiHarnessEnv } from '../lib/pi-harness-env.mjs';
import { verificationChildEnv } from '../verification/verification-runtime.mjs';
import { runQualificationStage } from '../verification/qualify-delivery.mjs';
import { parseManagedIntegrationSelection } from '../lib/managed-integration-selection.mjs';
import { resolvePlaywrightHeadlessPayloadExpected, validatePlaywrightRuntimePayload, verifyPlaywrightHeadlessPayloadOutput, verifyPlaywrightRuntimePayloadOutput } from './tool-runtime-assets.mjs';
import { validatePlaywrightHeadlessPayload } from './playwright-payload.mjs';
import { extractCandidate, validateCandidateContainer, fingerprintCandidate, verifyCandidateIdentity } from '../verification/lib/vsix-candidate.mjs';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const exec = promisify(execFile);
const HELP = 'Usage: node scripts/build/build-candidate.mjs --output <absolute .vsix> [--pi-runtime <absolute artifact root>] [--playwright-payload <absolute prepared directory> | --playwright-runtime <absolute prepared directory>] [--managed-stage <absolute stage> --managed-qualification-receipt <absolute receipt>]\nLocal development-only candidate; no installation, activation, publication or qualification.';

export function parseCandidateArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const managedIntegration = parseManagedIntegrationSelection(argv);
  const selection = managedIntegration ? { managedIntegration } : {};
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, ...inline] = argv[i].split('=');
    if (['--managed-stage', '--managed-qualification-receipt'].includes(flag)) {
      if (!inline.length) i += 1;
      continue;
    }
    const key = flag === '--output' ? 'output' : flag === '--pi-runtime' ? 'artifactDir'
      : flag === '--playwright-payload' ? 'playwrightPayloadDir'
        : flag === '--playwright-runtime' ? 'playwrightRuntimeDir' : undefined;
    if (!key) throw new Error(`Unknown candidate option: ${argv[i]}`);
    if (selection[key] !== undefined) throw new Error(`${flag} may be specified only once.`);
    const value = inline.length ? inline.join('=') : argv[++i];
    if (!value || !path.isAbsolute(value)) throw new Error(`${flag} requires an absolute path.`);
    selection[key] = path.resolve(value);
  }
  if (!selection.output || !selection.output.endsWith('.vsix')) throw new Error('--output requires an absolute .vsix path.');
  if (selection.playwrightPayloadDir !== undefined && selection.playwrightRuntimeDir !== undefined) {
    throw new Error('--playwright-payload and --playwright-runtime are mutually exclusive.');
  }
  if (managedIntegration && !selection.artifactDir) throw new Error('Managed candidates require explicit --pi-runtime.');
  return selection;
}

async function absent(file) {
  try { await lstat(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Refusing to overwrite ${file}`);
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
async function sourceIdentity(root, { signal, env }) {
  const git = async args => (await exec('git', ['--no-optional-locks', '-C', root, ...args], { signal, env, encoding: 'utf8' })).stdout;
  return { head: (await git(['rev-parse', 'HEAD'])).trim(), status: await git(['status', '--porcelain=v1', '--untracked-files=normal']) };
}
function resolveVsce(root) {
  const require = createOwnerRequire({ repositoryRoot: root });
  return require.resolve('@vscode/vsce/vsce');
}

/** Build privately, retain scratch on every outcome, and publish only exclusive final files. */
export async function buildCandidate(selection, signal, deps = {}) {
  // Validate API calls with the same rules as the CLI.
  selection = parseCandidateArgs(['--output', selection.output, ...(selection.artifactDir === undefined ? [] : ['--pi-runtime', selection.artifactDir]),
    ...(selection.playwrightPayloadDir === undefined ? [] : ['--playwright-payload', selection.playwrightPayloadDir]),
    ...(selection.playwrightRuntimeDir === undefined ? [] : ['--playwright-runtime', selection.playwrightRuntimeDir]),
    ...(selection.managedIntegration === undefined ? [] : ['--managed-stage', selection.managedIntegration.stageRoot, '--managed-qualification-receipt', selection.managedIntegration.receiptPath])]);
  const root = await realpath(deps.root ?? repositoryRoot);
  let playwrightPayload;
  if (selection.playwrightPayloadDir !== undefined) {
    const expected = await (deps.resolvePlaywrightExpected ?? resolvePlaywrightHeadlessPayloadExpected)(root);
    const prepared = await (deps.validatePlaywrightPayload ?? validatePlaywrightHeadlessPayload)({
      directory: selection.playwrightPayloadDir, expected,
    });
    playwrightPayload = { expected, identity: prepared.identity };
  }
  const playwrightRuntime = selection.playwrightRuntimeDir === undefined ? undefined : await (
    deps.validatePlaywrightRuntimePayload ?? validatePlaywrightRuntimePayload
  )({ directory: selection.playwrightRuntimeDir, repositoryRoot: root });
  const env = verificationChildEnv(withoutPiHarnessEnv(deps.env ?? process.env));
  const status = deps.status ?? (message => console.log(`[build-candidate] ${message}`));
  const evidencePath = `${selection.output}.evidence.json`;
  const parent = await realpath(path.dirname(selection.output));
  if (!(await lstat(parent)).isDirectory()) throw new Error('Output parent must already exist.');
  const output = path.join(parent, path.basename(selection.output));
  if (playwrightRuntime && (contains(selection.playwrightRuntimeDir, output) || contains(output, selection.playwrightRuntimeDir))) {
    throw new Error('Candidate output must not overlap the prepared Playwright runtime payload.');
  }
  await absent(output);
  await absent(evidencePath);
  signal?.throwIfAborted();
  const scratch = await realpath(await (deps.createScratch ?? (() => mkdtemp(path.join(os.tmpdir(), 'pie-candidate-'))))());
  if (contains(root, scratch) || contains(scratch, root)) throw new Error('Candidate scratch must be outside the checkout.');
  if (playwrightRuntime && (contains(playwrightRuntime.directory, scratch) || contains(scratch, playwrightRuntime.directory))) {
    throw new Error('Candidate scratch must not overlap the prepared Playwright runtime payload.');
  }
  status(`Retaining scratch: ${scratch}`);
  const buildDir = path.join(scratch, 'build');
  const stageRoot = path.join(scratch, 'stage');
  const candidate = path.join(scratch, 'candidate.vsix');
  const runStage = deps.runStage ?? runQualificationStage;
  const run = async (stage, cwd = root) => {
    signal?.throwIfAborted();
    const result = await runStage(stage, { root: cwd, signal, env });
    if (result?.code !== 0 || result.outerConfirmed !== true || result.innerConfirmed !== true) {
      throw new Error(`${stage.name} failed or teardown is unconfirmed; scratch retained at ${scratch}`);
    }
    signal?.throwIfAborted();
  };
  const source = await (deps.sourceIdentity ?? sourceIdentity)(root, { signal, env });
  let runtime;
  if (selection.artifactDir !== undefined) runtime = await (deps.verifyRuntime ?? verifyPiRuntimeArtifact)(selection.artifactDir);
  else await run({ name: 'pi-compile', args: [path.join(root, 'scripts/build/pi-workspace.mjs')] });
  await run({ name: 'delivery-build', args: [path.join(root, 'scripts/build/build.mjs'), '--delivery', '--no-sync', '--output-dir', buildDir,
    ...(selection.artifactDir === undefined ? [] : ['--pi-runtime', selection.artifactDir]),
    ...(selection.playwrightPayloadDir === undefined ? [] : ['--playwright-payload', selection.playwrightPayloadDir]),
    ...(selection.playwrightRuntimeDir === undefined ? [] : ['--playwright-runtime', selection.playwrightRuntimeDir]),
    ...(selection.managedIntegration === undefined ? [] : ['--managed-stage', selection.managedIntegration.stageRoot, '--managed-qualification-receipt', selection.managedIntegration.receiptPath])] });
  await (deps.stagePackage ?? stageExtensionForPackaging)(root, buildDir, stageRoot);
  const identityContext = {
    managedIntegration: selection.managedIntegration,
    ...(runtime === undefined ? {} : { expectedRuntimeIdentity: runtime.identity }),
    ...(playwrightRuntime === undefined ? {} : { expectedPlaywrightRuntimeIdentity: playwrightRuntime.identity }),
  };
  let identity = await (deps.verifyIdentity ?? verifyCandidateIdentity)(stageRoot, identityContext);
  if (playwrightPayload) {
    const copied = await (deps.verifyPlaywrightPayloadOutput ?? verifyPlaywrightHeadlessPayloadOutput)(path.join(stageRoot, 'out'), {
      expected: playwrightPayload.expected, expectedIdentity: playwrightPayload.identity,
    });
    if (copied.identity !== playwrightPayload.identity) throw new Error('Staged Playwright payload identity does not match the selected prepared payload; scratch retained.');
    identity = { ...identity, playwrightPayloadIdentity: copied.identity };
  }
  if (playwrightRuntime) {
    const copied = await (deps.verifyPlaywrightRuntimeOutput ?? verifyPlaywrightRuntimePayloadOutput)(path.join(stageRoot, 'out'), {
      repositoryRoot: root, expectedIdentity: playwrightRuntime.identity,
    });
    if (copied.identity !== playwrightRuntime.identity) throw new Error('Staged Playwright runtime identity does not match the selected prepared runtime; scratch retained.');
    identity = { ...identity, playwrightRuntimeIdentity: copied.identity };
  }
  if (typeof identity.target !== 'string') throw new Error('Staged build identity is missing a target; scratch retained.');
  if (runtime && identity.piRuntimeIdentity !== runtime.identity) throw new Error('Staged Pi runtime identity does not match the selected runtime; scratch retained.');
  const vsce = await (deps.resolveVsce ?? resolveVsce)(root);
  await run({ name: 'candidate-package', args: [vsce, 'package', '--no-dependencies', '--allow-missing-repository', '--target', identity.target, '--out', candidate] }, stageRoot);
  if (selection.managedIntegration || playwrightPayload || playwrightRuntime) {
    const managedContext = identityContext;
    let verified = await (deps.verifyCandidate ?? (async (file, destination, context) => {
      const container = await extractCandidate(file, destination);
      const extracted = await verifyCandidateIdentity(destination, context);
      validateCandidateContainer(container, extracted);
      return extracted;
    }))(candidate, path.join(scratch, 'extracted'), managedContext);
    if (playwrightPayload) {
      const copied = await (deps.verifyPlaywrightPayloadOutput ?? verifyPlaywrightHeadlessPayloadOutput)(path.join(scratch, 'extracted', 'out'), {
        expected: playwrightPayload.expected, expectedIdentity: playwrightPayload.identity,
      });
      if (copied.identity !== playwrightPayload.identity) throw new Error('Packaged Playwright payload identity does not match the selected prepared payload; scratch retained.');
      verified = { ...verified, playwrightPayloadIdentity: copied.identity };
    }
    if (playwrightRuntime) {
      const copied = await (deps.verifyPlaywrightRuntimeOutput ?? verifyPlaywrightRuntimePayloadOutput)(path.join(scratch, 'extracted', 'out'), {
        repositoryRoot: root, expectedIdentity: playwrightRuntime.identity,
      });
      if (copied.identity !== playwrightRuntime.identity) throw new Error('Packaged Playwright runtime identity does not match the selected prepared runtime; scratch retained.');
      verified = { ...verified, playwrightRuntimeIdentity: copied.identity };
    }
    if (!isDeepStrictEqual(verified, identity)) throw new Error('Packaged candidate identity does not match the staged build; scratch retained.');
  }
  const fingerprint = await (deps.fingerprint ?? fingerprintCandidate)(candidate);
  const evidence = { schema: 1, purpose: 'local-development-only', qualified: false,
    licenseQualified: false, cleanMachineQualified: false, source, runtime: { selection: selection.artifactDir ?? 'workspace', identity: runtime?.identity ?? identity.piRuntimeIdentity },
    ...(playwrightPayload ? { playwrightPayloadIdentity: identity.playwrightPayloadIdentity } : {}),
    ...(playwrightRuntime ? { playwrightRuntimeIdentity: identity.playwrightRuntimeIdentity } : {}),
    build: identity, candidate: { path: output, target: identity.target, ...fingerprint }, scratch };
  signal?.throwIfAborted();
  // Recheck both names just before publication; exclusive operations also close races.
  await absent(output);
  await absent(evidencePath);
  await copyFile(candidate, output, constants.COPYFILE_EXCL);
  // If evidence publication fails, the candidate remains valid bytes, never an empty reservation.
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  status(`Development-only candidate: ${output}`);
  return { output, evidencePath, scratch, evidence };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const selection = parseCandidateArgs(argv);
  if (selection.help) { console.log(HELP); return; }
  const cancellation = abortOnProcessSignals();
  try { return await buildCandidate(selection, cancellation.signal, deps); }
  finally { cancellation.dispose(); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main().catch(error => { console.error(`[build-candidate] ${error.message}`); process.exitCode = 1; });
}
