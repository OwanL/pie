/**
 * Canonical analytics activation supervision for the backend coordinator.
 *
 * This module owns the analytics-authority side of backend startup: descriptor
 * validation against the exact active manifest bytes, and durable
 * writer-admission/fence supervision over the session-lifecycle store. The
 * coordinator keeps request/session/worker composition and calls this module
 * behind the prepared port; this module never imports coordinator
 * implementation, so no analytics-to-coordinator implementation dependency
 * exists. Exactly one manifest-selected authority is activated: a descriptor
 * is validated against the active manifest before any writer admission is
 * installed, and legacy callers (no descriptor) keep legacy behavior.
 */

import path from 'node:path';

import { resolvePieDataPaths } from '../../lib/data-root/pie-data-root.js';
import { ActivationStore } from './activation-store.js';
import type { AnalyticsBackendDescriptor } from './activation.js';
import {
  createSessionLifecycleWriterAdmission,
  type AnalyticsWriterIdentity,
  type SessionLifecycleWriterAdmission,
} from './session-lifecycle-writer-store.js';
import { SessionLifecycleStore } from '../../harness/session-storage/lifecycle/session-lifecycle-store.js';

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
}

export interface BackendAnalyticsActivationOptions {
  /** Immutable canonical analytics authority snapshot supplied by the host.
   * When present, startup validates it against the active manifest before any
   * writer admission is installed. */
  readonly descriptor?: AnalyticsBackendDescriptor;
}

/**
 * Descriptor validation + writer-admission/fence supervision for one backend
 * process. Writer admission is opened only after `validate()` proved the
 * descriptor matches the active manifest, so a candidate/ready generation, a
 * stale revision, or any build/generation mismatch cannot reach a worker or
 * install a durable writer.
 */
export class BackendAnalyticsActivation {
  private writerStore?: SessionLifecycleStore;
  private writerAdmission?: SessionLifecycleWriterAdmission;
  private writerIdentity?: AnalyticsWriterIdentity;
  private writerStateDir?: string;

  constructor(
    private readonly ports: BackendAnalyticsActivationPorts,
    private readonly options: BackendAnalyticsActivationOptions,
  ) {}

  get descriptor(): AnalyticsBackendDescriptor | undefined {
    return this.options.descriptor;
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

  /** Validate the host-supplied descriptor against the exact active manifest
   * bytes before installing the router. A candidate/ready generation, a stale
   * revision, or any build/generation mismatch therefore cannot reach a
   * worker. Legacy direct callers remain valid while no canonical authority
   * is active. */
  validate(): void {
    const dataPaths = resolvePieDataPaths({
      dataDir: process.env.PIE_DATA_DIR,
      agentDir: this.ports.agentDir(),
    });
    const read = new ActivationStore({ stateDir: dataPaths.stateDir }).read();
    const active = read.manifest?.activeGeneration;
    const descriptor = this.options.descriptor;
    if (!descriptor) {
      if (read.authority === 'canonical') {
        throw new Error('Canonical analytics authority is active but the backend descriptor is missing.');
      }
      return;
    }
    if (read.authority !== 'canonical' || !active) {
      throw new Error('Analytics backend descriptor names an authority with no active generation.');
    }
    if (active.identity.generationId !== descriptor.generationId) {
      throw new Error('Analytics backend generation does not match the active manifest.');
    }
    if (active.identity.buildId !== descriptor.buildId) {
      throw new Error('Analytics backend build does not match the active manifest.');
    }
    if (read.manifest?.revision !== descriptor.manifestRevision) {
      throw new Error('Analytics backend manifest revision is stale.');
    }
    if (read.sha256 !== descriptor.manifestSha256) {
      throw new Error('Analytics backend manifest hash is stale.');
    }
    for (const [name, value] of Object.entries(descriptor)) {
      if (name === 'manifestRevision') continue;
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Analytics backend descriptor ${name} is invalid.`);
      }
    }
    if (!Number.isSafeInteger(descriptor.manifestRevision) || descriptor.manifestRevision <= 0) {
      throw new Error('Analytics backend descriptor manifest revision is invalid.');
    }
  }

  /** Open the durable writer admission after validation. Requires a positive
   * host process identity; the authority generation is the host instance (the
   * lifecycle registry identifies the extension-host boot; the analytics
   * generation is a separate authority identity). */
  openWriterAdmission(): void {
    const descriptor = this.options.descriptor;
    if (!descriptor) return;
    const hostPid = this.ports.hostPid();
    if (typeof hostPid !== 'number' || !Number.isSafeInteger(hostPid) || hostPid <= 0) {
      throw new Error('Canonical analytics activation requires a positive host process identity.');
    }
    const dataPaths = resolvePieDataPaths({
      dataDir: process.env.PIE_DATA_DIR,
      agentDir: this.ports.agentDir(),
    });
    this.writerStateDir = dataPaths.stateDir;
    const store = new SessionLifecycleStore(
      path.join(dataPaths.stateDir, 'session-lifecycle.sqlite'),
    );
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