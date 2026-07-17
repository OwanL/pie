import { readFile } from "node:fs/promises";
import { startBroker } from "./broker.mjs";

const required=name=>{const value=process.env[name];if(!value)throw new Error(`Missing ${name}`);return value;};
const apiKey=(await readFile(required("PIE_BROKER_SECRET_FILE"),"utf8")).trim();
const broker=await startBroker({
  apiKey,
  token:required("PIE_BROKER_TOKEN"),
  upstream:process.env.PIE_BROKER_UPSTREAM,
  timeoutMs:Number(required("PIE_BROKER_TIMEOUT_MS")),
  listenHost:"0.0.0.0",
  listenPort:8787,
  advertisedHost:"broker",
  onLog:record=>process.stdout.write(`${JSON.stringify({type:"broker_log",record})}\n`),
});
process.stdout.write(`${JSON.stringify({type:"ready"})}\n`);
const stop=async()=>{await broker.close();process.exit(0);};
process.once("SIGTERM",stop);process.once("SIGINT",stop);
await new Promise(()=>{});
