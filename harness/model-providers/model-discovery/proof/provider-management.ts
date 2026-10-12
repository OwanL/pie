/**
 * PROOF ONLY — offline provider-management compatibility proof.
 *
 * This module is intentionally NOT wired into production: only its proof tests import it,
 * and it must not be treated as a production API. It exists to validate, in a
 * bounded offline setting, the management semantics Pie wants to pull from
 * upstream Pi 1.1.0 before any production integration work.
 *
 * Source attribution
 * ------------------
 * The auth-resolution rules, refresh generation/supersession fencing, immutable
 * last-known-good publication, and shared request preparation are adapted
 * (management-only, rewritten against the current local pi-ai interfaces) from
 * upstream:
 *
 *   earendil-works/pi @ abe508e1b89912adde45528136c3221eb69acdd7 (Pi 1.1.0)
 *   - packages/ai/src/auth/resolve.ts
 *   - packages/ai/src/models.ts
 *
 * The upstream project is MIT licensed:
 *
 *   MIT License
 *   Copyright (c) 2025 Mario Zechner
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 *
 * Adapted portions retain the upstream MIT notice above.
 *
 * Deliberate proof-scope exclusions: no OAuth flows, no network or provider
 * calls (transports and catalog fetchers are injected fakes), no persistent
 * store, no filesystem/ambient user-data reads, no timers, no UI, no
 * multi-account support, no classifier/image/telemetry paths, and no claims
 * about production readiness.
 *
 * Only `import type` is used against the existing pi-ai package interfaces,
 * so this module has no runtime SDK imports. Its artifact-backed tests reuse
 * a verified current SDK, not newer upstream package bytes.
 */
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderEnv,
  ProviderHeaders,
  SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { CompactionRequestAuth } from '@earendil-works/pi-coding-agent';

// ---------------------------------------------------------------------------
// Credentials — one type-tagged credential per provider (in-memory)
// ---------------------------------------------------------------------------

/**
 * Stored api-key credential (upstream `ApiKeyCredential` subset; OAuth flows
 * are out of scope for the proof). `env` holds provider-scoped values such as
 * account/gateway ids.
 */
export interface ManagedApiKeyCredential {
  type: 'api_key';
  key?: string;
  env?: ProviderEnv;
}

/**
 * One type-tagged credential per provider. `{ type: "oauth" }` exists as an
 * unsupported marker only: the proof implements no OAuth handler, so a stored
 * oauth credential exercises the "stored credential without a matching
 * handler" rule (resolves to nothing, never falls back to ambient sources).
 */
export interface ManagedUnsupportedOAuthCredential {
  type: 'oauth';
}

export type ManagedCredential = ManagedApiKeyCredential | ManagedUnsupportedOAuthCredential;

/** App-owned in-memory credential storage, keyed by provider id. */
export interface ManagedCredentialStore {
  read(providerId: string): ManagedCredential | undefined;
  /** Replace or clear (undefined) the single credential of a provider. */
  write(providerId: string, credential: ManagedCredential | undefined): void;
}

/** In-memory credential store: exactly one credential per provider id. */
export class InMemoryCredentialStore implements ManagedCredentialStore {
  private entries = new Map<string, ManagedCredential>();

  read(providerId: string): ManagedCredential | undefined {
    const credential = this.entries.get(providerId);
    return credential === undefined ? undefined : structuredClone(credential);
  }

  write(providerId: string, credential: ManagedCredential | undefined): void {
    if (credential === undefined) this.entries.delete(providerId);
    else this.entries.set(providerId, structuredClone(credential));
  }
}

// ---------------------------------------------------------------------------
// Auth resolution — adapted from upstream packages/ai/src/auth/resolve.ts
// ---------------------------------------------------------------------------

/**
 * Api-key auth method of a proof provider. Ambient sources are fully
 * injectable: the proof itself never reads `process.env`, files, or user data.
 */
export interface ManagedApiKeyAuth {
  /**
   * Ambient environment variable names consulted ONLY when nothing is stored.
   * First matching non-empty name wins.
   */
  apiKeyEnvNames?: readonly string[];
  /** Injectable ambient lookup; default is "nothing configured". */
  ambientEnv?(name: string): string | undefined;
  /**
   * Effective endpoint of the resolved connection (account/endpoint-specific).
   * When set, request preparation clones the model with this `baseUrl`.
   */
  baseUrl?: string;
}

export interface ManagedProviderAuth {
  apiKey?: ManagedApiKeyAuth;
}

