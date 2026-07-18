import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { capBashTimeout, classifyToolCall } from "./lib/policy.mjs";

const config=JSON.parse(await readFile(process.argv[2],"utf8"));
const sdkPath=resolve(import.meta.dirname,"../../extension/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const sdk=await import(pathToFileURL(sdkPath));
const extensionLoader=await import(pathToFileURL(resolve(import.meta.dirname,"../../extension/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")));
const emit=(type,data={})=>process.stdout.write(`${JSON.stringify({type,at:new Date().toISOString(),...data})}\n`);
let session;
try{
  const authStorage=sdk.AuthStorage.create(config.authPath);
  const modelRegistry=sdk.ModelRegistry.create(authStorage,config.modelsPath);
  const available=await modelRegistry.getAvailable();
  const ids=available.map(m=>`${m.provider}/${m.id}`).sort();
  const expected=["umans/umans-glm-5.2","umans/umans-kimi-k2.7"];
  if(JSON.stringify(ids)!==JSON.stringify(expected)) throw Object.assign(new Error(`Available-model policy violation: ${ids.join(", ")}`),{classification:"provider_policy_violation"});
  const model=modelRegistry.find("umans",config.model); if(!model) throw new Error(`Selected model missing: ${config.model}`);
  if(config.capabilityVariant)globalThis.__PIE_BENCHMARK_CAPABILITY_VARIANT=config.capabilityVariant;
  const runtime=sdk.createExtensionRuntime(),eventBus=sdk.createEventBus(),policyViolations=[];
  const loaded=config.extensions?.length?await extensionLoader.loadExtensions(config.extensions,config.cwd,eventBus,runtime):{extensions:[],errors:[],runtime};
  const policyExtension=await extensionLoader.loadExtensionFromFactory((pi)=>pi.on("tool_call",(event)=>{capBashTimeout(event,config.maxBashTimeoutSeconds||60);const inputPath=typeof event.input?.path==="string"?resolve(event.input.path):undefined,declaredSkillRead=event.toolName==="read"&&inputPath!==undefined&&(inputPath==="/bundle/skills"||inputPath.startsWith("/bundle/skills/"));const violation=declaredSkillRead?undefined:classifyToolCall(event,config.cwd);if(violation){policyViolations.push(violation);return{block:true,reason:violation.reason};}}),config.cwd,eventBus,runtime,"<inline:workspace-policy>");
  const telemetryExtension=await extensionLoader.loadExtensionFromFactory((pi)=>pi.on("before_provider_request",(event)=>{const payload=JSON.stringify(event.payload),tools=Array.isArray(event.payload?.tools)?event.payload.tools:[],toolNames=tools.map(tool=>tool?.function?.name||tool?.name).filter(Boolean),markers=(config.capabilityTelemetry?.markers||[]).filter(marker=>payload.includes(marker));emit("provider_request",{payloadChars:payload.length,toolNames,markers});}),config.cwd,eventBus,runtime,"<inline:capability-telemetry>");
  loaded.extensions.push(policyExtension,telemetryExtension);
  if(loaded.errors?.length) throw new Error(`Extension load failed: ${JSON.stringify(loaded.errors)}`);
  const basePrompt=`You are a coding agent working in an existing repository. Work only in ${config.cwd}. Do not access credentials, profiles, external networks, or paths outside this repository. Use only the available tools and finish by verifying the requested change.`;
  const resourceLoader={
    getExtensions:()=>loaded,
    getSkills:()=>({skills:config.skills||[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),
    getSystemPrompt:()=>config.systemPromptOverride||basePrompt,getAppendSystemPrompt:()=>config.appendSystemPrompt?[config.appendSystemPrompt]:[],extendResources:()=>{},reload:async()=>{},
  };
  const settingsManager=sdk.SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},defaultProjectTrust:false},{projectTrusted:false});
  const result=await sdk.createAgentSession({cwd:config.cwd,agentDir:config.agentDir,model,thinkingLevel:config.thinking,authStorage,modelRegistry,resourceLoader,tools:config.tools,sessionManager:sdk.SessionManager.inMemory(config.cwd),settingsManager});
  session=result.session;
  const snapshot={availableModels:ids,model:`${session.model.provider}/${session.model.id}`,thinking:session.thinkingLevel,tools:session.agent.state.tools.map(t=>t.name).sort(),extensions:loaded.extensions.map(e=>e.path||e.name||"inline"),resources:{skills:(config.skills||[]).length,prompts:0,themes:0,contextFiles:0},projectTrusted:false,agentDir:config.agentDir,authPath:config.authPath,modelsPath:config.modelsPath};
  if(snapshot.tools.some(t=>!config.tools.includes(t))) throw Object.assign(new Error(`Unexpected tool: ${snapshot.tools.join(",")}`),{classification:"resource_policy_violation"});
  emit("startup",{snapshot});
  session.subscribe(event=>{
    if(event.type==="tool_execution_start") emit("tool_start",{toolCallId:event.toolCallId,toolName:event.toolName,args:event.args});
    else if(event.type==="tool_execution_end") emit("tool_end",{toolCallId:event.toolCallId,toolName:event.toolName,isError:event.isError});
    else if(event.type==="message_end") emit("message_end",{message:event.message});
    else if(["agent_start","agent_end","agent_settled","turn_start","turn_end","auto_retry_start","auto_retry_end"].includes(event.type)) emit(event.type);
  });
  await session.prompt(await readFile(config.promptPath,"utf8"),{expandPromptTemplates:false});
  emit("complete",{messages:session.messages,policyViolations});
}catch(error){emit("failure",{classification:error.classification||"target_failure",error:String(error?.stack||error)});process.exitCode=1;}finally{try{session?.dispose()}catch{}}
