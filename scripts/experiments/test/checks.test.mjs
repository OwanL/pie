import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../run.mjs";

const delay=ms=>new Promise(ok=>setTimeout(ok,ms));

test("timed-out checks kill their complete process tree",{timeout:15000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"pie-check-tree-")),pidFile=join(root,"child.pid"),script=join(root,"hang.mjs");
  await writeFile(script,`import{spawn}from"node:child_process";import{writeFileSync}from"node:fs";const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`);
  try{
    const result=await runCheck(`"${process.execPath}" "${script}"`,root,process.env,500,root);
    assert.equal(result.timedOut,true);
    assert.equal(result.passed,false);
    const pid=Number(await readFile(pidFile,"utf8"));await delay(300);
    assert.throws(()=>process.kill(pid,0),error=>error?.code==="ESRCH",`grandchild PID ${pid} survived`);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("a nonterminating external scorer is bounded",{timeout:10000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"pie-scorer-timeout-")),script=join(root,"scorer.mjs");
  await writeFile(script,"while(true){}\n");
  try{const result=await runCheck({script:"scorer.mjs"},root,process.env,300,root);assert.equal(result.timedOut,true);assert.equal(result.passed,false);}
  finally{await rm(root,{recursive:true,force:true});}
});
