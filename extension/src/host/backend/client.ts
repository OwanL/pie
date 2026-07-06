import * as cp from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

import { attachJsonlLineReader, serializeJsonLine } from '../../shared/jsonl';
import { getDeferredTriggersDir } from '../../shared/deferred-triggers-paths';
import { RequestTracker, type RequestOptions } from '../../shared/request-tracker';
import { BACKEND_READY_TIMEOUT_MS } from '../../shared/backend-ready-timeout';
import { bootTraceSync } from '../util/audit';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';
import { deriveTrustedSdkRoot } from './trusted-sdk-root';
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

/** Maximum number of bytes of stderr we keep in memory (ring buffer). */
const STDERR_BUFFER_LIMIT = 64 * 1024;

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
  'runtimePrefs.set': 5_000,
  'session.list': 60_000,
  'session.create': 60_000,
  'session.open': 60_000,
  'session.preload': 60_000,
  'session.loadTranscriptPage': 30_000,
  'settings.set': 60_000,
  'settings.get': 15_000,
  'models.list': 15_000,
  'app.ping': 10_000,
  'message.send': 10_000,
  'message.interrupt': 15_000,
  'message.clearQueue': 10_000,
  'extension_ui.response': 10_000,
};

export class BackendClient implements vscode.Disposable {
  private readonly events = new vscode.EventEmitter<EventEnvelope>();
  private readonly exits = new vscode.EventEmitter<{ code: number | null; stderr: string }>();
  private readonly requests = new RequestTracker<ResponseEnvelope>();

  private proc?: cp.ChildProcess;
  private requestCounter = 0;
  private stderrBuffer = '';
  private stderrLineBuffer = '';
  private detachReader?: () => void;

  readonly onEvent = this.events.event;
  readonly onExit = this.exits.event;

  /**
   * Start the backend. Safe to call again after a previous backend exited
   * (we no longer hard-reject when `proc` is set — it's been cleared on exit).
   */
  async start(options: BackendStartOptions): Promise<BackendReadyPayload> {
    if (this.proc) {
      throw new Error('Backend is already running');
    }

    this.stderrBuffer = '';
    this.stderrLineBuffer = '';
    // The backend's assertAllowedSdkPath only loads SDKs under trusted roots
    // (user profile / program files / npm prefix). VS Code's extension host
    // doesn't always set NPM_CONFIG_PREFIX, so derive the trusted root from
    // the sdkPath we already resolved via `npm root -g` and pass it through.
    const trustedRoot = deriveTrustedSdkRoot(options.sdkPath);
    const trustedRootEnv = trustedRoot ? { PIE_TRUSTED_SDK_ROOT: trustedRoot } : {};
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
    const sessionDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR?.trim()
      || (agentDir ? path.join(agentDir, 'data', 'outcomes', 'sessions') : undefined);
    // Session reviews live in a sibling of the sessions dir so the backend
    // (reader) and the session_review tool (writer) — same process — agree on
    // the sidecar location via `PIE_REVIEWS_DIR`.
    const reviewsDirEnv = sessionDirEnv
      ? path.join(path.dirname(sessionDirEnv), 'session-reviews')
      : undefined;
    // Deferred-trigger sidecar (sibling of sessions dir). The host registry
    // (reader/fire-writer) and the `defer_trigger` tool (register/cancel
    // writer) agree on the location: the host derives it via
    // `getDeferredTriggersDir()` (same env), the backend tool reads
    // `PIE_TRIGGERS_DIR` set here.
    const triggersDirEnv = getDeferredTriggersDir();
    const proc = cp.spawn(
      options.nodePath,
      [options.backendPath, '--sdkPath', options.sdkPath, '--cwd', options.cwd],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          PIE_EDITOR_VERSION: vscode.version,
          ...(sessionDirEnv ? { PI_CODING_AGENT_SESSION_DIR: sessionDirEnv } : {}),
          ...(reviewsDirEnv ? { PIE_REVIEWS_DIR: reviewsDirEnv } : {}),
          ...(triggersDirEnv ? { PIE_TRIGGERS_DIR: triggersDirEnv } : {}),
          ...trustedRootEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      },
    );

    appendPieLog('info', 'backend', 'starting pie backend', {
      backendPath: options.backendPath,
      cwd: options.cwd,
      sdkPath: options.sdkPath,
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
      this.appendStderr(chunk);
    });

    proc.on('exit', (code) => {
      this.flushStderrLines(true);
      this.detachReader?.();
      this.detachReader = undefined;
      this.proc = undefined;
      this.requests.rejectAll(
        new Error(`Backend exited unexpectedly${code === null ? '' : ` with code ${code}`}.`),
      );
      appendPieLog('error', 'backend', 'backend process exited', {
        code,
        stderrTail: this.stderrBuffer.trim().slice(-4000) || null,
      });
      this.exits.fire({ code, stderr: this.stderrBuffer.trim() });
    });

