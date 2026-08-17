/**
 * Runtime factory extracted from BackendServer.
 * Creates an agent session runtime from the SDK services.
 */

import { prepareContextFiles } from './context-files';
import { backendInfo } from './log';
import { recordBackendLivePipelineTrace } from './live-pipeline-trace-runtime';
import type { SdkModule, SdkSessionEvent, SdkSessionManager } from './sdk';

/** Arguments the SDK passes into the runtime factory callback. */
interface RuntimeFactoryArgs {
  cwd: string;
  agentDir: string;
  sessionManager: SdkSessionManager;
  sessionStartEvent?: SdkSessionEvent;
}

/** Thrown by `ServiceLoadingGate` for work queued after (or refused during)
 *  server disposal. Distinct class so tests and callers can identify the
 *  shutdown path without string-matching. */
export class ServiceLoadingGateDisposedError extends Error {
  constructor() {
    super('The backend is shutting down; session service creation was cancelled.');
    this.name = 'ServiceLoadingGateDisposedError';
  }
}

/**
 * Backend-wide FIFO admission gate with a concurrency cap of one, wrapping
 * `sdk.createAgentSessionServices` — the heaviest part of session startup
 * (extension + resource loading). Concurrent session opens during an active
 * generation used to run these creations in parallel and saturate the
 * process, stalling other UI interactions; the gate serializes them in
 * enqueue order.
 *
 * One gate instance is owned by a `BackendServer` and shared by every
 * runtime-factory invocation it creates, regardless of cwd. Results are never
 * cached or shared: every admitted call runs its own task and every session
 * still receives unique fresh services/resource loader/extension runtime.
 * The slot is released on both success and failure.
 *
 * `dispose()` rejects all queued work and refuses future admissions; an
 * admitted in-flight call is allowed to settle (the resulting late runtime is
 * refused installation by the server's existing ownership checks).
 */
export class ServiceLoadingGate {
  private active = false;
  private disposed = false;
  private queue: Array<{
    run: () => void;
    reject: (error: unknown) => void;
  }> = [];

