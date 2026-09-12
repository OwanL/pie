import { createServer, type Server, type Socket } from 'node:net';

import {
  ANALYTICS_HANDOFF_MAX_FRAME_BYTES,
  ANALYTICS_HANDOFF_MAX_STATUS_BYTES,
  ANALYTICS_HANDOFF_MAX_STATUS_HOSTS,
  ANALYTICS_HANDOFF_MAX_NONCE_COUNT,
  ANALYTICS_HANDOFF_NONCE_WINDOW_MS,
  assertFreshAnalyticsHandoffRequest,
  createAnalyticsHandoffPipeName,
  createSignedAnalyticsHandoffResponse,
  verifyAnalyticsHandoffRequest,
  type AnalyticsHandoffControlRequest,
  type AnalyticsHandoffControlResponse,
  type AnalyticsHandoffHostIdentity,
  type AnalyticsHandoffInventoryProof,
  type AnalyticsHandoffStatus,
} from '../../../shared/analytics/handoff.js';
import {
  SessionLifecycleStore,
  type AnalyticsHostRecord,
} from '../backend/session-lifecycle-store.js';

export interface AnalyticsHandoffControlOptions {
  registry: SessionLifecycleStore;
  identity: AnalyticsHandoffHostIdentity;
  key?: string;
  pipeName?: string;
  now?: () => number;
  /** Read-only reconciliation used to annotate status. It can never make
   * `allHostsHandoffAvailable` true; an external producer still owns that
   * decision and capability. */
  readInventory?: () => Promise<AnalyticsHandoffInventoryProof>;
  /** Test/diagnostic bound; production remains below the socket idle bound. */
  inventoryReadTimeoutMs?: number;
  onError?: (error: Error, stage: string) => void;
}

const MAX_SOCKET_IDLE_MS = 10_000;
const MAX_SOCKET_LIFETIME_MS = ANALYTICS_HANDOFF_NONCE_WINDOW_MS;
const MAX_SERVER_DRAIN_MS = 2_000;
const MAX_OWNED_CONNECTIONS = 32;
const INVENTORY_CACHE_MS = 1_000;
const MAX_INVENTORY_READ_MS = MAX_SOCKET_IDLE_MS - 1_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function safeRequestId(value: unknown): string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('\u0000')
    ? value : 'invalid';
}

function safeError(value: unknown): string {
  return errorMessage(value).replaceAll('\u0000', '').slice(0, 1_024) || 'handoff request failed';
}

