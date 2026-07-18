import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, appendFile, cp, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { ALLOWED_MODELS, redact } from "./runtime-support.mjs";

export { ALLOWED_MODELS, redact };
export const REPO = resolve(import.meta.dirname, "../../..");
export const DATA = join(REPO, "data", "experiments");
export const STATUSES = ["draft","materialized","baseline-ready","candidate-ready","smoke-running","full-running","analyzing","complete","blocked","cancelled"];
export const TRANSITIONS = {
  draft: ["materialized","blocked","cancelled"], materialized: ["baseline-ready","blocked","cancelled"],
  "baseline-ready": ["candidate-ready","blocked","cancelled"], "candidate-ready": ["smoke-running","full-running","blocked","cancelled"],
  "smoke-running": ["candidate-ready","full-running","analyzing","blocked","cancelled"], "full-running": ["analyzing","blocked","cancelled"],
  analyzing: ["complete","blocked","cancelled"], blocked: STATUSES.filter(s => !["blocked","complete"].includes(s)),
  complete: [], cancelled: [],
};

export function assertSafeId(id) { if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(id)) throw new Error(`Unsafe id: ${id}`); return id; }
export function experimentDir(id) { return join(DATA, assertSafeId(id)); }
export async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
export async function atomicJson(path, value) { await mkdir(dirname(path), {recursive:true}); const tmp=`${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; await writeFile(tmp, `${JSON.stringify(value,null,2)}\n`, {flag:"wx"}); try{for(let attempt=0;;attempt++)try{await rename(tmp,path);break;}catch(error){if(!["EPERM","EBUSY"].includes(error.code)||attempt>=8)throw error;await new Promise(ok=>setTimeout(ok,25*2**attempt));}}catch(error){await rm(tmp,{force:true}).catch(()=>{});throw error;} }
export async function hashPath(path) {
  const h=createHash("sha256");
  async function walk(p, prefix="") { const s=await stat(p); if(s.isDirectory()){ for(const n of (await readdir(p)).sort()) await walk(join(p,n),join(prefix,n)); } else { h.update(prefix.replaceAll("\\","/")+"\0"); h.update(await readFile(p)); } }
  await walk(path); return h.digest("hex");
}
export function git(args, options={}) { let r;const retries=Math.max(0,Number(options.retries)||0);for(let attempt=0;attempt<=retries;attempt++){r=spawnSync("git",args,{cwd:options.cwd??REPO,encoding:"utf8",stdio:options.stdio??"pipe"});if(r.status===0||attempt===retries)break;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50*2**attempt);}if(r.status!==0&&!options.allowFailure){const detail=[r.error&&`${r.error.code||r.error.name}: ${r.error.message}`,r.stderr,r.stdout].filter(Boolean).join("; ").trim();throw new Error(`git ${args.join(" ")} failed${detail?`: ${detail}`:""}`);}return r; }
export function initializeWorkspaceRepository(cwd) { const options={cwd,retries:3};git(["init","-q"],options);git(["config","core.autocrlf","false"],options);git(["add","-A"],options);git(["-c","user.name=Development Workspace","-c","user.email=dev@localhost","commit","-q","-m","Initial workspace"],options); }
export function currentCommit() { return git(["rev-parse","HEAD"]).stdout.trim(); }
export function ensureInside(root,path) { const rel=relative(resolve(root),resolve(path)); if(rel===""||(!rel.startsWith(`..${sep}`)&&rel!==".."&&!isAbsolute(rel))) return resolve(path); throw new Error(`Path escapes ${root}: ${path}`); }
export async function appendJournal(id,text) { const p=join(experimentDir(id),"journal.md"); await appendFile(p,`\n## ${new Date().toISOString()}\n\n${text.trim()}\n`); }
export async function loadExperiment(id) { const value=await readJson(join(experimentDir(id),"experiment.json")); validateExperiment(value); return value; }
export function validateExperiment(x) { if(x?.schemaVersion!==1) throw new Error("Unsupported experiment schemaVersion"); assertSafeId(x.id); if(!STATUSES.includes(x.status)) throw new Error(`Invalid status: ${x.status}`); if(typeof x.hypothesis!=="string"||x.hypothesis.trim().length<10) throw new Error("A falsifiable hypothesis is required"); if(!Array.isArray(x.models)||x.models.some(m=>m.provider!=="umans"||!ALLOWED_MODELS.includes(m.id))) throw new Error("Only the benchmark Umans models are allowed"); if(!Number.isInteger(x.samples)||x.samples<1) throw new Error("samples must be a positive integer"); return x; }
export async function transition(id,next,note) { const x=await loadExperiment(id); if(!TRANSITIONS[x.status]?.includes(next)) throw new Error(`Illegal transition ${x.status} -> ${next}`); x.status=next; x.updatedAt=new Date().toISOString(); await atomicJson(join(experimentDir(id),"experiment.json"),x); if(note) await appendJournal(id,note); return x; }
export async function acquireLock(id,purpose="run") { const p=join(experimentDir(id),"lock.json");await mkdir(dirname(p),{recursive:true});if(existsSync(p)){const old=await readJson(p);try{process.kill(old.pid,0);throw new Error(`Experiment locked by live PID ${old.pid}`);}catch(e){if(e.code!=="ESRCH")throw e;}await rename(p,`${p}.stale-${Date.now()}`);}const value={pid:process.pid,purpose,createdAt:new Date().toISOString()};try{await writeFile(p,`${JSON.stringify(value,null,2)}\n`,{flag:"wx"});}catch(e){if(e.code==="EEXIST")throw new Error("Experiment lock was acquired concurrently");throw e;}return async()=>{try{const x=await readJson(p);if(x.pid===process.pid)await rm(p);}catch{}};
}
export async function copyDirectory(from,to) { await rm(to,{recursive:true,force:true}); await mkdir(dirname(to),{recursive:true}); await cp(from,to,{recursive:true,errorOnExist:true}); }
export async function snapshotExperimentInputs(id){const root=join(experimentDir(id),"inputs"),source=join(root,"source"),benchmarks=join(source,"benchmarks"),scripts=join(source,"scripts");if(existsSync(root))throw new Error(`Experiment inputs already exist: ${root}`);await mkdir(source,{recursive:true});await cp(join(REPO,"benchmarks"),benchmarks,{recursive:true,errorOnExist:true});await cp(join(REPO,"scripts"),scripts,{recursive:true,errorOnExist:true});let experiment;try{experiment=await loadExperiment(id);}catch{}const recipeDir=experiment?.recipe?join(REPO,"benchmarks","recipes",experiment.recipe):undefined,recipe=recipeDir&&existsSync(join(recipeDir,"recipe.json"))?await readJson(join(recipeDir,"recipe.json")):undefined,treatmentSources=[];for(const entry of recipe?.apply?.sourcePaths||[]){const from=ensureInside(REPO,resolve(recipeDir,entry.source)),to=ensureInside(source,resolve(source,entry.destination));await cp(from,to,{recursive:true,errorOnExist:true});treatmentSources.push({destination:relative(source,to).replaceAll("\\","/"),hash:await hashPath(to)});}const value={benchmarksHash:await hashPath(benchmarks),runnerHash:await hashPath(scripts),treatmentSources,createdAt:new Date().toISOString()};await atomicJson(join(root,"manifest.json"),value);return value;}
export function seededOrder(seed,key) { const n=Number.parseInt(createHash("sha256").update(`${seed}:${key}`).digest("hex").slice(0,8),16); return n%2===0?["baseline","candidate"]:["candidate","baseline"]; }
