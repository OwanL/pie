// Registration-only delivered-byte qualification. Node guards are cooperative, not an OS sandbox.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyCandidateIdentity } from './vsix-candidate.mjs';
import { verifyManagedIntegrationQualification, resolveFile, qualificationInputs } from '../managed-qualification-receipt.mjs';
import { verifyBundledManagedOutput } from '../../build/bundled-managed-resources.mjs';

const checkout = fileURLToPath(new URL('../../../', import.meta.url));
const childPath = fileURLToPath(new URL('../fixtures/delivery-registration-child.mjs', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
export const CORE = ['ask-user','computer-use','copilot-model-discovery','deferred-triggers','playwright','safeguard','session-changes','skill-pruner','subagent','tool-result-pruner','warm-bash','web-access-guard'];
export const REQUIRED_TOOLS = [['ask_user'],['computer'],[],['wakeup_timer'],['playwright'],[],['session_changes'],['request_capability'],['subagent'],[],['bash'],[],['web_search','source_check','fetch_content','get_search_content'],['mcpScript','mcp']];
export function defaultsFromInventories(moduleDir, core, managed) {
  assert.equal(core.version, 1);
  assert.deepEqual(core.extensions, CORE.map(id => ({ id, entry: `${id}.js` })));
  assert.equal(managed.schemaVersion, 1);
  assert.deepEqual(managed.packages.map(p => p.name), ['pi-web-access','pi-mcp-adapter']);
  return [...core.extensions.map(p => ({path:path.join(moduleDir,p.entry),legacyPaths:[]})), ...managed.packages.map(p => {
    assert.equal(p.entry,`node_modules/${p.name}/index.ts`);
    return {path:path.join(moduleDir,'resources/managed-integrations',p.entry),legacyPaths:[],legacyPackageSources:[`npm:${p.name}`]};
  })];
}
export async function loadDefaults(Loader, config) {
  assert.equal(config.defaults.length,14);
  const loader = new Loader({cwd:config.workDir,agentDir:config.agentDir,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,defaultExtensions:config.defaults});
  await loader.reload();
  return loader.getExtensions();
}
export function assertRegistration(loaded, defaults) {
  assert.deepEqual(loaded.errors,[]);
  const names=['handlers','tools','commands','flags','shortcuts','messageRenderers','entryRenderers'];
  const actual=loaded.extensions.map(e=>({path:e.path,...Object.fromEntries(names.map(n=>[n,n==='handlers'?[...(e[n]??new Map())].map(([k,v])=>[k,v.length]).sort():[...(e[n]??new Map()).keys()].sort()]))}));
  validateRegistrationReport({ok:true,errors:[],denied:[],requests:[],extensions:actual},defaults);
  return actual;
}
export function validateRegistrationReport(report, defaults) {
  assert.equal(report.ok,true); assert.deepEqual(report.errors,[]); assert.deepEqual(report.denied,[]); assert.deepEqual(report.requests,[]);
  assert.equal(report.extensions.length,14); assert.equal(defaults.length,14);
  assert.equal(new Set(report.extensions.map(e=>e.path)).size,14);
  assert.deepEqual(report.extensions.map(e=>e.path).sort(),defaults.map(e=>e.path).sort());
  defaults.forEach((item,i)=> { for(const tool of REQUIRED_TOOLS[i]) assert.ok(report.extensions.find(e=>e.path===item.path).tools.includes(tool),`missing required tool ${tool}`); });
}
// Exit status is poisoned immediately, even if a later exit listener runs after
// report serialization and catches the denied operation's exception.
export function createDenialRecorder({process,denied,denyDiagnostics,phase}) {
  return kind => {
    process.exitCode = 1;
    denied.push(kind);
    if (denyDiagnostics.length < 100) denyDiagnostics.push({kind,phase:phase(),stack:new Error(`DENIED ${kind}`).stack?.split('\n').slice(0,12).join('\n').slice(0,2000)});
  };
}
export function registerExitReport({process,report,resultPath,writeSync}) {
  process.once('exit',code=> {
    if(report.denied.length) report.errors.push({message:'unexpected final denial ledger'});
    report.ok=report.ok===true && report.errors.length===0 && report.denied.length===0 && code===0 && !process.exitCode;
    if(!report.ok) process.exitCode=1;
    try {writeSync(resultPath,JSON.stringify(report,null,2));} catch(error) {process.exitCode=1;throw error;}
  });
}
export function registrationShell(shell,host={}) {
  // Empty inherited selectors are unset, not paths; explicit API values still fail validation.
  return shell ?? (host.PIE_SHELL || path.join(host.ProgramFiles || 'C:/Program Files','Git/bin/bash.exe'));
}
export function privateEnvironment(dirs,shell,host={}) {
  assert.ok(path.isAbsolute(shell));
  const env={};
  for(const key of ['SystemRoot','WINDIR','ComSpec','PATHEXT']) {
    const actual=Object.keys(host).find(k=>k.toUpperCase()===key.toUpperCase());
    if(actual) env[key]=host[actual];
  }
  const systemRoot=env.SystemRoot??env.WINDIR; assert.ok(path.isAbsolute(systemRoot??''));
  const homeDrive=path.parse(dirs.home).root.replace(/[\\/]+$/,'');
  return Object.assign(env,{PATH:'',HOMEDRIVE:homeDrive,HOMEPATH:dirs.home.slice(homeDrive.length),SYSTEMDRIVE:path.parse(systemRoot).root.replace(/[\\/]+$/,''),USERNAME:'pie-registration',USERDOMAIN:'PRIVATE',LOGONSERVER:'',HOME:dirs.home,USERPROFILE:dirs.home,APPDATA:dirs.appdata,LOCALAPPDATA:dirs.localappdata,TMP:dirs.temp,TEMP:dirs.temp,TMPDIR:dirs.temp,XDG_CACHE_HOME:dirs.cache,XDG_CONFIG_HOME:dirs.appdata,XDG_DATA_HOME:dirs.localappdata,PI_CODING_AGENT_DIR:dirs.agent,PI_CODING_AGENT_AUTH_DIR:dirs.agent,PI_CODING_AGENT_SESSION_DIR:dirs.agent,PIE_CACHE_DIR:dirs.cache,PI_OFFLINE:'1',PIE_BASH_WARM_POOL:'0',PIE_SHELL:shell,PIE_REGISTRATION_NO_PROVIDER:'1'});
}
export function validatePrivateEnvironment(config,env,cwd) {
  const norm=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k.toUpperCase(),v]));
  assert.deepEqual(norm(env),norm(privateEnvironment(config.dirs,config.shell,config.hostEnv)));
  assert.equal(cwd,config.workDir); assert.equal(config.noProvider,true);
  assert.equal(config.agentDir,config.dirs.agent); assert.equal(config.workDir,config.dirs.work);
  for(const dir of Object.values(config.dirs)) assert.ok(inside(config.privateRoot,dir));
}
async function tree(root) {
  const rows=[];
  async function walk(dir) {for(const name of (await fs.readdir(dir)).sort()) {
    const file=path.join(dir,name),s=await fs.lstat(file);
    assert.ok(!s.isSymbolicLink(),'linked snapshot input');
    if(s.isDirectory()) await walk(file);
    else {assert.ok(s.isFile()&&s.nlink===1,'special/linked snapshot input');rows.push([path.relative(root,file),s.mode&0o777,hash(await fs.readFile(file))]);}
  }}
  await walk(root); return rows;
}
async function sourceSnapshot() {
  const files=[fileURLToPath(import.meta.url),childPath,path.join(checkout,'scripts/verification/qualify-delivery.mjs'),path.join(checkout,'scripts/lib/process-watchdog.mjs'),path.join(checkout,'scripts/verification/lib/vsix-candidate.mjs'),path.join(checkout,'scripts/build/bundled-managed-resources.mjs'),path.join(checkout,'lib/pi-runtime/artifact.mjs')];
  return Object.fromEntries(await Promise.all(files.map(async file=>[path.relative(checkout,file),hash(await fs.readFile(file))])));
}
// All postchecks run independently, including after thrown launch or cancellation.
export async function collectRegistrationOutcome({launch,checks,writePostChecks,readReport,defaults}) {
  let completion,primary;
  try {completion=await launch(); if(completion.code!==0||completion.outerConfirmed!==true||completion.innerConfirmed!==true) throw Error('registration child failure or unconfirmed teardown');}
  catch(error) {primary=error;}
  const postChecks={completion:completion??null,checks:{}};
  for(const [name,check] of Object.entries(checks)) {
    try {await check();postChecks.checks[name]={ok:true};} catch(error) {postChecks.checks[name]={ok:false,error:String(error.message??error)};}
  }
  try {await writePostChecks(postChecks);} catch(error) {primary??=error;}
  if(primary) throw primary;
  assert.ok(Object.values(postChecks.checks).every(check=>check.ok),'registration immutable input revalidation failed');
  const report=await readReport(); validateRegistrationReport(report,defaults);
  return {completion,postChecks,report};
}
export async function qualifyDeliveryRegistration({candidateRoot,managedIntegration,expectedPlaywrightRuntimeIdentity,runStage,signal,shell,hostEnv=process.env}) {
  assert.equal(process.platform,'win32','registration qualification currently requires Windows x64'); assert.equal(process.arch,'x64');
  assert.equal(typeof runStage,'function','canonical stage runner required');
  signal?.throwIfAborted();
  candidateRoot=await fs.realpath(candidateRoot);
  const stageRoot=await fs.realpath(path.join(candidateRoot,'out')),runtimeRoot=await fs.realpath(path.join(stageRoot,'pi-runtime'));
  const preparedStageRoot=await fs.realpath(managedIntegration.stageRoot),receiptPath=await fs.realpath(managedIntegration.receiptPath);
  const selection={stageRoot:preparedStageRoot,receiptPath};
  const verify=()=>verifyCandidateIdentity(candidateRoot,{
    managedIntegration:selection,
    ...(expectedPlaywrightRuntimeIdentity===undefined?{}:{expectedPlaywrightRuntimeIdentity}),
  });
  const identity=await verify();
  const q=await verifyManagedIntegrationQualification({...selection,artifactDir:runtimeRoot});
  const managed=verifyBundledManagedOutput(stageRoot,q);
  const sdkEntry=await fs.realpath(path.join(q.runtime.sdkPath,'dist/index.js')); assert.ok(inside(runtimeRoot,sdkEntry));
  const emitted={...q.stage,root:managed.root};
  const webRoot=managed.packages.find(p=>p.name==='pi-web-access').packageRoot,mcpRoot=managed.packages.find(p=>p.name==='pi-mcp-adapter').packageRoot;
  const keyringEntry=await resolveFile(emitted,mcpRoot,'@napi-rs/keyring','index.js');
  const keyringNativeEntry=await resolveFile(emitted,path.dirname(keyringEntry),'@napi-rs/keyring-win32-x64-msvc','keyring.win32-x64-msvc.node');
  // Existing bash selection is explicit/local; it is never executed in this gate.
  shell=await fs.realpath(registrationShell(shell,hostEnv));
  assert.ok((await fs.lstat(shell)).isFile());
  const defaults=defaultsFromInventories(stageRoot,JSON.parse(await fs.readFile(path.join(stageRoot,'resources/bundled-extensions.json'),'utf8')),managed.manifest);
  const before={sources:await sourceSnapshot(),recipe:await qualificationInputs(checkout),candidate:await tree(candidateRoot),stage:await tree(preparedStageRoot),receipt:hash(await fs.readFile(receiptPath))};
  // Evidence is a sibling, never part of the immutable candidate snapshot.
  const privateRoot=await fs.mkdtemp(path.join(path.dirname(candidateRoot),'pie-registration-'));
  for(const root of [candidateRoot,preparedStageRoot,runtimeRoot,checkout]) assert.ok(root!==privateRoot&&!inside(root,privateRoot)&&!inside(privateRoot,root));
  const dirs={};for(const key of ['home','appdata','localappdata','temp','agent','cache','work']) {dirs[key]=path.join(privateRoot,key);await fs.mkdir(dirs[key]);}
  const env=privateEnvironment(dirs,shell,hostEnv),resultPath=path.join(privateRoot,'result.json');
  const trustedHost={}; for(const key of ['SystemRoot','WINDIR','ComSpec','PATHEXT']) if(env[key]) trustedHost[key]=env[key];
  const config={stageRoot,runtimeRoot,privateRoot,sdkEntry,webRoot,mcpRoot,keyringEntry,keyringNativeEntry,workDir:dirs.work,agentDir:dirs.agent,resultPath,defaults,dirs,shell,hostEnv:trustedHost,noProvider:true,identity};
  const configBytes=JSON.stringify(config),configPath=path.join(privateRoot,'config.json'); await fs.writeFile(configPath,configBytes,{flag:'wx'});
  try {
    const outcome=await collectRegistrationOutcome({
      launch:()=>runStage({name:'delivery-registration',args:[childPath,configPath,hash(configBytes)]},{root:dirs.work,signal,env}),
      checks:{
        config:async()=>assert.equal(await fs.readFile(configPath,'utf8'),configBytes),
        reviewedFiles:async()=>assert.deepEqual(await sourceSnapshot(),before.sources),
        qualificationInputs:async()=>assert.deepEqual(await qualificationInputs(checkout),before.recipe),
        candidateTree:async()=>assert.deepEqual(await tree(candidateRoot),before.candidate),
        originalStageTree:async()=>assert.deepEqual(await tree(preparedStageRoot),before.stage),
        receipt:async()=>assert.equal(hash(await fs.readFile(receiptPath)),before.receipt),
        identity:async()=>assert.deepEqual(await verify(),identity),
      },
      writePostChecks:post=>fs.writeFile(path.join(privateRoot,'post-checks.json'),JSON.stringify(post,null,2),{flag:'wx'}),
      readReport:async()=>JSON.parse(await fs.readFile(resultPath,'utf8')),defaults,
    });
    signal?.throwIfAborted();
    const evidence={scope:'registration-only; cooperative Node guards, not OS sandbox or readiness',privateRoot,identity,inputs:before.sources,managedRecipeInputs:before.recipe,configSha256:hash(configBytes),resultSha256:hash(await fs.readFile(resultPath)),...outcome};
    const evidencePath=path.join(privateRoot,'registration-evidence.json');await fs.writeFile(evidencePath,JSON.stringify(evidence,null,2),{flag:'wx'});
    return {evidencePath,privateRoot};
  } catch(error) {
    await fs.writeFile(path.join(privateRoot,'failure.json'),JSON.stringify({error:String(error.message??error),privateRoot},null,2),{flag:'wx'}).catch(()=>{});
    throw new Error(`${error.message}; registration evidence retained at ${privateRoot}`,{cause:error});
  }
}