/**
 * Request auth overrides for one resolution. An explicit key selects a
 * request-scoped credential, including only its request env. Without a key
 * override, request env overlays the selected stored credential per field.
 */
export interface AuthResolutionOverrides {
  apiKey?: string;
  env?: ProviderEnv;
}

/** Result of resolving auth for a provider. `apiKey` is set by contract. */
export interface ResolvedProviderAuth {
  apiKey: string;
  /** Provider-scoped env resolved from the credential and request overrides. */
  env?: ProviderEnv;
  /** Provenance: where the effective auth came from. */
  source: 'stored' | 'ambient' | 'request';
  /** Effective endpoint override; undefined keeps the caller's model baseUrl. */
  baseUrl?: string;
}

/**
 * Auth resolution rules (adapted from upstream `resolveProviderAuth`):
 * - An explicit request key selects a request-scoped credential; it does not
 *   inherit another credential's stored account/environment fields.
 * - A stored credential owns the provider: ambient sources are consulted only
 *   when NOTHING is stored.
 * - No silent ambient fallback for a stored credential without a matching
 *   handler (e.g. the unsupported `oauth` marker) or a stored-but-failed
 *   api-key credential (missing/empty key). Both resolve to nothing.
 * - If resolution yields nothing, the caller must reject explicitly; this
 *   module raises `ManagedProviderAuthError` in request preparation.
 *
 * Documented precedence per field:
 * - apiKey:  request override > stored credential key > ambient env names
 *            (the request `env` overlay is checked before the injected
 *            ambient lookup).
 * - env:     selected stored credential env < request `env` per name; explicit
 *            request-key credentials contain request env only (upstream rule).
 * - baseUrl: the provider auth method's endpoint override (constant for the
 *            connection); absent keeps the caller's model baseUrl.
 */
export function resolveManagedAuth(
  providerId: string,
  auth: ManagedProviderAuth,
  deps: { credentials: ManagedCredentialStore },
  overrides?: AuthResolutionOverrides,
): ResolvedProviderAuth | undefined {
  const method = auth.apiKey;

  // An explicit empty override is failed auth, not permission to fall back.
  if (overrides?.apiKey === '') return undefined;
  if (method && overrides?.apiKey !== undefined) {
    return {
      apiKey: overrides.apiKey,
      env: overrides.env ? { ...overrides.env } : undefined,
      source: 'request',
      baseUrl: method.baseUrl,
    };
  }

  const stored = deps.credentials.read(providerId);
  if (stored !== undefined) {
    // A stored non-api-key credential has no handler in the proof, and a
    // stored api-key credential without a usable key has failed resolution:
    // both are explicit missing auth with NO ambient fallback (upstream rule).
    if (stored.type !== 'api_key' || !method || !stored.key) return undefined;
    return {
      apiKey: stored.key,
      env: stored.env || overrides?.env ? { ...(stored.env ?? {}), ...(overrides?.env ?? {}) } : undefined,
      source: 'stored',
      baseUrl: method.baseUrl,
    };
  }

  if (!method) return undefined;
  const apiKey = resolveAmbientApiKey(method, overrides?.env);
  if (apiKey === undefined) return undefined;
  return {
    apiKey,
    env: overrides?.env ? { ...overrides.env } : undefined,
    source: 'ambient',
    baseUrl: method.baseUrl,
  };
}

