import * as cp from 'node:child_process';
import * as vscode from 'vscode';

import { attachJsonlLineReader, JSONL_MAX_LINE_BYTES, serializeJsonLine } from '../../shared/jsonl';
import { resolveHostSessionStoragePaths } from '../../shared/session-storage-paths';
import { RequestTracker } from '../../shared/request-tracker';
import { BACKEND_READY_TIMEOUT_MS } from '../../shared/backend-ready-timeout';
import { redactSensitiveText } from '../../shared/sensitive-redaction';
import { bootTraceSync } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';
import {
  getLivePipelineTraceHmacKey,
  getLivePipelineTraceRunId,
  isLivePipelineTraceEnabled,
  recordLivePipelineTrace,
} from '../util/live-pipeline-trace-runtime';
import { classifyBackendStderrLine } from './stderr-classifier';
import { reapOrphanedBackends, type OrphanReapResult } from './orphan-reaper';
import { deriveTrustedSdkRoot } from './trusted-sdk-root';
import type { CommitAwareRequestOptions } from '../core/effect-runner';
import {
  assertProtocolVersion,
  type BackendReadyPayload,
  type EventEnvelope,
  isEventEnvelope,
  isResponseEnvelope,
  type ResponseEnvelope,
} from '../../shared/protocol';

export interface BackendStartOptions {
  nodePath: string;
  backendPath: string;
  sdkPath: string;
  cwd: string;
}

export interface BackendClientOptions {
  /** Test/diagnostic override; production uses BACKEND_READY_TIMEOUT_MS. */
  readyTimeoutMs?: number;
  /** Test seam that prevents unit clients from enumerating machine processes. */
  orphanReaper?: () => Promise<OrphanReapResult>;
}

export interface CorrelatedBackendFailure {
  backendGeneration: number;
  requestId: string;
  method: string;
  code: string;
  message: string;
  sessionPath?: string;
}

/** Error returned by a correlated backend response. Its stable identity/code
 * let the host assign analytics and notice ownership without a duplicate public
 * `error` event. */
export class BackendRpcError extends Error {
  constructor(
    readonly requestId: string,
    readonly method: string,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackendRpcError';
  }
}

/** Maximum number of bytes of stderr we keep in memory (ring buffer). */
const STDERR_BUFFER_LIMIT = 64 * 1024;
// Retain enough raw prefix context that a ring-buffer trim cannot normally
// sever a credential label from its value before boundary-time redaction.
const STDERR_REDACTION_OVERLAP_BYTES = 1024;

function utf8Tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  // Do not begin in the middle of a UTF-8 continuation sequence.
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/** Time to wait for the backend process to exit after SIGTERM before escalating
 *  to SIGKILL. */
const STOP_KILL_TIMEOUT_MS = 5_000;

/**
 * A PATH-discovered Node executable may be a process-managing shim (for
 * example proto's Windows shim). Node's ChildProcess handle then refers to
 * the shim, not the real backend descendant, so ChildProcess.kill() alone can
 * strand the backend. Terminate the whole tree on Windows and retain the
 * direct kill fallback for non-Windows and test doubles.
 */