function toStatusHost(record: AnalyticsHostRecord): AnalyticsHandoffStatus['host'] {
  return {
    hostInstanceId: record.hostInstanceId,
    workspaceId: record.workspaceId,
    generationId: record.generationId,
    buildId: record.buildId,
    processId: record.processId,
    ...(record.endpointName ? { endpointName: record.endpointName } : {}),
    capabilities: [...record.capabilities],
    state: record.state,
    registeredAtMs: record.registeredAtMs,
    heartbeatAtMs: record.heartbeatAtMs,
    ...(record.stoppedAtMs ? { stoppedAtMs: record.stoppedAtMs } : {}),
    ...(record.unsupportedReason ? { unsupportedReason: record.unsupportedReason } : {}),
    updatedAtMs: record.updatedAtMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Host-local authenticated status/control endpoint. It is intentionally a
 * finite endpoint owned by the extension host; it does not supervise hosts,
 * infer the complete writer set, or claim an all-host handoff. */
export class AnalyticsHandoffControl {
  private readonly now: () => number;
  private readonly pipeName: string;
  private readonly key: string | undefined;
  private readonly seenNonces = new Map<string, number>();
  private readonly ownedSockets = new Set<Socket>();
  private server: Server | undefined;
  private started = false;
  private available = false;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;
  private inventoryReadInFlight: Promise<AnalyticsHandoffInventoryProof> | undefined;
  private inventoryCache: { expiresAtMs: number; proof: AnalyticsHandoffInventoryProof } | undefined;
  private readonly inventoryReadTimeoutMs: number;

  constructor(private readonly options: AnalyticsHandoffControlOptions) {
    this.now = options.now ?? Date.now;
    this.key = options.key?.trim() || undefined;
    this.pipeName = options.pipeName
      ?? createAnalyticsHandoffPipeName(options.identity.workspaceId, options.identity.hostInstanceId);
    this.inventoryReadTimeoutMs = Math.min(
      MAX_INVENTORY_READ_MS,
      options.inventoryReadTimeoutMs === undefined
        ? MAX_INVENTORY_READ_MS
        : Math.max(1, Math.floor(options.inventoryReadTimeoutMs)),
    );
  }

  get endpointName(): string | undefined { return this.available ? this.pipeName : undefined; }
  get isAvailable(): boolean { return this.available; }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.key) {
      this.registerUnsupported('authenticated handoff key is unavailable');
      return;
    }
    try {
      await this.listen();
      if (this.stopping) return;
      this.options.registry.registerAnalyticsHost({
        ...this.options.identity,
        capabilities: [...this.options.identity.capabilities, 'authenticated-control'],
        endpointName: this.pipeName,
        state: 'registered',
        registeredAtMs: this.now().toString(),
      });
      this.available = true;
    } catch (error) {
      this.available = false;
      this.options.onError?.(normalizeError(error), 'start');
      const failedServer = this.server;
      this.server = undefined;
      for (const socket of this.ownedSockets) socket.destroy();
      if (failedServer) await this.closeServerBounded(failedServer);
      if (!this.stopping) this.registerUnsupported('authenticated handoff endpoint could not start');
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<void> {
    this.stopping = true;
    this.available = false;
    this.inventoryCache = undefined;
    try {
      const current = this.options.registry.getAnalyticsHost(this.options.identity.hostInstanceId);
      if (current && current.state !== 'stopped') {
        this.options.registry.markAnalyticsHostState(
          this.options.identity.hostInstanceId,
          this.options.identity.processId,
          this.options.identity.generationId,
          'stopping',
          this.now(),
        );
      }
    } catch (error) {
      this.options.onError?.(normalizeError(error), 'stop.mark-stopping');
    }
    const server = this.server;
    this.server = undefined;
    for (const socket of this.ownedSockets) socket.destroy();
    if (server) await this.closeServerBounded(server);
    // Endpoint closure is not proof that recorder/backend writers drained.
    // Leave the durable identity in `stopping` until a later lifecycle owner
    // records writer quiescence; status remains incomplete in either state.
  }

  private closeServerBounded(server: Server): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        for (const socket of this.ownedSockets) socket.destroy();
        finish();
      }, MAX_SERVER_DRAIN_MS);
      timer.unref?.();
      try {
        server.close(() => finish());
      } catch (error) {
        this.options.onError?.(normalizeError(error), 'stop.server-close');
        finish();
      }
    });
  }

  dispose(): void { void this.stop(); }

  private registerUnsupported(reason: string): void {
    try {
      this.options.registry.registerAnalyticsHost({
        ...this.options.identity,
        capabilities: [...this.options.identity.capabilities],
        state: 'unsupported',
        registeredAtMs: this.now().toString(),
        unsupportedReason: reason,
      });
    } catch (error) {
      this.options.onError?.(normalizeError(error), 'register-unsupported');
    }
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      // A caller may finish its request stream before asynchronous inventory
      // work finishes. Keep the reply side open until handleFrame ends it;
      // the existing idle/lifetime bounds still retire abandoned sockets.
      const server = createServer({ allowHalfOpen: true }, (socket) => {
        if (this.ownedSockets.size >= MAX_OWNED_CONNECTIONS) {
          socket.destroy();
          return;
        }
        this.ownedSockets.add(socket);
        socket.once('close', () => this.ownedSockets.delete(socket));
        this.handleSocket(socket);
      });
      this.server = server;
      let listening = false;
      const onError = (error: Error) => {
        if (!listening) {
          server.off('listening', onListening);
          reject(error);
          return;
        }
        // Keep a permanent listener after startup so a late pipe error cannot
        // become an uncaught host exception.
        this.options.onError?.(normalizeError(error), 'server');
      };
      const onListening = () => {
        listening = true;
        resolve();
      };
      server.on('error', onError);
      server.once('listening', onListening);
      server.listen(this.pipeName);
    });
  }

  private handleSocket(socket: Socket): void {
    let buffer = '';
    let frameAccepted = false;
    socket.setEncoding('utf8');
    socket.setTimeout(MAX_SOCKET_IDLE_MS, () => socket.destroy());
    const lifetimeTimer = setTimeout(() => socket.destroy(), MAX_SOCKET_LIFETIME_MS);
    lifetimeTimer.unref?.();
    socket.once('close', () => clearTimeout(lifetimeTimer));
    socket.once('end', () => { if (!frameAccepted) socket.destroy(); });
    socket.on('data', (chunk: string) => {
      // A control connection carries exactly one request. Serializing a
      // second frame would race the first response's socket.end() and make
      // the endpoint's request/replay accounting ambiguous.
      if (frameAccepted) {
        socket.destroy();
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > ANALYTICS_HANDOFF_MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (buffer.length > 0) {
        socket.destroy();
        return;
      }
      frameAccepted = true;
      void this.handleFrame(line, socket);
    });
    socket.on('error', () => undefined);
  }

  private async handleFrame(frame: string, socket: Socket): Promise<void> {
    let requestId = 'invalid';
    let response: AnalyticsHandoffControlResponse;
    try {
      const raw = JSON.parse(frame) as unknown;
      if (isRecord(raw)) requestId = safeRequestId(raw.requestId);
      if (!this.key) throw new Error('handoff endpoint is unavailable');
      const request = verifyAnalyticsHandoffRequest(raw, this.key);
      const now = this.now();
      assertFreshAnalyticsHandoffRequest(request, now);
      for (const [nonce, expiresAtMs] of this.seenNonces) {
        if (expiresAtMs < now) this.seenNonces.delete(nonce);
      }
      if (this.seenNonces.has(request.nonce)) throw new Error('handoff request nonce was replayed.');
      if (this.seenNonces.size >= ANALYTICS_HANDOFF_MAX_NONCE_COUNT) {
        throw new Error('handoff nonce capacity is exhausted; retry after expiry.');
      }
      this.seenNonces.set(request.nonce, request.expiresAtMs);
      const result = await this.handleRequest(request);
      response = createSignedAnalyticsHandoffResponse(request.requestId, this.key, { ok: true, result });
    } catch (error) {
      try {
        response = createSignedAnalyticsHandoffResponse(safeRequestId(requestId), this.key ?? 'unavailable', {
          ok: false,
          error: safeError(error),
        });
      } catch (responseError) {
        this.options.onError?.(normalizeError(responseError), 'response');
        return;
      }
    }
    try {
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    } catch (error) {
      this.options.onError?.(normalizeError(error), 'response-send');
    }
  }

  private async readInventoryProof(): Promise<AnalyticsHandoffInventoryProof> {
    const fallback = (reasonCodes: readonly string[] = []): AnalyticsHandoffInventoryProof => ({
      kind: 'registered-hosts-only',
      complete: false,
      reason: 'runtime-generation-and-process-reconciliation-unwired',
      ...(reasonCodes.length > 0 ? { reasonCodes } : {}),
    });
    const reader = this.options.readInventory;
    if (!reader) return fallback();
    const now = this.now();
    if (this.inventoryCache && this.inventoryCache.expiresAtMs > now) return this.inventoryCache.proof;
    let read = this.inventoryReadInFlight;
    if (!read) {
      let underlying: Promise<AnalyticsHandoffInventoryProof>;
      try {
        underlying = Promise.resolve(reader());
      } catch (error) {
        this.options.onError?.(normalizeError(error), 'status.inventory');
        return fallback(['inventory-discovery-error']);
      }
      const tracked: Promise<AnalyticsHandoffInventoryProof> = underlying.then((proof) => {
        if (this.inventoryReadInFlight === tracked) {
          if (!this.stopping) {
            this.inventoryCache = { expiresAtMs: this.now() + INVENTORY_CACHE_MS, proof };
          }
          this.inventoryReadInFlight = undefined;
        }
        return proof;
      }, (error) => {
        if (this.inventoryReadInFlight === tracked) this.inventoryReadInFlight = undefined;
        this.options.onError?.(normalizeError(error), 'status.inventory');
        return fallback(['inventory-discovery-error']);
      });
      this.inventoryReadInFlight = tracked;
      read = tracked;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    return await Promise.race([
      read,
      new Promise<AnalyticsHandoffInventoryProof>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('inventory discovery timed out.')), this.inventoryReadTimeoutMs);
        timeout.unref?.();
      }),
    ]).catch((error): AnalyticsHandoffInventoryProof => {
      this.options.onError?.(normalizeError(error), 'status.inventory');
      return fallback(['inventory-discovery-timeout']);
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private async handleRequest(request: AnalyticsHandoffControlRequest): Promise<AnalyticsHandoffStatus | { host: AnalyticsHandoffStatus['host'] }> {
    if (request.operation === 'heartbeat') {
      const host = this.options.registry.heartbeatAnalyticsHost(
        this.options.identity.hostInstanceId,
        this.options.identity.processId,
        this.options.identity.generationId,
        this.now(),
      );
      return { host: toStatusHost(host) };
    }
    const workspaceId = request.payload.workspaceId;
    if (workspaceId !== this.options.identity.workspaceId) throw new Error('handoff workspace identity does not match.');
    const limit = typeof request.payload.limit === 'number' ? request.payload.limit : ANALYTICS_HANDOFF_MAX_STATUS_HOSTS;
    const cursor = typeof request.payload.cursor === 'string' ? request.payload.cursor : undefined;
    const page = this.options.registry.listAnalyticsHosts(this.options.identity.workspaceId, { limit, cursor });
    let hosts = page.hosts.map(toStatusHost);
    let truncated = page.truncated;
    let nextCursor = page.nextCursor;
    const currentRecord = this.options.registry.getAnalyticsHost(this.options.identity.hostInstanceId);
    if (!currentRecord || currentRecord.workspaceId !== this.options.identity.workspaceId) {
      throw new Error('registered host identity is missing.');
    }
    const host = toStatusHost(currentRecord);
    const inventoryProof = await this.readInventoryProof();
    // Keep the complete signed response comfortably below the frame limit.
    while (hosts.length > 0 && Buffer.byteLength(JSON.stringify({
      host,
      hosts,
      inventoryProof,
      allHostsHandoffAvailable: false,
    }), 'utf8') > ANALYTICS_HANDOFF_MAX_STATUS_BYTES) {
      hosts = hosts.slice(0, -1);
      truncated = true;
      nextCursor = hosts[hosts.length - 1]?.hostInstanceId;
    }
    return {
      host,
      hosts,
      truncated,
      ...(truncated && nextCursor ? { nextCursor } : {}),
      inventoryProof,
      allHostsHandoffAvailable: false,
    };
  }
}
