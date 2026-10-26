#!/usr/bin/env node
// Read-only qualification of an explicitly prepared closure and runtime.
import { hash, inside, check, resolveFile, validateReport, validateRecheck, qualificationInputs, qualificationRecipeDigest, qualificationSnapshot } from './managed-qualification-receipt.mjs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { abortOnProcessSignals } from '../lib/process-watchdog.mjs';
import { runQualificationStage } from './qualify-delivery.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRoot = fileURLToPath(new URL('./fixtures/', import.meta.url));
export const HELP = 'Usage: node scripts/verification/qualify-managed-integrations.mjs --stage <absolute prepared closure> --pi-runtime <absolute artifact root> --evidence-parent <absolute external directory>';
export function parseQualificationArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const result = {}, names = { '--stage': 'stageRoot', '--pi-runtime': 'artifactDir', '--evidence-parent': 'evidenceParent' };
  for (let i = 0; i < argv.length; i++) {
    const [option, ...inline] = argv[i].split('=');
    check(Object.hasOwn(names, option), `Unknown option: ${option}`);
    const key = names[option], value = inline.length ? inline.join('=') : argv[++i];
    check(result[key] === undefined && typeof value === 'string' && path.isAbsolute(value), `${option} requires one absolute path`);
    result[key] = path.resolve(value);
  }
  check(Object.keys(result).length === 3, HELP);
  return result;
}

