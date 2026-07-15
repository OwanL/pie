import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ALLOWED_MODELS } from "./core.mjs";

const COPY = ["PATH","SystemRoot","ComSpec","PATHEXT","WINDIR","LANG","LC_ALL","TERM","COLORTERM"];
const SECRET = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)(?:$|_)/i;
export function buildChildEnv(parent, home, extra={}) {
  const env={}; for(const key of COPY) if(parent[key]!==undefined) env[key]=parent[key];
  Object.assign(env,{HOME:home,USERPROFILE:home,HOMEDRIVE:resolve(home).slice(0,2),HOMEPATH:resolve(home).slice(2),LOCALAPPDATA:join(home,"local"),APPDATA:join(home,"roaming"),XDG_CONFIG_HOME:join(home,".config"),TMP:join(home,"tmp"),TEMP:join(home,"tmp"),TMPDIR:join(home,"tmp"),LANG:env.LANG||"C.UTF-8"},extra);
  for(const [k,v] of Object.entries(env)) if(SECRET.test(k)&&!k.startsWith("PIE_BENCHMARK_")) throw new Error(`Secret-like child variable rejected: ${k}`); else if(typeof v!=="string") throw new Error(`Non-string environment value: ${k}`);
  return env;
}
export async function createRuntimeIdentity(root,{baseUrl,token}) {
  const agentDir=join(root,"agent"),home=join(root,"home"); await Promise.all([mkdir(agentDir,{recursive:true}),mkdir(join(home,"tmp"),{recursive:true}),mkdir(join(home,"local"),{recursive:true}),mkdir(join(home,"roaming"),{recursive:true}),mkdir(join(home,".config"),{recursive:true})]);
  await writeFile(join(agentDir,"auth.json"),"{}\n",{mode:0o600});
  const models={providers:{umans:{baseUrl,api:"openai-completions",apiKey:token,compat:{supportsReasoningEffort:true,sendSessionAffinityHeaders:true},models:ALLOWED_MODELS.map(id=>({id,name:id,reasoning:true,input:["text"],contextWindow:id.includes("glm")?405504:262144,maxTokens:id.includes("glm")?65536:32768,thinkingLevelMap:{off:"none",minimal:"minimal",low:"low",medium:"medium",high:"high",xhigh:"xhigh"},cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}))}}};
  await writeFile(join(agentDir,"models.json"),`${JSON.stringify(models,null,2)}\n`,{mode:0o600});
  return {agentDir,home,modelsPath:join(agentDir,"models.json"),authPath:join(agentDir,"auth.json")};
}
export function assertAllowedAvailable(models) { const ids=models.map(m=>`${m.provider}/${m.id}`).sort(); const expected=ALLOWED_MODELS.map(id=>`umans/${id}`).sort(); if(JSON.stringify(ids)!==JSON.stringify(expected)) throw new Error(`Available-model policy violation: ${ids.join(", ")}`); }
