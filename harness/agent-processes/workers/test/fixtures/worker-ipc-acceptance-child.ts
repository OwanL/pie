import {
  openWorkerServerTransport,
  parseWorkerServerArgs,
  WorkerServer,
} from '../../../lib/rpc/worker-server.js';

try {
  const identity = parseWorkerServerArgs(process.argv.slice(2));
  const transport = openWorkerServerTransport(identity);
  const server = new WorkerServer(identity, process, transport, {
    // Deliberately isolate inherited-fd acceptance from either runtime's
    // filesystem validation. The bootstrap frame still passes the production
    // closed IPC schema before this test-only validator seam is reached.
    validateBootstrap: (frame) => {
      if (frame.sdkRuntime.kind !== 'legacy-patched' && frame.sdkRuntime.kind !== 'source-artifact') {
        throw new Error('Fixture received an unknown SDK runtime selection.');
      }
    },
  });
  server.start();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
}
