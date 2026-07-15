import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChildEnv, createRuntimeIdentity, assertAllowedAvailable } from "../lib/security.mjs";

test("child environment is allowlisted and homes are synthetic",async()=>{const root=await mkdtemp(join(tmpdir(),"pie-env-"));const parent={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,OPENAI_API_KEY:"canary-openai",ANTHROPIC_API_KEY:"canary-anthropic",COPILOT_TOKEN:"canary-copilot",ARBITRARY_SECRET:"canary-secret",HOME:"/real/home",USERPROFILE:"C:\\real"};const env=buildChildEnv(parent,root);for(const key of ["OPENAI_API_KEY","ANTHROPIC_API_KEY","COPILOT_TOKEN","ARBITRARY_SECRET"])assert.equal(env[key],undefined);assert.equal(env.HOME,root);assert.equal(env.USERPROFILE,root);assert.match(env.TMP,/pie-env-/);await rm(root,{recursive:true,force:true});});
test("runtime identity contains only empty auth and benchmark models",async()=>{const root=await mkdtemp(join(tmpdir(),"pie-runtime-"));const r=await createRuntimeIdentity(root,{baseUrl:"http://127.0.0.1:1/v1",token:"ephemeral-canary"});assert.equal(await readFile(r.authPath,"utf8"),"{}\n");const text=await readFile(r.modelsPath,"utf8"),catalog=JSON.parse(text);assert.match(text,/umans-glm-5\.2/);assert.match(text,/umans-kimi-k2\.7/);assert.deepEqual(Object.keys(catalog.providers),["umans"]);await rm(root,{recursive:true,force:true});});
test("available model assertion fails closed",()=>{assert.doesNotThrow(()=>assertAllowedAvailable([{provider:"umans",id:"umans-kimi-k2.7"},{provider:"umans",id:"umans-glm-5.2"}]));assert.throws(()=>assertAllowedAvailable([{provider:"openai",id:"gpt"}]),/policy violation/);});
