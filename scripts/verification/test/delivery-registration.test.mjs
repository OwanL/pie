import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {CORE,REQUIRED_TOOLS,defaultsFromInventories,loadDefaults,validateRegistrationReport,privateEnvironment,validatePrivateEnvironment,registerExitReport,collectRegistrationOutcome,createDenialRecorder} from '../lib/delivery-registration.mjs';
const core={version:1,extensions:CORE.map(id=>({id,entry:`${id}.js`}))},managed={schemaVersion:1,packages:['pi-web-access','pi-mcp-adapter'].map(name=>({name,entry:`node_modules/${name}/index.ts`}))};
const defaults=defaultsFromInventories(os.tmpdir(),core,managed);
const report=()=>({ok:true,errors:[],denied:[],requests:[],extensions:defaults.map((d,i)=>({path:d.path,tools:[...REQUIRED_TOOLS[i]]}))});
const confirmed={code:0,outerConfirmed:true,innerConfirmed:true};
test('synthetic child rejects unsealed configuration before candidate resolution',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'registration-seal-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const config=path.join(root,'config.json');await writeFile(config,'{}');
 const child=spawnSync(process.execPath,[fileURLToPath(new URL('../fixtures/delivery-registration-child.mjs',import.meta.url)),config,'invalid-digest'],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(child.status,1);assert.match(child.stderr,/sealed config digest mismatch/);
});
test('missing report and postcheck persistence failure cannot pass',async()=>{
 for(const mode of ['report','post'])await assert.rejects(collectRegistrationOutcome({launch:async()=>confirmed,checks:{},writePostChecks:async()=>{if(mode==='post')throw Error('post failure');},readReport:async()=>{throw Error('missing report');},defaults}),mode==='post'?/post failure/:/missing report/);
});
test('exact inventory, distinct paths and required tools',()=>{
 validateRegistrationReport(report(),defaults);
 assert.throws(()=>defaultsFromInventories(os.tmpdir(),{...core,extensions:core.extensions.slice(1)},managed));
 for(const mode of ['duplicate','missing','denied']) {const r=report();if(mode==='duplicate')r.extensions[1].path=r.extensions[0].path;if(mode==='missing')r.extensions[0].tools=[];if(mode==='denied')r.denied.push('process.exec');assert.throws(()=>validateRegistrationReport(r,defaults));}
});
test('loader uses DEFAULT JITI and reload/get only',async()=>{
 let options;const calls=[];class Loader{constructor(o){options=o;}async reload(){calls.push('reload');}getExtensions(){calls.push('get');return 'loaded';}}
 assert.equal(await loadDefaults(Loader,{defaults,workDir:'work',agentDir:'agent'}),'loaded');
 assert.deepEqual(options,{cwd:'work',agentDir:'agent',noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,defaultExtensions:defaults});assert.deepEqual(calls,['reload','get']);
});
test('exact private environment excludes secrets and Windows injected-key drift',()=>{
 const privateRoot=path.join(os.tmpdir(),'registration-private'),dirs=Object.fromEntries(['home','appdata','localappdata','temp','agent','cache','work'].map(k=>[k,path.join(privateRoot,k)]));
 const shell=path.join(os.tmpdir(),'bash.exe'),hostEnv={systemroot:path.join(path.parse(os.tmpdir()).root,'Windows'),OPENAI_API_KEY:'secret',PATH:'host',NODE_OPTIONS:'bad'},env=privateEnvironment(dirs,shell,hostEnv),config={privateRoot,dirs,shell,hostEnv,workDir:dirs.work,agentDir:dirs.agent,noProvider:true};
 validatePrivateEnvironment(config,env,dirs.work);validatePrivateEnvironment(config,Object.fromEntries(Object.entries(env).map(([k,v])=>[k.toLowerCase(),v])),dirs.work);
 assert.equal(env.OPENAI_API_KEY,undefined);assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.PATH,'');assert.equal(env.HOMEDRIVE+env.HOMEPATH,dirs.home);
 for(const key of ['PATH','HOMEPATH','USERNAME','USERDOMAIN','LOGONSERVER','OPENAI_API_KEY'])assert.throws(()=>validatePrivateEnvironment(config,{...env,[key]:'host'},dirs.work));
});
test('denial after report serialization poisons completion and cannot pass parent acceptance',async()=>{
 const proc=new EventEmitter(),r=report(),diagnostics=[];let saved,post;
 const record=createDenialRecorder({process:proc,denied:r.denied,denyDiagnostics:diagnostics,phase:()=> 'late-exit'});
 registerExitReport({process:proc,report:r,resultPath:'result',writeSync:(_p,text)=>{saved=JSON.parse(text);}});
 // Models an asynchronous factory registering its exit listener after reload.
 proc.once('exit',()=>{try{record('process.exec');throw Error('DENIED');}catch{ /* swallowed by factory */ }});
 proc.emit('exit',0);
 assert.equal(saved.ok,true);assert.deepEqual(saved.denied,[]);assert.equal(proc.exitCode,1);
 assert.equal(diagnostics[0].phase,'late-exit');
 await assert.rejects(collectRegistrationOutcome({launch:async()=>({...confirmed,code:proc.exitCode}),checks:{unchanged:async()=>{}},writePostChecks:async p=>{post=p;},readReport:async()=>saved,defaults}),/child failure/);
 assert.equal(post.checks.unchanged.ok,true);
});
test('exit finalization catches late denials, nonzero exits and write failure',()=>{
 for(const mode of ['clean','late','nonzero']){const proc=new EventEmitter(),r=report();let saved;proc.once('exit',()=>{if(mode==='late')r.denied.push('process.exec');});registerExitReport({process:proc,report:r,resultPath:'result',writeSync:(_p,text)=>{saved=JSON.parse(text);}});assert.equal(saved,undefined);proc.emit('exit',mode==='nonzero'?1:0);assert.equal(saved.ok,mode==='clean');}
 const proc=new EventEmitter();registerExitReport({process:proc,report:report(),resultPath:'result',writeSync:()=>{throw Error('write failure');}});assert.throws(()=>proc.emit('exit',0),/write failure/);assert.equal(proc.exitCode,1);
});
test('seven postchecks always run and preserve primary failure; report accepted last',async()=>{
 for(const mode of ['throw','failed','abort','mutation','pass']){const calls=[];let saved;const checks=Object.fromEntries(['config','reviewedFiles','qualificationInputs','candidateTree','originalStageTree','receipt','identity'].map((name,i)=>[name,async()=>{calls.push(name);if((mode==='throw'||mode==='mutation')&&i===0)throw Error('mutation');}]));
 const operation=collectRegistrationOutcome({launch:async()=>{if(mode==='throw')throw Error('original launcher error');if(mode==='abort')throw Error('cancelled');return mode==='failed'?{...confirmed,innerConfirmed:false}:confirmed;},checks,writePostChecks:async p=>{saved=p;calls.push('post');},readReport:async()=>{calls.push('report');return report();},defaults});
 if(mode==='pass'){await operation;assert.equal(calls.at(-1),'report');}else{await assert.rejects(operation,mode==='throw'?/original launcher error/:mode==='abort'?/cancelled/:mode==='mutation'?/revalidation/:/unconfirmed/);assert.ok(!calls.includes('report'));}assert.equal(Object.keys(saved.checks).length,7);assert.equal(calls.slice(0,7).length,7);
 }
});