function terminateProcessTree(proc: cp.ChildProcess, signal?: NodeJS.Signals): void {
  if (process.platform === 'win32' && typeof proc.pid === 'number') {
    const killer = cp.spawn(
      'taskkill.exe',
      ['/PID', String(proc.pid), '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );
    let fallbackAttempted = false;
    const fallbackKill = (): void => {
      if (fallbackAttempted) return;
      fallbackAttempted = true;
      try {
        proc.kill(signal);
      } catch {
        // The process may already have exited while taskkill was starting.
      }
    };
    killer.once('error', fallbackKill);
    killer.once('exit', (code) => {
      if (code !== 0) fallbackKill();
    });
    killer.unref?.();
    return;
  }

  try {
    proc.kill(signal);
  } catch {
    // The process may already have exited; the exit handler will settle state.
  }
}

/** Default timeout for backend RPC calls if no per-method override is set. */
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/**
 * Time the host waits for the backend to emit `backend.ready` after spawn.
 * See `shared/backend-ready-timeout.ts` for rationale (cold SDK load on
 * Windows takes ~30s; a 30s budget races it). Shared with the reducer
 * watchdog so the two never drift.
 */
const READY_TIMEOUT_MS = BACKEND_READY_TIMEOUT_MS;

/**
 * Per-method timeouts. Methods doing disk I/O or batch work get a longer
 * budget; very fast in-memory queries can use the default.
 *
 * `message.send` is sized short (~10s) because Brief A made it early-ack at
 * queue time (before the pruning prepass): it only needs to cover accepting
 * the prompt, not the prepass or first token. The post-ack, pre-commit phase
 * is owned by `EffectRunner`'s send-timer (dispatches `PreflightFailed` on
 * fire). See `docs/STATE_CONTRACT.md` § Optimistic Reconciliation "Timer
 * ownership". A per-call override can be passed via `request`'s `options`.
 */
const RPC_TIMEOUTS_MS: Record<string, number> = {
  // The coordinator applies this locally and synchronizes both runtime prefs
  // and provider policy across every hot worker before acknowledging. A 5s
  // host deadline could report failure even though that authoritative sync
  // was still completing, especially during restart or heavy tool progress.
  'runtimePrefs.set': 60_000,
  'session.list': 60_000,
  'session.create': 60_000,
  'session.open': 60_000,
  'session.preload': 60_000,
  // Forget waits for any admitted promotion teardown before committing
  // deletion. Match service initialization rather than timing out and letting
  // a late backend delete race the host's rollback reopen.
  'session.forget': 60_000,
  'session.loadTranscriptPage': 30_000,
  // Phase 5 demand-driven subagent detail. Subscribe awaits the worker's
  // correlated `detail.start`; fetch awaits the requested page baseline match.
  'detail.subscribe': 30_000,
  'detail.unsubscribe': 15_000,
  'detail.fetch': 30_000,
  'settings.set': 60_000,
  'settings.get': 15_000,
  'models.list': 15_000,
  'app.ping': 10_000,
  'diagnostics.livePipeline.setEnabled': 5_000,
  'message.send': 10_000,
  'message.compact': 300_000,
  'message.interrupt': 15_000,
  'message.clearQueue': 10_000,
  'extension_ui.response': 10_000,
};

export class BackendClient implements vscode.Disposable {
  private readonly correlatedFailures = new vscode.EventEmitter<CorrelatedBackendFailure>();
  readonly onDidCorrelatedRequestFail = this.correlatedFailures.event;
  private readonly events = new vscode.EventEmitter<EventEnvelope>();
  private readonly exits = new vscode.EventEmitter<{ code: number | null; stderr: string }>();
  private readonly requests = new RequestTracker<ResponseEnvelope>();
  /** Exact correlated response observers for requests whose application-level
   * waiter may time out before the backend's destructive operation settles. */
  private readonly correlatedResponseObservers = new Map<
    string,
    (settlement: ResponseEnvelope | Error) => void
  >();

  private proc?: cp.ChildProcess;
  private requestCounter = 0;
  private stderrBuffer = '';
  private stderrLineBuffer = '';
  private detachReader?: () => void;
  private killEscalationTimer?: ReturnType<typeof setTimeout>;
  private killEscalationProcess?: cp.ChildProcess;
  private stopPromise?: Promise<void>;
  private generation = 0;
  private readonly intentionalStops = new WeakSet<cp.ChildProcess>();

  readonly onEvent = this.events.event;
  readonly onExit = this.exits.event;

  constructor(private readonly options: BackendClientOptions = {}) {}

  /** Host-authoritative generation allocated for the latest spawn attempt. */
  getGeneration(): number {
    return this.generation;
  }

  /**
   * Start the backend. Safe to call again after a previous backend exited
   * (we no longer hard-reject when `proc` is set — it's been cleared on exit).
   */
  async start(options: BackendStartOptions): Promise<BackendReadyPayload> {
    if (this.proc) {
      throw new Error('Backend is already running');
    }

    // Reap any orphaned backend whose extension host is dead before spawning a
    // fresh one. This is the startup-time safety net for the recurring
    // "multiple backends" problem (a stale backend pegging a CPU core and
    // competing for session files). Best-effort and non-blocking.
    // Process enumeration is a legacy recovery net and can take seconds on
    // Windows. Run it alongside backend startup so self-healing never delays a
    // responsive UI; the lifetime pipe prevents newly launched generations
    // from becoming orphans in the first place.
    void (this.options.orphanReaper ?? reapOrphanedBackends)().then((reap) => {
      if (reap.reaped.length > 0) {
        appendPieLog('warn', 'backend', 'reaped orphaned backend process(es) during start', {
          candidates: reap.candidates,
          pids: reap.reaped,
        });
      }
      if (reap.failures.length > 0) {
        appendPieLog('warn', 'backend', 'orphan backend reap was incomplete', {
          candidates: reap.candidates,
          failures: reap.failures,
        });
      }
    }).catch((error) => {
      appendPieLog('warn', 'backend', 'orphan backend reap failed (non-fatal)', { error: toErrorMessage(error) });
    });

    this.stderrBuffer = '';
    this.stderrLineBuffer = '';
    // The backend's assertAllowedSdkPath only loads SDKs under trusted roots
    // (user profile / program files / npm prefix). VS Code's extension host
    // doesn't always set NPM_CONFIG_PREFIX, so derive the trusted root from
    // the sdkPath we already resolved via `npm root -g` and pass it through.
    const trustedRoot = deriveTrustedSdkRoot(options.sdkPath);
    const trustedRootEnv = trustedRoot ? { PIE_TRUSTED_SDK_ROOT: trustedRoot } : {};
    const {
      agentDir: agentDirEnv,
      sessionDir: sessionDirEnv,
      reviewsDir: reviewsDirEnv,
      triggersDir: triggersDirEnv,
    } = resolveHostSessionStoragePaths(
      process.env.PI_CODING_AGENT_DIR,
      process.env.PI_CODING_AGENT_SESSION_DIR,
    );
    // Session reviews live in a sibling of the sessions dir so the backend
    // (reader) and the session_review tool (writer) — same process — agree on
    // the sidecar location via `PIE_REVIEWS_DIR`.
    // Deferred-trigger sidecar (sibling of sessions dir). The host registry
    // (reader/fire-writer) and the `defer_trigger` tool (register/cancel
    // writer) agree on the location through the shared session path resolver;
    // the backend tool reads `PIE_TRIGGERS_DIR` set here.
    const backendEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PIE_EDITOR_VERSION: vscode.version,
      ...(reviewsDirEnv ? { PIE_REVIEWS_DIR: reviewsDirEnv } : {}),
      ...(triggersDirEnv ? { PIE_TRIGGERS_DIR: triggersDirEnv } : {}),
      PIE_LIVE_PIPELINE_TRACE_KEY: getLivePipelineTraceHmacKey(),
      PIE_LIVE_PIPELINE_TRACE_RUN_ID: getLivePipelineTraceRunId(),
      ...trustedRootEnv,
    };
    // Do not leak blank/raw relative values through process.env: the child
    // receives only the normalized authority, or no override so SDK defaults
    // remain intact.
    delete backendEnv.PI_CODING_AGENT_DIR;
    delete backendEnv.PI_CODING_AGENT_SESSION_DIR;
    if (agentDirEnv) backendEnv.PI_CODING_AGENT_DIR = agentDirEnv;
    if (sessionDirEnv) backendEnv.PI_CODING_AGENT_SESSION_DIR = sessionDirEnv;

    // Allocate the host-authoritative backend generation before spawning so
    // the child can stamp every coordinator/worker/detail fence with the same
    // identity the host uses to reject stale traffic after restart.
    const generation = this.generation + 1;
    this.generation = generation;
    const proc = cp.spawn(
      options.nodePath,
      [
        options.backendPath,
        '--sdkPath', options.sdkPath,
        '--cwd', options.cwd,
        '--hostPid', String(process.pid),
        '--backendGeneration', String(generation),
        '--lifetimeFd', '3',
      ],
      {
        cwd: options.cwd,
        env: backendEnv,
        // fd 3 is a dedicated ownership lease. Unlike stdin it is never passed
        // through the JSONL transport and cannot be kept alive by pending RPC
        // drainage. The backend exits when the host side disappears.
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        shell: false,
      },
    );

    appendPieLog('info', 'backend', 'starting pie backend', {
      backendPath: options.backendPath,
      cwd: options.cwd,
      sdkPath: options.sdkPath,
      agentDir: agentDirEnv ?? null,
      sessionDir: sessionDirEnv ?? null,
      reviewsDir: reviewsDirEnv ?? null,
      triggersDir: triggersDirEnv ?? null,
    });

    this.proc = proc;

    if (!proc.stdout || !proc.stderr || !proc.stdin) {
      this.proc = undefined;
      throw new Error('Backend process did not expose stdio pipes as expected.');
    }

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      if (generation === this.generation) this.appendStderr(chunk);
    });
    // EPIPE on child stdin is emitted on the stream, not necessarily on the
    // ChildProcess. Observe it so a backend that loses its control pipe cannot
    // crash the extension host or leave every RPC waiting for its timeout.
    proc.stdin.on('error', (error) => {
      if (generation !== this.generation || this.proc !== proc) return;
      this.requests.rejectAll(new Error(`Backend stdin failed: ${toErrorMessage(error)}`));
      appendPieLog('error', 'backend', 'backend stdin failed; terminating backend', {
        generation,
        error: toErrorMessage(error),
      });
      terminateProcessTree(proc);
    });

    proc.on('exit', (code) => {
      const intentional = this.intentionalStops.has(proc);
      if (this.killEscalationProcess === proc && this.killEscalationTimer) {
        clearTimeout(this.killEscalationTimer);
        this.killEscalationTimer = undefined;
        this.killEscalationProcess = undefined;
      }
      if (generation === this.generation) {
        this.flushStderrLines(true);
        this.detachReader?.();
        this.detachReader = undefined;
        if (this.proc === proc) this.proc = undefined;
      }
      const current = generation === this.generation;
      if (!intentional && current) {
        this.requests.rejectAll(
          new Error(`Backend exited unexpectedly${code === null ? '' : ` with code ${code}`}.`),
        );
      }
      if (!intentional && current && isLivePipelineTraceEnabled()) {
        recordLivePipelineTrace({
          process: 'host',
          stage: 'host.recovery.action',
          kind: 'failure',
          reasonCode: 'backend_exit',
        });
      }
      appendPieLog(intentional ? 'info' : 'error', 'backend', intentional ? 'backend process stopped' : 'backend process exited', {        code,
        generation,
        current,
        stderrTail: current ? this.stderrDiagnosticTail(4000) || null : null,
      });
      if (!intentional && current) this.exits.fire({ code, stderr: this.stderrDiagnosticTail() });
    });

    proc.on('error', (error) => {
      if (generation === this.generation) this.requests.rejectAll(error);
    });

    return new Promise<BackendReadyPayload>((resolve, reject) => {
      let settled = false;

      const finishReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        readyDisposable.dispose();
        exitDisposable.dispose();
        errorDisposable.dispose();
        clearTimeout(timeout);
        reject(error);
      };

      const finishResolve = (payload: BackendReadyPayload) => {
        if (settled) {
          return;
        }
        settled = true;
        readyDisposable.dispose();
        exitDisposable.dispose();
        errorDisposable.dispose();
        clearTimeout(timeout);
        resolve(payload);
      };

      const readyDisposable = this.onEvent((event) => {
        if (generation !== this.generation || this.proc !== proc) return;
        if (event.event !== 'backend.ready') {
          return;
        }

        try {
          const payload = event.payload as BackendReadyPayload;
          assertProtocolVersion('backend.ready', payload.protocolVersion);
          if (payload.backendGeneration !== undefined && payload.backendGeneration !== generation) {
            throw new Error(`Backend generation mismatch: expected ${generation}, received ${payload.backendGeneration}.`);
          }
          finishResolve(payload);
        } catch (error) {
          finishReject(error instanceof Error ? error : new Error(String(error)));
          this.forceStopProcess();
        }
      });

      // Observe this exact child directly. Intentional stops suppress the
      // public onExit event, but start() still has to reject immediately rather
      // than hang until the readiness timeout.
      const localExitListener = (code: number | null) => {
        finishReject(
          new Error(
            `Backend failed to start${code === null ? '' : ` (code ${code})`}${
              this.stderrDiagnosticTail() ? `: ${this.stderrDiagnosticTail()}` : ''
            }`,
          ),
        );
      };
      proc.once('exit', localExitListener);
      const exitDisposable = { dispose: () => proc.off('exit', localExitListener) };

      const errorListener = (error: Error) => {
        if (generation === this.generation && this.proc === proc) this.proc = undefined;
        appendPieLog('error', 'backend', 'failed to spawn backend process', {
          backendPath: options.backendPath,
          cwd: options.cwd,
          nodePath: options.nodePath,
          sdkPath: options.sdkPath,
          error: error.message,
        });
        finishReject(
          new Error(
            `Failed to spawn pie backend with node=${options.nodePath}, backend=${options.backendPath}, cwd=${options.cwd}: ${error.message}`,
          ),
        );
      };
      proc.once('error', errorListener);
      const errorDisposable = { dispose: () => proc.off('error', errorListener) };

      const timeout = setTimeout(() => {
        finishReject(new Error('Timed out waiting for the pie backend to become ready.'));
        // A child that never reaches ready is unusable. Stop this exact
        // generation so a retry is possible instead of leaving start() failed
        // while `proc` remains permanently "already running".
        if (generation === this.generation && this.proc === proc) {
          this.forceStopProcess();
        }
      }, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);

      // Attach stdout after the ready/exit/error listeners are armed. A fast
      // backend can emit `backend.ready` immediately on startup; attaching the
      // line reader earlier can drop that event before `start()` subscribes.
      this.detachReader = attachJsonlLineReader(proc.stdout, (line) => {
        this.handleLine(line);
      }, {
        maxLineBytes: JSONL_MAX_LINE_BYTES,
        onOverflow: ({ maxLineBytes, preview }) => {
          appendPieLog('error', 'backend-client', 'backend stdout JSONL line exceeded limit; terminating backend', {
            maxLineBytes,
            preview,
          });
          if (this.proc === proc) terminateProcessTree(proc);
        },
      });
    });
  }

  /** Issue a JSON-RPC request and await its response.
   *
   *  `options.timeoutMs` overrides the method default (`RPC_TIMEOUTS_MS`);
   *  `options.signal` aborts only the local waiter because the JSON-RPC
   *  transport has no cancellation frame. `onTransportSettled` lets the
   *  preload scheduler retain its physical background-concurrency slot until
   *  the correlated response, write failure, or backend shutdown arrives. */
  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: CommitAwareRequestOptions<TResult>,
  ): Promise<TResult> {
    if (!this.proc?.stdin) {
      options?.onTransportSettled?.();
      throw new Error('Backend is not running');
    }

    const id = `req-${++this.requestCounter}`;
    const timeoutMs = options?.timeoutMs ?? RPC_TIMEOUTS_MS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
    if (options?.onCorrelatedResponse) {
      const observer = options.onCorrelatedResponse;
      this.correlatedResponseObservers.set(id, (settlement) => {
        if (settlement instanceof Error) {
          observer({ ok: false, error: settlement });
        } else if (settlement.ok) {
          observer({ ok: true, result: settlement.result as TResult });
        } else {
          observer({
            ok: false,
            error: new BackendRpcError(id, method, settlement.error.code, settlement.error.message),
          });
        }
      });
    }
    const retainCorrelation = options?.onCorrelatedResponse !== undefined;
    const responsePromise = this.requests.create(
      id,
      timeoutMs,
      options?.signal,
      retainCorrelation || options?.onTransportSettled
        ? () => {
            // A normal/late response removes and notifies the observer in
            // handleLine before RequestTracker runs this callback. Reaching
            // here with an observer still installed means the physical
            // request ended without a usable correlated response (write
            // failure, malformed response, backend shutdown, or disposal).
            this.settleCorrelatedResponseObserver(
              id,
              new Error(`Backend transport settled without a correlated response for ${id}.`),
            );
            options?.onTransportSettled?.();
          }
        : undefined,
    );

    bootTraceSync('backend-client', 'request.sent', { id, method, timeoutMs });
    try {
      this.proc.stdin.write(serializeJsonLine({ id, method, params }), (error) => {
        if (error) this.requests.reject(id, new Error(`Failed to write backend request ${id}: ${toErrorMessage(error)}`));
      });
    } catch (error) {
      this.requests.reject(id, new Error(`Failed to write backend request ${id}: ${toErrorMessage(error)}`));
    }

    try {
      const response = await responsePromise;
      bootTraceSync('backend-client', 'response.received', { id, method });
      if (!response.ok) {
        const sessionPath = params && typeof params === 'object'
          && typeof (params as { sessionPath?: unknown }).sessionPath === 'string'
          ? (params as { sessionPath: string }).sessionPath
          : undefined;
        this.correlatedFailures.fire({
          backendGeneration: this.generation,
          requestId: id,
          method,
          code: response.error.code,
          message: response.error.message,
          ...(sessionPath ? { sessionPath } : {}),
        });
        throw new BackendRpcError(id, method, response.error.code, response.error.message);
      }
      return response.result as TResult;
    } catch (error) {
      bootTraceSync('backend-client', 'request.failed', { id, method, error: toErrorMessage(error) });
      throw error;
    }
  }

  /**
   * Stop the running backend. Safe to call when no backend is running. Use
   * `start()` again afterwards to bring up a fresh process.
   */
  async stop(): Promise<void> {
    if (!this.stopPromise) {
      const operation = this.stopProcessGracefully();
      const tracked = operation.finally(() => {
        if (this.stopPromise === tracked) this.stopPromise = undefined;
      });
      this.stopPromise = tracked;
    }
    await this.stopPromise;
    // Keep stdout attached during graceful drain: accepted RPCs (especially
    // settings.set) must be allowed to resolve before shutdown. The exit
    // handler detaches the reader; reject only requests the backend could not
    // settle before its confirmed exit.
    this.requests.rejectAll(new Error('Backend stopped.'));
  }

  /** Close stdin first so the backend can drain an accepted settings write and
   * release its cross-process lock before the replacement generation starts.
   * A bounded force-kill still guarantees restart cannot hang indefinitely. */
  private async stopProcessGracefully(): Promise<void> {
    if (!this.proc) return;
    const proc = this.proc;
    this.intentionalStops.add(proc);
    this.proc = undefined;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));

    this.killEscalationProcess = proc;
    this.killEscalationTimer = setTimeout(() => {
      if (this.killEscalationProcess === proc) {
        this.killEscalationTimer = undefined;
        this.killEscalationProcess = undefined;
      }
      appendPieLog('warn', 'backend', 'backend did not exit after stdin close, escalating to forced termination');
      terminateProcessTree(proc, 'SIGKILL');
    }, STOP_KILL_TIMEOUT_MS);

    try {
      if (!proc.stdin || proc.stdin.destroyed) terminateProcessTree(proc);
      else proc.stdin.end();
    } catch {
      terminateProcessTree(proc);
    }
    await exited;
  }

  /** Startup/protocol failures have no accepted work worth draining. */
  private forceStopProcess(): void {
    if (!this.proc) return;
    const proc = this.proc;
    this.intentionalStops.add(proc);
    this.proc = undefined;
    terminateProcessTree(proc, 'SIGKILL');
  }

  private handleLine(line: string): void {
    const traceStartedAt = isLivePipelineTraceEnabled() ? performance.now() : 0;
    let value: unknown;
    let parseError: Error | undefined;

    try {
      value = JSON.parse(line);
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
    }

    if (parseError === undefined) {
      if (isResponseEnvelope(value)) {
        this.traceLineReceipt(value, traceStartedAt, line, 'success');
        // Deliver before RequestTracker.resolve: its transport-settlement hook
        // intentionally treats a still-installed observer as a no-response
        // failure. This ordering also lets a late response resolve the
        // commit-aware waiter while the ordinary application promise remains
        // timed out.
        this.settleCorrelatedResponseObserver(value.id, value);
        this.requests.resolve(value.id, value);
        return;
      }

      if (isEventEnvelope(value)) {
        this.traceLineReceipt(value, traceStartedAt, line, 'success');
        this.events.fire(value);
        return;
      }
      // Parsed JSON but not a recognized envelope — fall through to
      // correlation (it may carry an `id` for a pending request).
    }

    this.traceLineReceipt(value, traceStartedAt, line, 'failure');

    // Dropped line (non-JSON or an unrecognized envelope). The backend should
    // only emit valid JSON-RPC envelopes on stdout; a stray log line or a
    // corrupted stream previously caused "random hangs" — an expected response
    // never arrives, the UI stays busy, the RPC eventually times out with no
    // clear cause. Brief B: attempt to correlate the dropped line to a pending
    // `req-NN` and reject that request with a diagnostic (snippet + stderr
    // tail) instead of letting it time out opaquely. Brief H maps these to
    // plain-language messages.
    const reqId = extractRequestId(line, value);
    if (reqId) {
      const error = this.buildDroppedLineError(reqId, line, parseError);
      if (this.requests.reject(reqId, error)) {
        return;
      }
    }

    // No correlation possible (no recoverable id, or no pending request for
    // it) — log loudly so the failure mode stays debuggable.
    const preview = line.length > 200 ? `${line.slice(0, 200)}…` : line;
    const reason = parseError ? toErrorMessage(parseError) : 'unrecognized envelope';
    appendPieLog('warn', 'backend-client', 'dropped unparseable backend line', { reason, preview });
  }

  private settleCorrelatedResponseObserver(id: string, settlement: ResponseEnvelope | Error): void {
    const observer = this.correlatedResponseObservers.get(id);
    if (!observer) return;
    this.correlatedResponseObservers.delete(id);
    try {
      observer(settlement);
    } catch (error) {
      appendPieLog('error', 'backend-client', 'correlated response observer failed', {
        id,
        error: toErrorMessage(error),
      });
    }
  }

  private traceLineReceipt(
    envelope: unknown,
    startedAt: number,
    line: string,
    kind: 'success' | 'failure',
  ): void {
    if (!isLivePipelineTraceEnabled()) return;
    const payload = envelope && typeof envelope === 'object'
      ? (envelope as { id?: unknown; payload?: unknown }).payload
      : undefined;
    const scoped = payload && typeof payload === 'object' ? payload as Record<string, unknown> : undefined;
    const outer = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : undefined;
    recordLivePipelineTrace({
      process: 'host',
      stage: 'host.line.received',
      kind,
      identifiers: {
        ...(typeof scoped?.sessionPath === 'string' ? { session: scoped.sessionPath } : {}),
        ...(typeof scoped?.requestId === 'string' ? { request: scoped.requestId } : typeof outer?.id === 'string' ? { request: outer.id } : {}),
        ...(typeof scoped?.turnId === 'string' ? { turn: scoped.turnId } : {}),
        ...(typeof scoped?.attemptId === 'string' ? { attempt: scoped.attemptId } : {}),
        ...(typeof scoped?.messageId === 'string' ? { message: scoped.messageId } : {}),
        ...(typeof scoped?.toolCallId === 'string' ? { tool: scoped.toolCallId } : {}),
      },
      durationMs: Math.max(0, performance.now() - startedAt),
      queueBytes: Buffer.byteLength(line, 'utf8'),
      reasonCode: kind === 'failure' ? 'malformed_payload' : undefined,
    });
  }

  /** Build a descriptive rejection error for a dropped line correlated to a
   *  pending request. Includes the parse reason, a line snippet, and the
   *  stderr tail when present (Brief H consumes this for plain-language
   *  mapping). */
  private buildDroppedLineError(
    reqId: string,
    line: string,
    parseError: Error | undefined,
  ): Error {
    const rawSnippet = line.length > 200 ? `${line.slice(0, 200)}…` : line;
    const snippet = redactSensitiveText(rawSnippet);
    const reason = redactSensitiveText(parseError ? toErrorMessage(parseError) : 'unrecognized response envelope');
    const stderrTail = this.stderrDiagnosticTail();
    const stderrPart = stderrTail ? ` (stderr tail: ${stderrTail.slice(-200)})` : '';
    return new Error(
      `Backend sent an unparseable response for ${reqId}: ${reason} :: ${snippet}${stderrPart}`,
    );
  }

  private appendStderr(chunk: string): void {
    // Keep raw bounded bytes until a complete diagnostic boundary exists.
    // Redacting each chunk is unsafe: `authorization=sec` + `ret` would turn
    // into `[redacted]ret`, leaking the credential suffix.
    this.stderrBuffer = utf8Tail(
      this.stderrBuffer + chunk,
      STDERR_BUFFER_LIMIT + STDERR_REDACTION_OVERLAP_BYTES,
    );

    // A newline-free stderr stream must not grow without bound. Keep the
    // diagnostic tail, matching stderrBuffer's byte-bounded behavior.
    this.stderrLineBuffer = utf8Tail(
      this.stderrLineBuffer + chunk,
      STDERR_BUFFER_LIMIT + STDERR_REDACTION_OVERLAP_BYTES,
    );
    this.flushStderrLines(false);
  }

  private stderrDiagnosticTail(maxBytes = STDERR_BUFFER_LIMIT): string {
    return utf8Tail(redactSensitiveText(this.stderrBuffer), maxBytes).trim();
  }

  private flushStderrLines(flushPartial: boolean): void {
    let newlineIndex = this.stderrLineBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.stderrLineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      this.stderrLineBuffer = this.stderrLineBuffer.slice(newlineIndex + 1);
      this.logStderrLine(line);
      newlineIndex = this.stderrLineBuffer.indexOf('\n');
    }

    if (flushPartial && this.stderrLineBuffer.trim()) {
      const line = this.stderrLineBuffer.replace(/\r$/, '');
      this.stderrLineBuffer = '';
      this.logStderrLine(line);
    }
  }

  private logStderrLine(line: string): void {
    const trimmed = redactSensitiveText(line).trim();
    if (!trimmed) {
      return;
    }

    // Structured stderr contract: classify the line from its structured
    // `level` field (parsed by `classifyBackendStderrLine`), falling back to
    // the legacy substring heuristic for non-JSON / legacy lines so no line is
    // ever dropped. See `./stderr-classifier` for the contract details.
    const level = classifyBackendStderrLine(trimmed);
    appendPieLog(level, 'backend-stderr', trimmed);
  }

  dispose(): void {
    this.detachReader?.();
    this.detachReader = undefined;
    if (!this.stopPromise) void this.stopProcessGracefully();
    this.requests.rejectAll(new Error('Backend client disposed.'));
    this.events.dispose();
    this.exits.dispose();
    this.correlatedFailures.dispose();
  }
}

/** Best-effort extraction of a pending `req-NN` id from a dropped backend line.
 *  Handles both parsed-but-unrecognized envelopes (with an `id` field) and
 *  truncated/garbled JSON (regex on the raw line). Returns `undefined` when no
 *  request id can be recovered. The caller (`handleLine`) passes the result to
 *  `RequestTracker.reject`, which no-ops if the id is not pending — so a
 *  spurious extraction is harmless. Exported for direct unit testing. */
export function extractRequestId(line: string, value: unknown): string | undefined {
  if (value && typeof value === 'object') {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') {
      return id;
    }
  }
  // Truncated/partial JSON: best-effort regex extract of the only id scheme
  // the client mints (`req-${++requestCounter}`).
  const match = /"id"\s*:\s*"(req-\d+)"/.exec(line);
  return match?.[1];
}