function resolveAmbientApiKey(method: ManagedApiKeyAuth, envOverlay: ProviderEnv | undefined): string | undefined {
  for (const name of method.apiKeyEnvNames ?? []) {
    // The request env overlay participates in ambient discovery first, then
    // the injected ambient lookup (upstream overlay-AuthContext behavior).
    const value = envOverlay?.[name] ?? method.ambientEnv?.(name);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** Missing auth is rejected explicitly before any dispatch — never silently skipped. */
export class ManagedProviderAuthError extends Error {
  readonly providerId: string;

  constructor(providerId: string, reason: string) {
    super(`Provider is not configured: ${providerId} (${reason})`);
    this.name = 'ManagedProviderAuthError';
    this.providerId = providerId;
  }
}

function describeMissingAuth(providerId: string, auth: ManagedProviderAuth, deps: { credentials: ManagedCredentialStore }): string {
  const stored = deps.credentials.read(providerId);
  if (stored === undefined) return 'no credential stored and no ambient source resolved';
  if (stored.type !== 'api_key') return `stored credential of type "${stored.type}" has no matching handler`;
  return 'stored credential has no usable key and ambient fallback is forbidden';
}

// ---------------------------------------------------------------------------
// Request preparation — adapted from upstream packages/ai/src/models.ts `applyAuth`
// ---------------------------------------------------------------------------

/**
 * Merges provider header maps with case-insensitive override semantics
 * (upstream `mergeHeaders`). A `null` value suppresses/overrides a default.
 */
function mergeHeaders(base: ProviderHeaders | undefined, override: ProviderHeaders | undefined): ProviderHeaders | undefined {
  if (!base && !override) return undefined;
  const merged = { ...base };
  for (const [name, value] of Object.entries(override ?? {})) {
    const lowerName = name.toLowerCase();
    for (const existingName of Object.keys(merged)) {
      if (existingName.toLowerCase() === lowerName) delete merged[existingName];
    }
    merged[name] = value;
  }
  return merged;
}

/**
 * Header precedence (documented; matching current pi-ai interfaces):
 * `model.headers` < provider headers < request `options.headers`, merged
 * per-field with case-insensitive name identity. Environment precedence:
 * selected credential env < request `options.env` per name. An explicit key
 * selects a request-scoped credential without stored environment fields.
 */
export interface PreparedManagedRequest {
  /**
   * Effective request model. Cloned (spread) only when auth supplies a
   * `baseUrl` override; otherwise the caller's model record is reused without
   * mutation.
   */
  requestModel: Model<Api>;
  /** Merged auth plus every caller option preserved as-is. */
  requestOptions: SimpleStreamOptions;
  /** Provenance of the resolved auth used to build the request. */
  resolvedAuth: ResolvedProviderAuth;
}

/**
 * Shared request preparation for ordinary chats and summary/compaction
 * dispatch. Resolves auth first and rejects absent auth explicitly
 * (`ManagedProviderAuthError`) BEFORE any transport dispatch.
 *
 * Caller options other than `apiKey`/`headers`/`env` (onPayload, onResponse,
 * timeoutMs, maxRetries, metadata, signal, transport, cacheRetention,
 * sessionId, reasoning, ...) are preserved untouched on the prepared options.
 */
export function prepareManagedRequest(
  provider: { id: string; headers?: ProviderHeaders; auth: ManagedProviderAuth },
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  deps: { credentials: ManagedCredentialStore },
): PreparedManagedRequest {
  const resolved = resolveManagedAuth(provider.id, provider.auth, deps, {
    apiKey: options?.apiKey,
    env: options?.env,
  });
  if (!resolved) {
    throw new ManagedProviderAuthError(provider.id, describeMissingAuth(provider.id, provider.auth, deps));
  }

  const headers = mergeHeaders(mergeHeaders(model.headers, provider.headers), options?.headers);
  const env = resolved.env || options?.env ? { ...(resolved.env ?? {}), ...(options?.env ?? {}) } : undefined;
  const requestModel: Model<Api> = resolved.baseUrl ? { ...model, baseUrl: resolved.baseUrl } : model;
  const requestOptions: SimpleStreamOptions = {
    ...options,
    apiKey: resolved.apiKey,
    headers,
    env,
  };

  return { requestModel, requestOptions, resolvedAuth: resolved };
}

// ---------------------------------------------------------------------------
// Summary (compaction-auth) preparation — old shape
// ---------------------------------------------------------------------------

/** Exact current compaction-auth contract, checked against verified SDK declarations. */
export type ManagedCompactionRequestAuth = CompactionRequestAuth;

export interface PreparedManagedSummaryRequest {
  /** Old compaction-auth shape with all three fields set from shared preparation. */
  auth: ManagedCompactionRequestAuth;
  /** Effective request model (cloned for auth.baseUrl overrides). */
  model: Model<Api>;
}

/**
 * Summary/compaction preparation in the exact old compaction-auth shape plus
 * the effective request model. Shares `prepareManagedRequest` with ordinary
 * dispatch, with parity for supported string headers. Limitation: the old
 * CompactionRequestAuth boundary cannot represent null header suppression;
 * summary preparation rejects it explicitly while ordinary dispatch supports it.
 */
export function prepareManagedSummaryRequest(
  provider: { id: string; headers?: ProviderHeaders; auth: ManagedProviderAuth },
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  deps: { credentials: ManagedCredentialStore },
): PreparedManagedSummaryRequest {
  const prepared = prepareManagedRequest(provider, model, options, deps);
  let headers: Record<string, string> | undefined;
  if (prepared.requestOptions.headers !== undefined) {
    headers = {};
    for (const [name, value] of Object.entries(prepared.requestOptions.headers)) {
      if (typeof value !== 'string') {
        throw new Error(`Summary auth cannot represent header suppression: ${name}`);
      }
      headers[name] = value;
    }
  }
  return {
    auth: {
      apiKey: prepared.requestOptions.apiKey,
      headers,
      env: prepared.requestOptions.env,
    },
    model: prepared.requestModel,
  };
}

/**
 * Races an operation against an abort signal (upstream
 * `raceWithAbortSignal`). Rejects with `signal.reason` when the signal aborts;
 * the losing promise's eventual rejection is swallowed.
 */
function raceWithAbortSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      // The abandoned promise must never surface an unhandled rejection.
      void promise.catch(() => {});
    };
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Providers, transports and refresh — adapted from upstream packages/ai/src/models.ts
// ---------------------------------------------------------------------------

/** Injected fake transport; proofs never reach a real provider network. */
export interface SimpleTransport {
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
}

export interface ManagedCatalogRefreshContext {
  /** Auth resolved for the provider at refresh start (credential + overrides). */
  auth: ResolvedProviderAuth;
  /** Aborted when a newer refresh supersedes this one (or the caller aborts). */
  signal: AbortSignal;
}

/**
 * A proof provider with an injected transport and an optional fake catalog
 * fetcher. `refreshCatalog` returns the complete new chat-model list or
 * throws; it must not touch the network or store state itself.
 */
export interface ManagedCatalogProvider {
  readonly id: string;
  readonly name: string;
  readonly headers?: ProviderHeaders;
  readonly auth: ManagedProviderAuth;
  readonly transport: SimpleTransport;
  refreshCatalog?(context: ManagedCatalogRefreshContext): Promise<readonly Model<Api>[]>;
}

export interface ManagedCatalogSnapshot {
  readonly providerId: string;
  /** Frozen copy of the published chat-model list. */
  readonly models: readonly Model<Api>[];
  /** Refresh generation that published this snapshot. */
  readonly generation: number;
}

export interface ManagedRefreshOutcome {
  generation: number;
  status:
    | 'published'
    | 'superseded'
    | 'skipped-unconfigured'
    | 'failed'
    | 'aborted';
}

export interface ManagedRefreshResult {
  aborted: boolean;
  outcomes: ReadonlyMap<string, ManagedRefreshOutcome>;
  errors: ReadonlyMap<string, Error>;
}

export interface ManagedRefreshOptions {
  /** Restrict refresh to these provider ids; unknown providers are ignored. */
  providers?: readonly string[];
  signal?: AbortSignal;
}

export interface ManagedProviderManagerOptions {
  providers: readonly ManagedCatalogProvider[];
  // Default: fresh in-memory store. Ambient sources are injectable per
  // provider auth, so the manager itself needs no process/user context.
  credentials?: ManagedCredentialStore;
}

function freezeCatalogRecords<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) freezeCatalogRecords(entry);
    Object.freeze(value);
  }
  return value;
}

