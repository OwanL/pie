import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { experimentLifecycleSnapshot, runCheck } from "../run.mjs";
import { terminateProcessTree, withProcessTreeIsolation } from "../../lib/process-watchdog.mjs";

const delay=ms=>new Promise(ok=>setTimeout(ok,ms));

test("timed-out checks kill their complete process tree without touching an unrelated sentinel",{timeout:15000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"pie-check-tree-")),pidFile=join(root,"child.pid"),script=join(root,"hang.mjs");
  const baseline=experimentLifecycleSnapshot();
  const sentinel=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],withProcessTreeIsolation({stdio:"ignore",windowsHide:true}));
  await writeFile(script,`import{spawn}from"node:child_process";import{writeFileSync}from"node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
  try{
    const result=await runCheck(`"${process.execPath}" "${script}"`,root,process.env,500,root);
    assert.equal(result.timedOut,true);
    assert.equal(result.passed,false);
    assert.equal(result.cleanup.gone,true);
    const pid=Number(await readFile(pidFile,"utf8"));await delay(100);
    assert.throws(()=>process.kill(pid,0),error=>error?.code==="ESRCH",`grandchild PID ${pid} survived`);
    assert.doesNotThrow(()=>process.kill(sentinel.pid,0),"unrelated sentinel was terminated");
    assert.deepEqual(experimentLifecycleSnapshot(),baseline,"owned process registry returned to baseline");
  }finally{await terminateProcessTree(sentinel);await rm(root,{recursive:true,force:true});}
});

test("controller signal cleanup waits for descendant extinction",{timeout:20000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"pie-controller-signal-")),pidFile=join(root,"grandchild.pid"),hang=join(root,"hang.mjs"),controllerPath=join(root,"controller.mjs");
  await writeFile(hang,`import{spawn}from"node:child_process";import{writeFileSync}from"node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
  const checkCommand=`"${process.execPath}" "${hang}"`;
  await writeFile(controllerPath,`import{runCheck}from${JSON.stringify(pathToFileURL(join(import.meta.dirname,"..","run.mjs")).href)};process.on("message",signal=>process.emit(signal));await runCheck(${JSON.stringify(checkCommand)},${JSON.stringify(root)},process.env,60000,${JSON.stringify(root)});`);
  const controller=spawn(process.execPath,[controllerPath],withProcessTreeIsolation({stdio:["ignore","ignore","pipe","ipc"],windowsHide:true})),sentinel=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],withProcessTreeIsolation({stdio:"ignore",windowsHide:true}));
  let stderr="";controller.stderr.on("data",chunk=>stderr+=chunk);const closed=new Promise(resolve=>controller.once("close",(code,signal)=>resolve({code,signal})));
  try{
    let pid;for(let attempt=0;attempt<300;attempt++){try{pid=Number(await readFile(pidFile,"utf8"));if(pid>0)break;}catch{}await delay(10);}assert.ok(pid>0,`controller descendant published its PID: ${stderr}`);
    if(process.platform==="win32")controller.send("SIGTERM");else controller.kill("SIGTERM");
    const result=await closed;assert.equal(result.code,143,stderr);let alive=true;for(let attempt=0;attempt<200&&alive;attempt++){try{process.kill(pid,0);await delay(10);}catch{alive=false;}}assert.equal(alive,false,`signal-owned descendant ${pid} survived`);assert.doesNotThrow(()=>process.kill(sentinel.pid,0));
  }finally{await terminateProcessTree(controller);await terminateProcessTree(sentinel);await rm(root,{recursive:true,force:true});}
});

test("a nonterminating external scorer is bounded",{timeout:10000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"pie-scorer-timeout-")),script=join(root,"scorer.mjs");
  await writeFile(script,"while(true){}\n");
  try{const result=await runCheck({script:"scorer.mjs"},root,process.env,300,root);assert.equal(result.timedOut,true);assert.equal(result.passed,false);}
  finally{await rm(root,{recursive:true,force:true});}
});
