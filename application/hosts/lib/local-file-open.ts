/** Capability-scoped report folders on one host-owned HTTP listener.
 * Separate from Pie HTTP/WS. Trusted browser socket policy selects the
 * advertised hostname and loopback/LAN binding; capabilities expire after
 * inactivity. Canonical containment fences scripts and relative assets.
 */

import * as http from 'node:http';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isAllowedBrowserRemoteAddress } from '../browser/network-access/policy.js';

import {
  resolveFilePathWithFallback,
  type FilePathResolverAdapter,
} from './image-preview.js';
import type { LocalFileOpenCommand } from '../../lib/platform-contracts/local-file-open.js';

export type {
  LocalFileOpenCommand,
  LocalFileOpenRequest,
  LocalFileOpenSurface,
} from '../../lib/platform-contracts/local-file-open.js';

export const LOCAL_FILE_OPEN_POLICY = {
  /** Capabilities expire after inactivity; accepted file requests refresh them. */
  idleMs: 2 * 60 * 1000,
  /** Bounded concurrent folder capabilities; further opens fail closed. */
  maxConcurrent: 8,
  /** Self-verification timeout before a URL counts as reachable. */
  selfCheckTimeoutMs: 3_000,
} as const;

/** Clock seam for deterministic lifecycle tests. */
export interface LocalFileOpenClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Self-verification seam: resolves only for a confirmed reachable entry URL. */
export type LocalFileOpenSelfCheck = (url: string) => Promise<void>;

export interface LocalFileOpenServiceOptions {
  clock?: LocalFileOpenClock;
  selfCheck?: LocalFileOpenSelfCheck;
}

export interface LocalFileServeSession {
  /** Verified report URL: capability prefix serves the entry and its siblings. */
  url: string;
  /** Revoke this capability and its idle timer immediately. Idempotent. */
  dispose(): Promise<void>;
}

export interface LocalFileOpenService {
  /** Prepare and verify a folder capability on the host's report listener. */
  open(request: LocalFileOpenCommand, resolver: FilePathResolverAdapter): Promise<LocalFileServeSession>;
  /** Close the host listener and revoke every capability. Idempotent. */
  dispose(): Promise<void>;
}

/** MIME guesses; `nosniff` makes the content-type authoritative. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
};

export function localFileMimeForExtension(extension: string): string {
  return MIME_BY_EXTENSION[extension.toLowerCase()] ?? 'application/octet-stream';
}

const DEFAULT_CLOCK: LocalFileOpenClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_SELF_CHECK: LocalFileOpenSelfCheck = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(LOCAL_FILE_OPEN_POLICY.selfCheckTimeoutMs) });
  if (!response.ok) throw new Error(`Local file origin self-check failed with status ${response.status}.`);
};

/** Open a URL in the OS default handler (shell out, never the app's own
 *  listener surface). Used by adapters that own a desktop opening surface. */
