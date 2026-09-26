import { buildContextWindowBreakdown } from './breakdown';

type BreakdownOptions = Parameters<typeof buildContextWindowBreakdown>[0];

interface BreakdownWorkerRequest {
  id: number;
  options: BreakdownOptions;
}

interface BreakdownWorkerResponse {
  id: number;
  breakdown?: ReturnType<typeof buildContextWindowBreakdown>;
  error?: string;
}

interface WorkerPort {
  onmessage: ((event: MessageEvent<BreakdownWorkerRequest>) => void) | null;
  postMessage(message: BreakdownWorkerResponse): void;
}

// Node's focused component tests load Vite's `?worker&url` import as a regular
// module. Keep that harmless while retaining the normal worker entrypoint in a
// browser worker global.
if (typeof self !== 'undefined') {
  const port = self as unknown as WorkerPort;
  port.onmessage = (event) => {
    const { id, options } = event.data;
    try {
      port.postMessage({ id, breakdown: buildContextWindowBreakdown(options) });
    } catch (error) {
      port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
  };
}

// Vite replaces `?worker&url` imports with the emitted asset URL. Pie's fast
// esbuild test bundler does not implement that query transform, so expose an
// inert default there; tests take the Worker-unavailable fallback path.
export default '';
