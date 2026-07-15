import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CONTAINER_IMAGE, containerImageDigest, startContainerBroker } from "../lib/container-runtime.mjs";

const exec=promisify(execFile);
async function fakeProvider(){const server=http.createServer(async(req,res)=>{for await(const _ of req){}res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({choices:[{message:{role:"assistant",content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1}}));});await new Promise(ok=>server.listen(0,"0.0.0.0",ok));return{url:`http://host.docker.internal:${server.address().port}/v1`,close:()=>new Promise(ok=>server.close(ok))};}

test("container target reaches only its broker network and receives no credential",{timeout:60000},async()=>{
 assert.match(containerImageDigest(),/^sha256:[a-f0-9]{64}$/);const dir=await mkdtemp(join(tmpdir(),"pie-container-")),provider=await fakeProvider(),experimentId=`container-test-${process.pid}`,trialId=`trial-${Date.now()}`;let broker;
 try{broker=await startContainerBroker({experimentId,trialId,trialDir:dir,apiKey:"container-secret-canary",upstream:provider.url,maxRequests:3,maxOutputTokens:100,timeoutMs:30000,onLog:()=>{}});const script=`const token=process.argv[1],hostUrl=process.argv[2]; const broker=await fetch('http://broker:8787/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({model:'umans-glm-5.2',messages:[{role:'user',content:'x'}]})}); let internet=false,host=false; try{await fetch('https://example.com',{signal:AbortSignal.timeout(2500)});internet=true}catch{} try{await fetch(hostUrl,{signal:AbortSignal.timeout(2500)});host=true}catch{} console.log(JSON.stringify({broker:broker.status,internet,host,secrets:Object.keys(process.env).filter(k=>/KEY|SECRET|TOKEN|AUTH/.test(k)),secretFile:await import('node:fs').then(fs=>fs.existsSync('/run/secrets/umans'))}));`;
 const {stdout}=await exec("docker",["run","--rm","--name",broker.targetName,"--network",broker.network,"--cap-drop","ALL","--security-opt","no-new-privileges","--read-only","--tmpfs","/tmp:rw,noexec,nosuid,size=16m",CONTAINER_IMAGE,"-e",script,broker.token,provider.url],{timeout:15000});const result=JSON.parse(stdout.trim());assert.deepEqual(result,{broker:200,internet:false,host:false,secrets:[],secretFile:false});const network=JSON.parse((await exec("docker",["network","inspect",broker.network])).stdout)[0];assert.equal(network.Internal,true);
 }finally{await broker?.close();await provider.close();await rm(dir,{recursive:true,force:true});}
});
