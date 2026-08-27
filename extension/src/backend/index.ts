import * as path from 'node:path';

import { parseArgs } from './rpc';
import { log } from './server-io';
import { BackendServer } from './server';
import { installProviderTrafficObserver } from './provider-traffic-observer';
import { flushBackendLivePipelineTrace, recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';

export { BackendServer } from './server';

async function main(): Promise<void> {
  // Lifecycle ownership: this entry owns the process start record and the
  // pre-readiness failure record. `BackendServer.start()` owns the SDK-import
  // span and the readiness transition (`backend_mapping` success/ready);
  // `BackendServer.dispose()` owns the not-ready transition. No other site
  // records `process.lifecycle` for this process.
  recordBackendLivePipelineTrace({
    stage: 'process.lifecycle',
    kind: 'start',
    phase: 'backend_mapping',
    processRole: 'coordinator',
    pid: process.pid,
  });
  let server: BackendServer | undefined;
  try {
    // Observe LLM provider traffic at the undici/fetch layer so connection-level
  // failures surface their real cause (ECONNRESET/ETIMEDOUT/…) instead of the
  // bare "Connection error." the SDK leaves in the session JSONL. Observe-only;
  // set PIE_PROVIDER_TRAFFIC_LOG=0 to disable. Must run before any fetch.
    installProviderTrafficObserver();
    const args = parseArgs(process.argv.slice(2));
    server = new BackendServer({
      ...args,
      workerEntryPath: path.join(__dirname, 'worker-entry.js'),
      coldBrowseHelperEntryPath: path.join(__dirname, 'cold-browse-helper-entry.js'),
    });
    await server.start();
    if (process.env.PIE_PHASE2_PACKAGE_SMOKE === '1') {
      await server.runPhase2WorkerSmoke(path.join(process.cwd(), '.pie-phase2-package-smoke.jsonl'));
      await server.dispose();
      await new Promise<void>((resolve) => {
        process.stderr.write('[pie] phase4-package-smoke:promoted-command-retired\n', () => resolve());
      });
      process.exit(0);
    }
  } catch (error) {
    try {
      await server?.dispose();
    } catch (disposeError) {
      // Preserve the startup owner and its lifecycle record. Disposal failure is
      // secondary diagnostics and must not mask the reason readiness failed.
      log(`backend startup cleanup failed: ${disposeError instanceof Error ? disposeError.stack ?? disposeError.message : String(disposeError)}`);
    }
    recordBackendLivePipelineTrace({
      stage: 'process.lifecycle',
      kind: 'failure',
      phase: 'backend_mapping',
      readiness: 'not_ready',
      reasonCode: 'unknown_unattributable',
      processRole: 'coordinator',
      pid: process.pid,
    });
    await flushBackendLivePipelineTrace();
    throw error;
  }
}

if (require.main === module) {
  void main().catch((error) => {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