export async function openNativeUrl(url: string): Promise<void> {
  if (process.platform === 'win32') return run('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  if (process.platform === 'darwin') return run('open', [url]);
  return run('xdg-open', [url]);
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

/** A local IPv6 loopback Host (`[::1]`) can never reach the IPv4-only report
 *  binding, so the prepared origin normalizes it to `127.0.0.1`. */
function normalizeReportHostname(hostname: string): string {
  return hostname === '[::1]' || hostname === '::1' ? '127.0.0.1' : hostname;
}

/** One live listener's shared mutable state (the handler must read the port,
 *  which only becomes known after `listen`). */
interface ListenerState {
  server: http.Server;
  /** Random capability paths, each scoped to one canonical parent folder. */
  grants: Record<string, { root: string; entry: string; hostname: string; allowLan: boolean; idleTimer?: unknown }>;
  allowLan: boolean;
  port: number;
}

/** Canonical containment: `candidate` must resolve inside `directory`. */
function isCanonicalInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function safeRequestPathname(rawUrl: string | undefined): string | null {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return null;
  try {
    return new URL(rawUrl, 'http://127.0.0.1').pathname;
  } catch {
    return null;
  }
}

function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function respondError(res: http.ServerResponse, status: number, extra: Record<string, string> = {}): void {
  res.writeHead(status, securityHeaders(extra));
  res.end();
}

/** One request cycle: fail-closed Host/network gate, contained path
 *  resolution, streamed file body, and an idle-timer reset per accepted
 *  request. */
function createRequestHandler(listener: ListenerState, armIdle: (token: string) => void): http.RequestListener {
  return (req, res) => {
    void (async () => {
      try {
        if (!Object.values(listener.grants).some((grant) => req.headers.host === `${grant.hostname}:${listener.port}`)) return respondError(res, 403);
        const pathname = safeRequestPathname(req.url);
        if (pathname === null) return respondError(res, 400);
        const match = /^\/([a-f0-9]{48})\/(.*)$/u.exec(pathname);
        const token = match?.[1];
        const grant = token ? listener.grants[token] : undefined;
        if (!grant || !match) return respondError(res, 404);
        if (!isAllowedBrowserRemoteAddress(req.socket.remoteAddress, grant.allowLan)) return respondError(res, 403);
        if (req.headers.host !== `${grant.hostname}:${listener.port}`) return respondError(res, 403);

        const method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
          res.writeHead(405, securityHeaders({ Allow: 'GET, HEAD' }));
          res.end();
          return;
        }
        const hasBody = (req.headers['content-length'] !== undefined && Number(req.headers['content-length']) > 0)
          || req.headers['transfer-encoding'] !== undefined;
        if (hasBody) {
          res.writeHead(405, securityHeaders({ Allow: 'GET, HEAD' }));
          res.end();
          return;
        }
        // Capability-prefixed URL preserves relative assets inside this folder.
        // Canonical parent containment: decode, join, realpath, fence.
        let candidate: string | null = null;
        try {
          const decoded = decodeURIComponent(match[2]).replace(/\/+$/u, '');
          const joined = decoded === '' ? grant.entry : path.join(grant.root, decoded);
          candidate = await fs.realpath(joined);
        } catch {
          candidate = null;
        }
        if (candidate === null) return respondError(res, 404);
        if (!isCanonicalInside(grant.root, candidate)) return respondError(res, 403);

        let stat: Stats | null = null;
        try { stat = await fs.stat(candidate); } catch { stat = null; }
        if (!stat?.isFile()) return respondError(res, 404);

        armIdle(token!);
        res.writeHead(200, securityHeaders({
          'Content-Type': localFileMimeForExtension(path.extname(candidate)),
          'Content-Length': String(stat.size),
        }));
        if (method === 'HEAD') { res.end(); return; }
        const bodyStream = createReadStream(candidate);
        bodyStream.on('error', () => res.destroy());
        res.on('error', () => bodyStream.destroy());
        bodyStream.pipe(res);
      } catch {
        respondError(res, 500);
      }
    })();
  };
}

export function createLocalFileOpenService(options: LocalFileOpenServiceOptions = {}): LocalFileOpenService {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const selfCheck = options.selfCheck ?? DEFAULT_SELF_CHECK;
  let listener: ListenerState | undefined;
  // Serialize opens/disposal so simultaneous clicks share one listener.
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  /** Opens/disposals in flight; a listener is never closed underneath them. */
  let activeOpens = 0;
  const removeGrant = (state: ListenerState, token: string): void => {
    const grant = state.grants[token];
    if (grant?.idleTimer !== undefined) clock.clearTimeout(grant.idleTimer);
    delete state.grants[token];
  };
  const close = async (): Promise<void> => {
    const state = listener;
    listener = undefined;
    if (!state) return;
    for (const token of Object.keys(state.grants)) removeGrant(state, token);
    await new Promise<void>((resolve) => {
      state.server.close(() => resolve());
      state.server.closeAllConnections();
    });
  };
  /** Idle expiry keeps no grantless listener bound: the last revoked or
   *  expired capability also closes the accept loop. Skipped while an open
   *  is still preparing (it will mint its grant before returning). */
  const maybeClose = (state: ListenerState): void => {
    if (activeOpens > 0 || listener !== state || Object.keys(state.grants).length > 0) return;
    void close();
  };
  const arm = (state: ListenerState, token: string): void => {
    const grant = state.grants[token];
    if (!grant) return;
    if (grant.idleTimer !== undefined) clock.clearTimeout(grant.idleTimer);
    grant.idleTimer = clock.setTimeout(() => {
      removeGrant(state, token);
      maybeClose(state);
    }, LOCAL_FILE_OPEN_POLICY.idleMs);
  };
  return {
    open: (request, resolver) => serialize(async () => {
      activeOpens++;
      try {
        return await prepareGrant(request, resolver);
      } finally {
        activeOpens--;
        if (listener) maybeClose(listener);
      }
    }),
    dispose: () => serialize(close),
  };

  async function prepareGrant(
    request: LocalFileOpenCommand,
    resolver: FilePathResolverAdapter,
  ): Promise<LocalFileServeSession> {
      const resolution = await resolveFilePathWithFallback(request, resolver);
      const name = request.reference?.trim() || request.path;
      if (resolution.status === 'ambiguous') throw new Error(`The file reference "${name}" is ambiguous; it cannot be prepared for open.`);
      if (resolution.status !== 'found') throw new Error(`Could not find file "${name}".`);
      const entry = await fs.realpath(resolution.path);
      if (!(await fs.stat(entry)).isFile()) throw new Error('The requested path is not a file.');
      const root = await fs.realpath(path.dirname(path.resolve(resolution.path)));
      if (!isCanonicalInside(root, entry)) throw new Error('The requested file is outside its canonical parent directory.');
      const hostname = normalizeReportHostname(request.browserNetwork?.hostname ?? '127.0.0.1');
      const allowLan = request.browserNetwork?.allowLan === true;
      if (listener && request.browserNetwork && listener.allowLan !== allowLan) await close();
      if (!listener) {
        const state: ListenerState = { server: null as unknown as http.Server, grants: {}, allowLan, port: 0 };
        state.server = http.createServer(createRequestHandler(state, (token) => arm(state, token)));
        state.server.on('upgrade', (_req, socket) => socket.destroy());
        await new Promise<void>((resolve, reject) => {
          state.server.once('error', reject);
          state.server.listen(0, allowLan ? '0.0.0.0' : '127.0.0.1', () => {
            state.server.off('error', reject);
            const address = state.server.address();
            if (typeof address !== 'object' || !address) return reject(new Error('No report listener address.'));
            state.port = address.port;
            resolve();
          });
        });
        listener = state;
      }
      const state = listener;
      if (Object.keys(state.grants).length >= LOCAL_FILE_OPEN_POLICY.maxConcurrent) throw new Error('Too many prepared files are still open; retry shortly.');
      const token = randomBytes(24).toString('hex');
      state.grants[token] = { root, entry, hostname, allowLan };
      const url = 'http://' + hostname + ':' + state.port + '/' + token + '/';
      try { await selfCheck(url); }
      catch (error) { removeGrant(state, token); throw error; }
      arm(state, token);
      return {
        url,
        // Revoking the final capability also closes the (now grantless) accept
        // loop, skipped while another open is preparing on this listener.
        dispose: async () => { removeGrant(state, token); maybeClose(state); },
      };
  }
}