/**
 * Management-only provider collection: credential changes, per-provider
 * catalog refresh with generation/cancellation fencing, immutable
 * last-known-good snapshots, and bridge dispatch for prepared requests.
 *
 * Refresh semantics (adapted from upstream `ModelsImpl.refresh`):
 * - Starting a refresh supersedes any in-flight refresh of the provider:
 *   the generation counter bumps and the previous controller aborts.
 * - Credential changes (setCredential/logout) supersede in-flight refreshes
 *   the same way, so a stale refresh can never overwrite newer state.
 * - The fetch result is awaited BEFORE publication; publication only happens
 *   when the generation still matches and no abort occurred.
 * - Snapshots are published as new frozen objects (last-known-good stays
 *   intact while a refresh is pending or failed).
 */
export class ManagedProviderManager {
  private readonly providers = new Map<string, ManagedCatalogProvider>();
  private readonly credentials: ManagedCredentialStore;
  private readonly snapshots = new Map<string, ManagedCatalogSnapshot>();
  private readonly generations = new Map<string, number>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(options: ManagedProviderManagerOptions) {
    for (const provider of options.providers) {
      this.providers.set(provider.id, provider);
    }
    this.credentials = options.credentials ?? new InMemoryCredentialStore();
  }

  getProvider(id: string): ManagedCatalogProvider | undefined {
    return this.providers.get(id);
  }

  /** Last-known-good published snapshot, or undefined before the first publication. */
  getSnapshot(providerId: string): ManagedCatalogSnapshot | undefined {
    return this.snapshots.get(providerId);
  }

