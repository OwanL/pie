/**
 * Shared local-file-open service (host-side).
 *
 * Prepares one ephemeral loopback HTTP listener per requested file. The
 * listener serves that entry file at `/` plus any file inside the canonical
 * parent directory (so sibling scripts and relative assets load), and is
 * otherwise fully isolated from Pie's shared browser server: separate port,
 * separate origin, no webview assets, no state routes.
 *
 * Security invariants:
 *  - binds `127.0.0.1` only, OS-assigned port; one distinct origin per host
 *    listener, never Pie's webview origin;
 *  - exact verified Host header (`127.0.0.1:<port>`); anything else fails
 *    closed (DNS rebinding defense);
 *  - GET/HEAD only, bodies rejected;
 *  - every request path is canonically resolved and must stay inside the
 *    canonical parent directory (`fs.realpath` containment, so symlinks and
 *    `..` cannot escape);
 *  - the listener self-verifies a successful entry response before `open`
 *    resolves, so a reported URL is always a browser-client-reachable Origin;
 *  - idle expiry plus explicit `dispose()` bound listener lifetime, and a
 *    bounded concurrent-listener cap fails closed.
 */

import * as http from 'node:http';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createReadStream, type Stats } from 'node:fs';
import * as path from 'node:path';

import {
  resolveFilePathWithFallback,
  type FilePathResolverAdapter,
  type OpenFileRequest,
} from './image-preview.js';
import type { LocalFileOpenCommand } from '../../lib/platform-contracts/local-file-open.js';

export type {
  LocalFileOpenCommand,
  LocalFileOpenRequest,
  LocalFileOpenSurface,
} from '../../lib/platform-contracts/local-file-open.js';

export const LOCAL_FILE_OPEN_POLICY = {
  /** Idle listeners close themselves; every accepted request resets the timer. */
  idleMs: 2 * 60 * 1000,
  /** Bounded concurrent listeners; further opens fail closed. */
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
  /** Verified loopback origin serving the entry file at `/`. */
  url: string;
  /** Close this listener and its idle timer immediately. Idempotent. */
  dispose(): Promise<void>;
}

export interface LocalFileOpenService {
  /** Prepare + verify one listener for the requested file. Throws when the
   *  file is unavailable/ambiguous or no listener can be minted. */
  open(request: LocalFileOpenCommand, resolver: FilePathResolverAdapter): Promise<LocalFileServeSession>;
  /** Close every live listener and cancel its idle timers. Idempotent. */
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

/** One live listener's shared mutable state (the handler must read the port,
 *  which only becomes known after `listen`). */
interface ListenerState {
  server: http.Server;
  /** Canonical parent directory served as root (`/` = entry). */
  root: string;
  /** Canonical entry file served at `/`. */
  entry: string;
  port: number;
  idleTimer?: unknown;
}

/** Canonical containment: `candidate` must resolve inside `directory`. */
function isCanonicalInside(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === ''
    || (relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative));
}

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && remoteAddress.replace(/^::ffff:/u, '') === '127.0.0.1';
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

/** One request cycle: fail-closed Host/loopback gate, contained path
 *  resolution, streamed file body, and an idle-timer reset per accepted
 *  request. */
function createRequestHandler(listener: ListenerState, armIdle: (listener: ListenerState) => void): http.RequestListener {
  return (req, res) => {
    void (async () => {
      try {
        if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) return respondError(res, 403);
        if (req.headers.host !== `127.0.0.1:${listener.port}`) return respondError(res, 403);

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
        const pathname = safeRequestPathname(req.url);
        if (pathname === null) return respondError(res, 400);

        // Canonical parent containment: decode, join, realpath, fence.
        let candidate: string | null = null;
        try {
          const decoded = pathname.replace(/\/+$/u, '');
          const joined = decoded === '' ? listener.entry : path.join(listener.root, decoded);
          candidate = await fs.realpath(joined);
        } catch {
          candidate = null;
        }
        if (candidate === null) return respondError(res, 404);
        if (!isCanonicalInside(listener.root, candidate)) return respondError(res, 403);

        let stat: Stats | null = null;
        try { stat = await fs.stat(candidate); } catch { stat = null; }
        if (!stat?.isFile()) return respondError(res, 404);

        armIdle(listener);
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
  /** Live listeners keyed by their exactly-one distinct origin URL. */
  const live: Record<string, ListenerState> = {};

  const closeListener = (listener: ListenerState): void => {
    if (listener.idleTimer !== undefined) {
      clock.clearTimeout(listener.idleTimer);
      listener.idleTimer = undefined;
    }
    if (live[`http://127.0.0.1:${listener.port}/`] === listener) {
      delete live[`http://127.0.0.1:${listener.port}/`];
    }
    listener.server.close();
    listener.server.closeAllConnections();
  };

  const armIdleTimer = (listener: ListenerState): void => {
    if (listener.idleTimer !== undefined) clock.clearTimeout(listener.idleTimer);
    listener.idleTimer = clock.setTimeout(() => {
      listener.idleTimer = undefined;
      closeListener(listener);
    }, LOCAL_FILE_OPEN_POLICY.idleMs);
  };

  /** Resolve exactly as an open-file request does, then require a real file. */
  async function resolveEntry(request: OpenFileRequest, resolver: FilePathResolverAdapter): Promise<string> {
    const resolution = await resolveFilePathWithFallback(request, resolver);
    const name = request.reference?.trim() || request.path;
    if (resolution.status === 'ambiguous') {
      throw new Error(`The file reference "${name}" is ambiguous; it cannot be prepared for open.`);
    }
    if (resolution.status !== 'found') throw new Error(`Could not find file "${name}".`);
    const stat = await fs.stat(resolution.path);
    if (!stat.isFile()) throw new Error('The requested path is not a file.');
    return resolution.path;
  }

  return {
    async open(request: LocalFileOpenCommand, resolver: FilePathResolverAdapter): Promise<LocalFileServeSession> {
      if (Object.keys(live).length >= LOCAL_FILE_OPEN_POLICY.maxConcurrent) {
        throw new Error('Too many prepared files are still open; retry shortly.');
      }
      const entryPath = await resolveEntry(request, resolver);
      const canonicalRoot = await fs.realpath(path.dirname(path.resolve(entryPath)));
      const canonicalEntry = await fs.realpath(path.join(canonicalRoot, path.basename(path.resolve(entryPath))));
      if (!isCanonicalInside(canonicalRoot, canonicalEntry)) {
        throw new Error('The requested file is outside its canonical parent directory.');
      }

      const listener: ListenerState = {
        server: null as unknown as http.Server,
        root: canonicalRoot,
        entry: canonicalEntry,
        port: 0,
      };
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        const server = http.createServer(createRequestHandler(listener, armIdleTimer));
        listener.server = server;
        const onError = (error: Error): void => { server.off('listening', onListening); rejectPort(error); };
        const onListening = (): void => {
          server.off('error', onError);
          const address = server.address();
          resolvePort(typeof address === 'object' && address !== null ? address.port : 0);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
      listener.port = port;

      const url = `http://127.0.0.1:${port}/`;
      live[url] = listener;
      try {
        // Only a self-verified URL is ever reported back.
        await selfCheck(url);
      } catch (error) {
        closeListener(listener);
        throw error;
      }
      armIdleTimer(listener);
      return {
        url,
        dispose: async () => { closeListener(listener); },
      };
    },

    async dispose(): Promise<void> {
      for (const listener of Object.values(live)) closeListener(listener);
    },
  };
}