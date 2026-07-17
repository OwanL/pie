import http from "node:http";
import { randomBytes } from "node:crypto";
import { ALLOWED_MODELS, redact } from "./lib/runtime-support.mjs";

const SAFE_RESPONSE_HEADERS=["content-type","cache-control","x-request-id","x-session-id","x-session-affinity"];
const SAFE_REQUEST_HEADERS=["content-type","accept","x-request-id","x-session-id","x-session-affinity"];
export async function startBroker({upstream="https://api.code.umans.ai/v1",apiKey,timeoutMs=3600000,onLog=()=>{},token=randomBytes(32).toString("base64url"),listenHost="127.0.0.1",listenPort=0,advertisedHost=listenHost}) {
  if(!apiKey) throw new Error("UMANS_API_KEY is required by the controller");
  const started=Date.now(); let requests=0,outputTokens=0,closed=false;
  const server=http.createServer(async(req,res)=>{
    const record={at:new Date().toISOString(),method:req.method,path:req.url,accepted:false};let logged=false;
    try{
      if(closed||Date.now()-started>timeoutMs) throw Object.assign(new Error("Broker token expired"),{status:401});
      if(req.headers.authorization!==`Bearer ${token}`) throw Object.assign(new Error("Invalid session token"),{status:401});
      requests++;
      const chunks=[]; for await(const c of req) chunks.push(c); const rawBody=Buffer.concat(chunks);if(rawBody.length>10_000_000)throw Object.assign(new Error("Request body too large"),{status:413}); let payload={}; try{payload=JSON.parse(rawBody)}catch{throw Object.assign(new Error("Invalid JSON payload"),{status:400});}
      record.model=payload.model; if(!ALLOWED_MODELS.includes(payload.model)) throw Object.assign(new Error(`Model not allowed: ${payload.model}`),{status:403,classification:"provider_policy_violation"});
      const body=Buffer.from(JSON.stringify(payload));
      const target=new URL(req.url||"/",upstream.endsWith("/")?upstream:`${upstream}/`); if(target.origin!==new URL(upstream).origin) throw Object.assign(new Error("Invalid upstream destination"),{status:400});
      const headers={authorization:`Bearer ${apiKey}`}; for(const h of SAFE_REQUEST_HEADERS) if(req.headers[h]) headers[h]=req.headers[h];
      record.accepted=true;onLog(record);logged=true;const remaining=Math.max(1,timeoutMs-(Date.now()-started));const upstreamResponse=await fetch(target,{method:req.method,headers,body:req.method==="GET"?undefined:body,signal:AbortSignal.timeout(remaining)}); res.statusCode=upstreamResponse.status; for(const h of SAFE_RESPONSE_HEADERS){const v=upstreamResponse.headers.get(h);if(v)res.setHeader(h,v);} record.status=upstreamResponse.status;let responseText="";if(upstreamResponse.body){for await(const c of upstreamResponse.body){if(responseText.length<2_000_000)responseText+=Buffer.from(c).toString("utf8");res.write(c);}}let responseOutputTokens=0;for(const line of responseText.split(/\r?\n/)){if(!line.startsWith("data: ")||line==="data: [DONE]")continue;try{const value=JSON.parse(line.slice(6)),used=Number(value.usage?.completion_tokens??value.usage?.output_tokens??0);if(used>responseOutputTokens)responseOutputTokens=used;}catch{}}if(!responseOutputTokens)try{const value=JSON.parse(responseText),used=Number(value.usage?.completion_tokens??value.usage?.output_tokens??0);if(used>0)responseOutputTokens=used;}catch{}outputTokens+=responseOutputTokens;record.outputTokens=outputTokens;res.end();
    }catch(error){record.status=error.status||500;record.classification=error.classification;record.error=redact(error.message,[apiKey,token]);if(!logged)onLog(record);res.writeHead(record.status,{"content-type":"application/json"});res.end(JSON.stringify({error:{message:record.error,type:record.classification||"broker_error"}}));}
  });
  await new Promise((ok,fail)=>{server.once("error",fail);server.listen(listenPort,listenHost,ok)}); const {port}=server.address();
  return {token,baseUrl:`http://${advertisedHost}:${port}/v1`,close:async()=>{closed=true;await new Promise(ok=>server.close(ok));},get requestCount(){return requests;}};
}
