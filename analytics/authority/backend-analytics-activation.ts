/** Canonical context validation and durable writer-admission/fence supervision
 * for the backend coordinator. Historical activation files are never read. */

import { resolvePieDataPaths } from '../../lib/data-root/pie-data-root.js';
import { assertAnalyticsBackendContext, type AnalyticsBackendContext } from './backend-analytics-context.js';
import {
  createSessionLifecycleWriterAdmission,
  type AnalyticsWriterIdentity,
  type AnalyticsWriterStorePort,
  type SessionLifecycleWriterAdmission,
} from './session-lifecycle-writer-store.js';

/** Ports the authority needs from its host process. Everything is injected:
 * the authority has no coordinator implementation dependency. */
export interface BackendAnalyticsActivationPorts {
  /** Resolved agent dir; combined with `PIE_DATA_DIR` to derive the durable
   * state root, exactly as the coordinator resolves it. */
  readonly agentDir: () => string;
  /** Loaded runtime build marker (`PIE_BUILD_ID`) used for the durable writer
   * identity. Supplied by the coordinator bundle, never re-derived here. */
  readonly buildId: string;
  /** Host process identity carried by the writer lease. */
  readonly hostPid: () => number | undefined;
  /** Storage-owner factory for its canonical SQLite lifecycle store. */
  readonly openWriterStore: (stateDir: string) => AnalyticsWriterStorePort;
}

export interface BackendAnalyticsActivationOptions {
  /** Required canonical capture identity; lifecycle admission authorizes writes. */
  readonly context: AnalyticsBackendContext;
}

/** Context validation and writer-admission supervision for one backend. */
export class BackendAnalyticsActivation {
  private writerStore?: AnalyticsWriterStorePort;
  private writerAdmission?: SessionLifecycleWriterAdmission;
  private writerIdentity?: AnalyticsWriterIdentity;
  private writerStateDir?: string;

  constructor(
    private readonly ports: BackendAnalyticsActivationPorts,
    private readonly options: BackendAnalyticsActivationOptions,
  ) {}

  get context(): AnalyticsBackendContext {
    return this.options.context;
  }

  get captureDescriptor(): AnalyticsBackendContext {
    return this.options.context;
  }

  get admission(): SessionLifecycleWriterAdmission | undefined {
    return this.writerAdmission;
  }

  get identity(): AnalyticsWriterIdentity | undefined {
    return this.writerIdentity;
  }

  get stateDir(): string | undefined {
    return this.writerStateDir;
  }

  /** Validate the complete host-supplied context before installing admission. */
  validate(): void {
    assertAnalyticsBackendContext(this.options.context);
  }

  /** Open the durable writer admission after validation. Requires a positive
   * host process identity; the authority generation is the host instance (the
   * lifecycle registry identifies the extension-host boot; the analytics
   * generation is a separate authority identity). */
  openWriterAdmission(): void {
    this.validate();
    const descriptor = this.captureDescriptor;
    const hostPid = this.ports.hostPid();
    if (typeof hostPid !== 'number' || !Number.isSafeInteger(hostPid) || hostPid <= 0) {
      throw new Error('Canonical analytics admission requires a positive host process identity.');
    }
    const dataPaths = resolvePieDataPaths({
      dataDir: process.env.PIE_DATA_DIR,
      agentDir: this.ports.agentDir(),
    });
    this.writerStateDir = dataPaths.stateDir;
    const store = this.ports.openWriterStore(dataPaths.stateDir);
    this.writerStore = store;
    const identity: AnalyticsWriterIdentity = {
      hostInstanceId: descriptor.hostInstanceId,
      workspaceId: descriptor.workspaceId,
      // The lifecycle registry identifies the extension-host boot. The
      // analytics generation is a separate authority identity, so use
      // the host instance as the writer-generation field here.
      generationId: descriptor.hostInstanceId,
      buildId: this.ports.buildId,
      processId: hostPid,
    };
    this.writerIdentity = identity;
    this.writerAdmission = createSessionLifecycleWriterAdmission(store, identity);
  }

  /** Wait for every process sharing this host's durable lifecycle authority to
   * release its writer lease. Manager fences cover the SDK call boundary, but
   * the durable census also includes coordinator, recorder, and worker leases.
   * A live lease never expires here: timeout is an explicit fail-closed result,
   * not permission to assume the writer stopped. */
  async waitForWriterLeases(timeoutMs: number): Promise<number> {
    const store = this.writerStore;
    const workspaceId = this.writerIdentity?.workspaceId;
    if (!store || !workspaceId) return 0;
    const startedAt = Date.now();
    for (;;) {
      const active = store.listAnalyticsWriterLeases(workspaceId).length;
      if (active === 0) return 0;
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) return active;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(25, remaining));
        timer.unref?.();
      });
    }
  }

  /** Close the writer store and drop every admission reference. Terminal:
   * a closed authority cannot be reopened in this process. */
  close(): void {
    this.writerStore?.close();
    this.writerStore = undefined;
    this.writerAdmission = undefined;
    this.writerIdentity = undefined;
    this.writerStateDir = undefined;
  }
}