  /**
   * Replace (or clear, with undefined) the provider's single credential.
   * Supersedes any in-flight refresh of the provider so a stale refresh
   * cannot overwrite the newer credential state.
   */
  setCredential(providerId: string, credential: ManagedCredential | undefined): void {
    this.supersedeProviderRefresh(providerId);
    this.credentials.write(providerId, credential);
  }

  /**
   * Refresh selected providers concurrently (all refreshable ones when
   * omitted). Missing auth skips publication without failing the refresh;
   * fetch failures are captured per provider without touching the snapshot.
   */
  async refresh(options: ManagedRefreshOptions = {}): Promise<ManagedRefreshResult> {
    const callerSignal = options.signal;
    if (callerSignal?.aborted) return { aborted: true, outcomes: new Map(), errors: new Map() };
    const selected = options.providers ? new Set(options.providers) : undefined;
    const refreshable = [...this.providers.values()].filter(
      (provider) => provider.refreshCatalog !== undefined && (!selected || selected.has(provider.id)),
    );

    const outcomes = new Map<string, ManagedRefreshOutcome>();
    const errors = new Map<string, Error>();

    await Promise.all(
      refreshable.map(async (provider) => {
        const { generation, controller } = this.beginProviderRefresh(provider.id);
        const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
        try {
          const resolved = resolveManagedAuth(provider.id, provider.auth, { credentials: this.credentials });
          if (!resolved) {
            outcomes.set(provider.id, { generation, status: 'skipped-unconfigured' });
            return;
          }

          // Refresh must be awaited before publication; the fetcher is fake and
          // must not publish or persist anything itself. Caller/mid-flight
          // aborts race the fetch so a cancelled refresh returns promptly.
          const fetched = await raceWithAbortSignal(provider.refreshCatalog!({ auth: resolved, signal }), signal);

          if (signal.aborted || this.generations.get(provider.id) !== generation) {
            outcomes.set(provider.id, { generation, status: 'superseded' });
            return;
          }
          this.publishProviderSnapshot(provider.id, generation, fetched);
          outcomes.set(provider.id, { generation, status: 'published' });
        } catch (error) {
          const superseded = signal.aborted || this.generations.get(provider.id) !== generation;
          if (!superseded) errors.set(provider.id, error instanceof Error ? error : new Error(String(error)));
          outcomes.set(provider.id, {
            generation,
            status: superseded ? 'superseded' : 'failed',
          });
        } finally {
          if (this.controllers.get(provider.id) === controller) this.controllers.delete(provider.id);
        }
      }),
    );

    return { aborted: callerSignal?.aborted === true, outcomes, errors };
  }

  /**
   * Ordinary dispatch: resolves auth (rejecting missing auth before any
   * transport involvement) and hands the prepared model/context/options to
   * the provider's injected transport.
   */
  dispatchSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const provider = this.requireProvider(model);
    const prepared = prepareManagedRequest(provider, model, options, { credentials: this.credentials });
    return provider.transport.streamSimple(prepared.requestModel, context, prepared.requestOptions);
  }

  /** Summary preparation in the exact old compaction-auth shape plus request model. */
  prepareSummaryRequest(model: Model<Api>, options?: SimpleStreamOptions): PreparedManagedSummaryRequest {
    const provider = this.requireProvider(model);
    return prepareManagedSummaryRequest(provider, model, options, { credentials: this.credentials });
  }

  private requireProvider(model: Model<Api>): ManagedCatalogProvider {
    const provider = this.providers.get(model.provider);
    if (!provider) {
      throw new Error(`Unknown provider: ${model.provider}`);
    }
    return provider;
  }

  // Upstream `supersedeProviderRefresh`/`beginProviderRefresh` adaptation.
  private supersedeProviderRefresh(providerId: string): number {
    const generation = (this.generations.get(providerId) ?? 0) + 1;
    this.generations.set(providerId, generation);
    const previous = this.controllers.get(providerId);
    if (previous) {
      this.controllers.delete(providerId);
      previous.abort();
    }
    return generation;
  }

  private beginProviderRefresh(providerId: string): { generation: number; controller: AbortController } {
    const generation = this.supersedeProviderRefresh(providerId);
    const controller = new AbortController();
    this.controllers.set(providerId, controller);
    return { generation, controller };
  }

  // Upstream `publishProviderModels` adaptation, without a persistent store:
  // publication replaces the snapshot with a new frozen object.
  private publishProviderSnapshot(providerId: string, generation: number, fetched: readonly Model<Api>[]): void {
    this.snapshots.set(
      providerId,
      Object.freeze({
        providerId,
        models: freezeCatalogRecords(structuredClone(fetched)),
        generation,
      }),
    );
  }
}