export async function qualifyManagedIntegrations({ stageRoot, artifactDir, evidenceParent }, signal, deps = {}) {
  for (const value of [stageRoot, artifactDir, evidenceParent]) check(typeof value === 'string' && path.isAbsolute(value), 'Explicit absolute paths required');
  [stageRoot, artifactDir, evidenceParent] = await Promise.all([stageRoot, artifactDir, evidenceParent].map(x => realpath(x)));
  const checkout = await realpath(deps.root ?? root);
  for (const owned of [stageRoot, artifactDir, checkout]) check(!inside(owned, evidenceParent) && !inside(evidenceParent, owned), 'Evidence parent must be external and disjoint');
  const target = { platform: process.platform, arch: process.arch, nodeAbi: process.versions.modules };
  const snapshot = () => qualificationSnapshot(stageRoot, artifactDir, deps);
  signal?.throwIfAborted();
  const before = await snapshot();
  const evidenceDir = await (deps.createEvidence ?? (parent => mkdtemp(path.join(parent, 'managed-integrations-'))))(evidenceParent);
  const canonicalEvidence = await realpath(evidenceDir);
  check(inside(evidenceParent, canonicalEvidence) && canonicalEvidence !== evidenceParent, 'Invalid evidence directory');
  const outcomes = [];
  let confirmed = true;
  try {
    const inputs = await qualificationInputs(checkout);
    const qualificationRecipeSha256 = qualificationRecipeDigest(inputs);
    const stage = before.stage;
    const webRoot = stage.packages['pi-web-access'], mcpRoot = stage.packages['pi-mcp-adapter'];
    const sdkEntry = await realpath(path.join(before.runtime.sdkPath, 'dist', 'index.js'));
    check(inside(artifactDir, sdkEntry), 'Verified runtime SDK entry must remain inside selected artifact');
    const keyringEntry = await resolveFile(stage, mcpRoot, '@napi-rs/keyring', 'index.js');
    const keyringNativeEntry = await resolveFile(stage, path.dirname(keyringEntry), '@napi-rs/keyring-win32-x64-msvc', 'keyring.win32-x64-msvc.node');
    for (const name of ['managed-integrations', 'managed-recheck']) {
      signal?.throwIfAborted();
      const privateRoot = path.join(canonicalEvidence, name);
      await mkdir(privateRoot);
      const dirs = {};
      for (const key of ['home', 'appdata', 'localappdata', 'temp', 'agent', 'cache', 'work']) { dirs[key] = path.join(privateRoot, key); await mkdir(dirs[key]); }
      const env = {};
      // Deliberately no PATH, NODE_OPTIONS, provider credentials, npm or host Pi settings.
      for (const key of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT']) if ((deps.env ?? process.env)[key]) env[key] = (deps.env ?? process.env)[key];
      Object.assign(env, { HOME: dirs.home, USERPROFILE: dirs.home, APPDATA: dirs.appdata, LOCALAPPDATA: dirs.localappdata, TMP: dirs.temp, TEMP: dirs.temp, TMPDIR: dirs.temp, XDG_CACHE_HOME: dirs.cache, XDG_CONFIG_HOME: dirs.appdata, XDG_DATA_HOME: dirs.localappdata, PI_CODING_AGENT_DIR: dirs.agent, PI_CODING_AGENT_AUTH_DIR: dirs.agent, PI_CODING_AGENT_SESSION_DIR: dirs.agent, PIE_CACHE_DIR: dirs.cache, PI_OFFLINE: '1' });
      const resultPath = path.join(privateRoot, 'result.json');
      const config = { stageRoot, runtimeRoot: artifactDir, privateRoot, sdkEntry, webRoot, mcpRoot, keyringEntry, keyringNativeEntry, workDir: dirs.work, resultPath };
      const configPath = path.join(privateRoot, 'config.json');
      await writeFile(configPath, JSON.stringify(config), { flag: 'wx' });
      const argument = name === 'managed-integrations' ? configPath : JSON.stringify(config);
      confirmed = false;
      const completion = await (deps.runStage ?? runQualificationStage)({ name, args: [path.join(fixtureRoot, `${name}-child.mjs`), argument] }, { root: dirs.work, signal, env });
      confirmed = completion.outerConfirmed === true && completion.innerConfirmed === true;
      if (completion.code !== 0 || !confirmed) outcomes.push({ name, completion, resultPath });
      check(completion.code === 0 && confirmed, `${name}: child failure or unconfirmed teardown; evidence retained at ${canonicalEvidence}`);
      const report = JSON.parse(await readFile(resultPath, 'utf8'));
      validateReport(name, report, stage);
      if (name === 'managed-recheck') await validateRecheck(stage, report);
      outcomes.push({ name, completion, resultPath, resultSha256: hash(await readFile(resultPath)), report });
    }
    const after = await snapshot();
    check(JSON.stringify(before.binding) === JSON.stringify(after.binding), 'Stage/runtime changed during qualification');
    signal?.throwIfAborted();
    const receipt = { schemaVersion: 1, passed: true, recipe: 'managed-integrations-provider-free-v1', inputs, qualificationRecipeSha256, stage: { root: stageRoot, receiptSha256: before.binding.receiptSha256, inventorySha256: before.binding.inventorySha256 }, runtime: { artifactDir, identity: before.runtime.identity, target }, children: outcomes, teardown: { outerConfirmed: true, innerConfirmed: true } };
    const receiptPath = path.join(canonicalEvidence, 'qualification-receipt.json');
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
    return { code: 0, evidenceDir: canonicalEvidence, receiptPath, receipt };
  } catch (error) {
    let revalidation;
    if (confirmed) {
      try { const after = await snapshot(); revalidation = { unchanged: JSON.stringify(before.binding) === JSON.stringify(after.binding), binding: after.binding }; }
      catch (failure) { revalidation = { error: failure.message }; }
    }
    await writeFile(path.join(canonicalEvidence, 'failure.json'), JSON.stringify({ error: error.message, confirmed, revalidation, outcomes }, null, 2), { flag: 'wx' });
    throw error;
  }
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  let cancellation;
  try {
    const selection = parseQualificationArgs(argv);
    if (selection.help) { console.log(HELP); return 0; }
    cancellation = (deps.abortOnProcessSignals ?? abortOnProcessSignals)();
    await qualifyManagedIntegrations(selection, cancellation.signal, deps);
    return 0;
  } catch (error) { console.error(error.message); return 1; }
  finally { cancellation?.dispose(); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main();