    proc.on('error', (error) => {
      this.requests.rejectAll(error);
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
        if (event.event !== 'backend.ready') {
          return;
        }

        try {
          const payload = event.payload as BackendReadyPayload;
          assertProtocolVersion('backend.ready', payload.protocolVersion);
          finishResolve(payload);
        } catch (error) {
          finishReject(error instanceof Error ? error : new Error(String(error)));
          void this.stop().catch(() => undefined);
        }
      });

      const exitDisposable = this.onExit(({ code, stderr }) => {
        finishReject(
          new Error(
            `Backend failed to start${code === null ? '' : ` (code ${code})`}${
              stderr ? `: ${stderr}` : ''
            }`,
          ),
        );
      });

      const errorListener = (error: Error) => {
        this.proc = undefined;
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
      }, READY_TIMEOUT_MS);

      // Attach stdout after the ready/exit/error listeners are armed. A fast
      // backend can emit `backend.ready` immediately on startup; attaching the
      // line reader earlier can drop that event before `start()` subscribes.
      this.detachReader = attachJsonlLineReader(proc.stdout, (line) => {
        this.handleLine(line);
      });
    });
  }

  /** Issue a JSON-RPC request and await its response.
   *
   *  `options.timeoutMs` overrides the method default (`RPC_TIMEOUTS_MS`);
   *  `options.signal` aborts an in-flight request cleanly (Brief E cancels an
   *  in-flight `message.send` on interrupt; session stop rejects all via
   *  `rejectAll`). The tracker timeout owns the pre-ack window. */
  async request<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: RequestOptions,
  ): Promise<TResult> {
    if (!this.proc?.stdin) {
      throw new Error('Backend is not running');
    }

    const id = `req-${++this.requestCounter}`;
    const timeoutMs = options?.timeoutMs ?? RPC_TIMEOUTS_MS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
    const responsePromise = this.requests.create(id, timeoutMs, options?.signal);

    bootTraceSync('backend-client', 'request.sent', { id, method, timeoutMs });
    this.proc.stdin.write(serializeJsonLine({ id, method, params }));

    try {
      const response = await responsePromise;
      bootTraceSync('backend-client', 'response.received', { id, method });
      if (!response.ok) {
        throw new Error(response.error.message);
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
    this.detachReader?.();
    this.detachReader = undefined;
    if (this.proc) {
      this.proc.kill();
      this.proc = undefined;
    }
    this.requests.rejectAll(new Error('Backend stopped.'));
  }

  private handleLine(line: string): void {
    let value: unknown;
    let parseError: Error | undefined;

    try {
      value = JSON.parse(line);
    } catch (error) {
      parseError = error instanceof Error ? error : new Error(String(error));
    }

    if (parseError === undefined) {
      if (isResponseEnvelope(value)) {
        this.requests.resolve(value.id, value);
        return;
      }

      if (isEventEnvelope(value)) {
        this.events.fire(value);
        return;
      }
      // Parsed JSON but not a recognized envelope — fall through to
      // correlation (it may carry an `id` for a pending request).
    }

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

  /** Build a descriptive rejection error for a dropped line correlated to a
   *  pending request. Includes the parse reason, a line snippet, and the
   *  stderr tail when present (Brief H consumes this for plain-language
   *  mapping). */
  private buildDroppedLineError(
    reqId: string,
    line: string,
    parseError: Error | undefined,
  ): Error {
    const snippet = line.length > 200 ? `${line.slice(0, 200)}…` : line;
    const reason = parseError ? toErrorMessage(parseError) : 'unrecognized response envelope';
    const stderrTail = this.stderrBuffer.trim();
    const stderrPart = stderrTail ? ` (stderr tail: ${stderrTail.slice(-200)})` : '';
    return new Error(
      `Backend sent an unparseable response for ${reqId}: ${reason} :: ${snippet}${stderrPart}`,
    );
  }

  private appendStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
      // Keep only the trailing window — most diagnostics live near the end.
      this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
    }

    this.stderrLineBuffer += chunk;
    this.flushStderrLines(false);
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
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }

    appendPieLog(
      /\b(error|failed|exception|unexpectedly)\b/i.test(trimmed) ? 'warn' : 'info',
      'backend-stderr',
      trimmed,
    );
  }

  dispose(): void {
    this.detachReader?.();
    this.detachReader = undefined;

    if (this.proc) {
      this.proc.kill();
      this.proc = undefined;
    }

    this.requests.rejectAll(new Error('Backend client disposed.'));
    this.events.dispose();
    this.exits.dispose();
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