  /** Admit `task` under the FIFO cap of one. Resolves with the task result,
   *  rejects with the task's error, or with `ServiceLoadingGateDisposedError`
   *  once the gate has been disposed. */
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new ServiceLoadingGateDisposedError());
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        run: () => {
          this.active = true;
          Promise.resolve()
            .then(task)
            .then(
              (value) => {
                this.active = false;
                this.wakeNext();
                resolve(value);
              },
              (error) => {
                this.active = false;
                this.wakeNext();
                reject(error);
              },
            );
        },
        reject,
      });
      if (!this.active) this.wakeNext();
    });
  }

  private wakeNext(): void {
    if (this.active || this.disposed) return;
    const next = this.queue.shift();
    if (!next) return;
    next.run();
  }

  /** Reject all queued work and refuse future admissions (server shutdown).
   *  Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new ServiceLoadingGateDisposedError();
    for (const waiter of this.queue) waiter.reject(error);
    this.queue = [];
  }
}

// SDK accepts authStorage as unknown; kept untyped at the seam (no tighter type exists).
// `SdkModule.createAgentSessionServices` types its entire `options` bag as `unknown`,
// and `SdkModule.AuthStorage.create` returns `unknown`, so a narrower type here would lie.
export function createRuntimeFactory(
  sdk: SdkModule,
  authStorage: unknown,
  _startupCwd: string,
  gate: ServiceLoadingGate,
) {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }: RuntimeFactoryArgs) => {
    const startedAt = performance.now();
    const session = sessionManager.getSessionFile?.();
    // Inclusive aggregate span: covers the FIFO gate wait plus the opaque
    // `createAgentSessionServices` call. The SDK exposes no seam that separates
    // extension loading from service loading, so no finer extension phase is
    // claimed; the only resource-loader boundary the SDK exposes is the
    // agents-files override callback below. Bootstrap spans live in the
    // `backend.runtime` stage, distinct from `backend.request` request work.
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'start',
      phase: 'service_loading',
      identifiers: session ? { session } : undefined,
      processRole: 'coordinator',
      pid: process.pid,
    });
    // `SdkModule.createAgentSessionServices` returns `Promise<unknown>`; the
    // `Record<string, unknown>` narrowing is the minimal spread/assignment-compatible
    // shape required to forward `services` into `createAgentSessionFromServices`.
    // Service creation is the heavy part of session startup (extension + resource
    // loading); it alone runs inside the backend-wide FIFO admission gate so
    // concurrent session opens cannot saturate the process during an active
    // generation. Every admitted call still creates unique fresh services.
    let services: Record<string, unknown>;
    try {
      services = (await gate.run(() => sdk.createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
      editorVersion: resolveEditorVersion(),
      resourceLoaderOptions: {
        // Real resource-loader boundary: the SDK invokes this callback during
        // `resourceLoader.reload()`. It observes only the agents-files override
        // step; extension loading has no callback boundary and is deliberately
        // not claimed as a separate phase.
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
          const resourceStartedAt = performance.now();
          recordBackendLivePipelineTrace({
            stage: 'backend.runtime',
            kind: 'start',
            phase: 'resource_loading',
            identifiers: session ? { session } : undefined,
            processRole: 'coordinator',
            pid: process.pid,
          });
          try {
            const agentsFiles = prepareContextFiles(base.agentsFiles).map((contextFile) => ({
              path: contextFile.path,
              content: contextFile.content,
            }));
            recordBackendLivePipelineTrace({
              stage: 'backend.runtime',
              kind: 'success',
              phase: 'resource_loading',
              durationMs: Math.max(0, performance.now() - resourceStartedAt),
              identifiers: session ? { session } : undefined,
              processRole: 'coordinator',
              pid: process.pid,
            });
            return { agentsFiles };
          } catch (error) {
            recordBackendLivePipelineTrace({
              stage: 'backend.runtime',
              kind: 'failure',
              phase: 'resource_loading',
              durationMs: Math.max(0, performance.now() - resourceStartedAt),
              identifiers: session ? { session } : undefined,
              reasonCode: 'unknown_unattributable',
              processRole: 'coordinator',
              pid: process.pid,
            });
            throw error;
          }
        },
      },
      }))) as Record<string, unknown>;
    } catch (error) {
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'failure',
        phase: 'service_loading',
        durationMs: Math.max(0, performance.now() - startedAt),
        identifiers: session ? { session } : undefined,
        reasonCode: 'unknown_unattributable',
        processRole: 'coordinator',
        pid: process.pid,
      });
      throw error;
    }
    const servicesReadyAt = performance.now();
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'success',
      phase: 'service_loading',
      durationMs: Math.max(0, servicesReadyAt - startedAt),
      identifiers: { session: sessionManager.getSessionFile?.() },
      processRole: 'coordinator',
      pid: process.pid,
    });

    // `SdkModule.createAgentSessionFromServices` returns `Promise<unknown>`; cast to
    // `Record<string, unknown>` only so the result can be spread below. No tighter
    // interface is claimed than the SDK contract declares.
    const sessionConstructionStartedAt = performance.now();
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'start',
      phase: 'session_construction',
      identifiers: session ? { session } : undefined,
      processRole: 'coordinator',
      pid: process.pid,
    });
    let created: Record<string, unknown>;
    try {
      created = (await sdk.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
      })) as Record<string, unknown>;
    } catch (error) {
      recordBackendLivePipelineTrace({
        stage: 'backend.runtime',
        kind: 'failure',
        phase: 'session_construction',
        durationMs: Math.max(0, performance.now() - sessionConstructionStartedAt),
        identifiers: session ? { session } : undefined,
        reasonCode: 'unknown_unattributable',
        processRole: 'coordinator',
        pid: process.pid,
      });
      throw error;
    }
    const completedAt = performance.now();
    recordBackendLivePipelineTrace({
      stage: 'backend.runtime',
      kind: 'success',
      phase: 'session_construction',
      durationMs: Math.max(0, completedAt - sessionConstructionStartedAt),
      identifiers: session ? { session } : undefined,
      processRole: 'coordinator',
      pid: process.pid,
    });
    backendInfo('backend-session-startup', 'runtime.created', {
      cwd,
      servicesMs: Math.round(servicesReadyAt - startedAt),
      sessionMs: Math.round(completedAt - servicesReadyAt),
      totalMs: Math.round(completedAt - startedAt),
    });

    return {
      ...created,
      services,
    };
  };
}

function resolveEditorVersion(): string | undefined {
  const configured = process.env.PIE_EDITOR_VERSION?.trim();
  return configured || undefined;
}