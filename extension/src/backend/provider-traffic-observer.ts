/**
 * Provider traffic observer — wraps `globalThis.fetch` to capture LLM provider
 * HTTP traffic (request metadata, response status + body, connection-failure
 * cause) and emit structured diagnostic lines to stderr (→ `pie (backend).log`).
 *
 * WHY THIS EXISTS
 * The SDK (pi-coding-agent) reduces provider failures to a bare string in the
 * session JSONL: `"Connection error."` for connection failures (discarding the
 * socket cause ECONNRESET/ETIMEDOUT/…), and an opaque message for HTTP errors
 * (429/5xx) that omits the response body. This wrapper sits BELOW the SDK — it
 * sees every `globalThis.fetch` the SDK issues — so it captures the real cause,
 * the HTTP status, AND the error response body BEFORE the SDK discards them.
 *
 * DESIGN PROPERTIES
 *  - Composes with the ProviderGate, which also wraps `globalThis.fetch`: both
 *    capture the current fetch at install time and call through, so they stack
 *    in either order without bypassing each other.
 *  - Bulletproof: every observation path is try/catch-wrapped. A logging or
 *    extraction failure can NEVER alter the request — the original response is
 *    returned (or the original error rethrown) exactly as an unwrapped fetch
 *    would. Non-provider calls pass straight through with zero overhead.
 *  - Secret-safe: never logs `Authorization`/API keys, and never logs the
 *    REQUEST body (it may contain user prompts / pasted secrets). Only method,
 *    host, path, request-body SIZE, response status/headers, the response
 *    error body (capped), and the error cause-chain are recorded.
 *  - Streaming-safe: the response body is read ONLY for non-2xx (small JSON
 *    error bodies, via `response.clone()` so the caller's stream is untouched).
 *    2xx streaming responses (chat-completions SSE) are never read.
 *  - Kill-switch: `PIE_PROVIDER_TRAFFIC_LOG=0` disables. `=verbose` also logs
 *    successful 2xx responses. Idempotent.
 */
import { toErrorMessage } from '../shared/error-message';
import {
  classifyProviderHttpIncident,
  classifyProviderTransportIncident,
  publishProviderIncident,
} from './provider-incident.js';

type Level = 'info' | 'warn' | 'error';

const ENV = process.env.PIE_PROVIDER_TRAFFIC_LOG;
const ENABLED = ENV !== '0';
const VERBOSE = ENV === 'verbose';

/** Max chars of an error response body retained in the log. */
const BODY_SNIPPET_CHARS = 2048;

let installed = false;

interface ReqInfo {
  method: string;
  host: string;
  path: string;
  requestId: string | null;
  sessionAffinity: string | null;
  requestBodyBytes: number | null;
  isProvider: boolean;
}

