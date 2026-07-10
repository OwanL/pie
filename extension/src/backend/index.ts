import { parseArgs } from './rpc';
import { log } from './server-io';
import { BackendServer } from './server';
import { installProviderTrafficObserver } from './provider-traffic-observer';

export { BackendServer } from './server';

async function main(): Promise<void> {
  // Observe LLM provider traffic at the undici/fetch layer so connection-level
  // failures surface their real cause (ECONNRESET/ETIMEDOUT/…) instead of the
  // bare "Connection error." the SDK leaves in the session JSONL. Observe-only;
  // set PIE_PROVIDER_TRAFFIC_LOG=0 to disable. Must run before any fetch.
  installProviderTrafficObserver();
  const server = new BackendServer(parseArgs(process.argv.slice(2)));
  await server.start();
}

if (require.main === module) {
  void main().catch((error) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