function emit(event: string, payload: Record<string, unknown>, level: Level = 'info'): void {
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    scope: 'backend-provider-traffic',
    level,
    event,
    ...payload,
  };
  // console.warn/console.error → stderr (VS Code tags the line [warning]/[error]).
  // NEVER use console.log: the backend speaks JSON-RPC over stdout.
  const line = `[pie:backend] ${JSON.stringify(record)}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.warn(line);
  }
}

interface ErrorDescription {
  name: string;
  code: string | null;
  message: string;
  cause?: ErrorDescription;
}

/** Walk an error's cause chain, surfacing name/code/message at each level.
 *  The real transport cause (ECONNRESET etc.) usually lives under the SDK's
 *  wrapping `TypeError: fetch failed`. Depth-capped to avoid cycles. */
function describeError(err: unknown, depth = 0): ErrorDescription {
  const e = err as { name?: string; code?: string; message?: string; cause?: unknown };
  const out: ErrorDescription = {
    name: e?.name ?? (typeof err === 'string' ? 'string' : 'unknown'),
    code: typeof e?.code === 'string' ? e.code : null,
    message: typeof e?.message === 'string' && e.message.length > 0 ? e.message : toErrorMessage(err),
  };
  if (e?.cause && depth < 4) {
    out.cause = describeError(e.cause, depth + 1);
  }
  return out;
}

/** All non-sensitive response headers for an error response (rate-limit
 *  headers, server request-id, …) — the diagnostic set needed to harden
 *  against rate-limiting and correlate server-side. Credential-looking header
 *  names are redacted defensively (response headers normally carry none). */
const SENSITIVE_HEADER_RE = /auth|key|token|cookie|secret/i;
function redactedResponseHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    res.headers.forEach((value, name) => {
      if (SENSITIVE_HEADER_RE.test(name)) return;
      out[name] = value;
    });
  } catch {
    /* best-effort */
  }
  return out;
}

/** Extract non-secret request metadata. `input` may be string | URL | Request,
 *  with `init` overriding method/headers/body. */
function extractReqInfo(input: RequestInfo | URL, init?: RequestInit): ReqInfo | null {
  let urlStr: string | undefined;
  let method = 'GET';
  const h = new Headers();
  try {
    if (typeof input === 'string') {
      urlStr = input;
    } else if (input instanceof URL) {
      urlStr = input.href;
    } else if (typeof Request !== 'undefined' && input instanceof Request) {
      urlStr = input.url;
      method = input.method;
      input.headers.forEach((v, k) => h.set(k, v));
    }
    if (init) {
      if (init.method) method = String(init.method);
      if (init.headers) {
        try {
          new Headers(init.headers).forEach((v, k) => h.set(k, v));
        } catch {
          /* malformed headers */
        }
      }
    }
  } catch {
    return null;
  }
  if (!urlStr) return null;
  let host = '?';
  let path = '?';
  try {
    const u = new URL(urlStr);
    host = u.host;
    path = u.pathname;
  } catch {
    host = urlStr.slice(0, 120);
  }
  let requestBodyBytes: number | null = null;
  try {
    const b = init?.body;
    if (typeof b === 'string') {
      requestBodyBytes = Buffer.byteLength(b);
    } else if (b != null) {
      if (typeof Blob !== 'undefined' && b instanceof Blob) requestBodyBytes = b.size;
      else if (b instanceof ArrayBuffer) requestBodyBytes = b.byteLength;
      else if (ArrayBuffer.isView(b)) requestBodyBytes = (b as ArrayBufferView).byteLength;
      // ReadableStream / FormData: unknown → null (size not cheaply available)
    }
  } catch {
    /* size is best-effort */
  }
  return {
    method,
    host,
    path,
    requestId: h.get('x-client-request-id'),
    sessionAffinity: h.get('x-session-affinity') ?? h.get('session_id') ?? h.get('session-id'),
    requestBodyBytes,
    isProvider: h.has('authorization'),
  };
}

/** Install the fetch wrapper. Call once at backend startup, before any provider
 *  request is issued. Best-effort: no-ops if `globalThis.fetch` is unavailable. */
export function installProviderTrafficObserver(): void {
  if (!ENABLED || installed) return;
  installed = true;
  const prevFetch = globalThis.fetch;
  if (typeof prevFetch !== 'function') return;

  const wrapped: typeof fetch = async function providerTrafficFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let info: ReqInfo | null = null;
    try {
      info = extractReqInfo(input, init);
    } catch {
      /* extraction must never break the request */
    }
    // Non-provider calls (no Authorization): pass straight through, unobserved.
    if (!info || !info.isProvider) return prevFetch(input, init);

    const start = Date.now();
    let response: Response;
    try {
      response = await prevFetch(input, init);
    } catch (err) {
      // Connection-level failure (no HTTP response). Surface the real cause
      // the SDK would otherwise reduce to a bare "Connection error.".
      try {
        emit(
          'fetch.error',
          {
            method: info.method,
            host: info.host,
            path: info.path,
            requestBodyBytes: info.requestBodyBytes,
            durationMs: Date.now() - start,
            requestId: info.requestId,
            sessionAffinity: info.sessionAffinity,
            error: describeError(err),
          },
          'error',
        );
      } catch {
        /* never break */
      }
      try {
        if (info.sessionAffinity) {
          publishProviderIncident(classifyProviderTransportIncident({
            sessionId: info.sessionAffinity,
            requestId: info.requestId,
            providerHost: info.host,
            error: err,
          }));
        }
      } catch {
        /* incident reporting must never break */
      }
      throw err; // preserve original behavior
    }

    // Log the outcome WITHOUT risking the response.
    try {
      const status = response.status;
      const durationMs = Date.now() - start;
      const isErr = status < 200 || status >= 300;
      if (isErr) {
        // Clone + read a bounded snippet of the error body for diagnosis. The
        // clone is separate from the caller's body; the original is returned
        // intact (streaming callers are unaffected).
        let body: string | undefined;
        let bodyBytes: number | undefined;
        try {
          const text = await response.clone().text();
          bodyBytes = text.length;
          body = text.slice(0, BODY_SNIPPET_CHARS);
        } catch {
          /* body unreadable (e.g. already-locked stream) */
        }
        emit(
          'response.error',
          {
            method: info.method,
            host: info.host,
            path: info.path,
            requestBodyBytes: info.requestBodyBytes,
            status,
            durationMs,
            requestId: info.requestId,
            sessionAffinity: info.sessionAffinity,
            retryAfter: response.headers.get('retry-after') ?? undefined,
            responseHeaders: redactedResponseHeaders(response),
            bodyBytes,
            body,
            bodyTruncated: bodyBytes !== undefined && bodyBytes > BODY_SNIPPET_CHARS ? true : undefined,
          },
          'error',
        );
        if (info.sessionAffinity) {
          publishProviderIncident(classifyProviderHttpIncident({
            sessionId: info.sessionAffinity,
            requestId: info.requestId,
            providerHost: info.host,
            status,
            headers: response.headers,
            body,
          }));
        }
      } else if (VERBOSE) {
        emit(
          'response',
          {
            method: info.method,
            host: info.host,
            path: info.path,
            requestBodyBytes: info.requestBodyBytes,
            status,
            durationMs,
            requestId: info.requestId,
            sessionAffinity: info.sessionAffinity,
          },
          'info',
        );
      }
    } catch {
      /* logging must never affect the response */
    }
    return response;
  };

  globalThis.fetch = wrapped;
  try {
    emit('observer.installed', { mode: 'fetch-wrap', verbose: VERBOSE });
  } catch {
    /* ignore */
  }
}
