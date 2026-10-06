import { realpathSync } from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

/**
 * OS-owned single-host authority for each pie runtime profile.
 *
 * Exactly one production pie host (the VS Code extension or standalone Node
 * entry) may run on the production coordinator. A development profile uses
 * its launcher-provided identity and distinct endpoint, so it may coexist
 * with production but remains exclusive within that profile. Ownership is an
 * exclusive loopback TCP listener bound with ordinary OS semantics: the
 * kernel grants the bind to exactly one racer, and the OS releases it when
 * the owning process dies — there is no PID file to go stale and no process
 * is ever killed by PID.
 *
 * Contract:
 * - A composition root acquires ownership BEFORE starting the runtime/backend
 *   and holds it until shutdown has actually finished (including the backend
 *   drain). `release()` resolves only after the listener is closed.
 * - `probe` identifies the active host (`kind` + `pid` + profile). A second
 *   standalone host is refused outright; a second VS Code window is refused
 *   with a visible notification; production VS Code may request a graceful
 *   handoff from a production standalone host, visibly waits a bounded time,
 *   and only treats the port as free once a fresh bind succeeds. Cross-profile
 *   requests never hand off. An incomplete handoff fails closed.
 * - The listener answers a `shutdown` request from a VS Code host with
 *   `accepted` only from a standalone host (which then performs its own
 *   graceful shutdown and releases the port). The requester waits for that
 *   connection to close as the release signal; a VS Code host answers
 *   `rejected`, and any unknown responder fails the probe closed.
 *
 * Scope: supported desktop environment. The default production loopback port
 * is machine-global (all OS user sessions); development endpoints are
 * launcher-owned and explicitly separate. Loopback is not reachable over LAN.
 * The `shutdown` request is unauthenticated local
 * IPC: any local process could ask a standalone host to stop — accepted
 * within the single-user desktop scope documented in the architecture docs.
 */

export type PieHostKind = 'vscode' | 'standalone';

/** Fixed loopback coordinator port (the browser server's default is 1997). */
export const PIE_HOST_COORDINATOR_PORT = 1996;
export const PIE_HOST_COORDINATOR_PORT_ENV = 'PIE_HOST_COORDINATOR_PORT';
export const PIE_HOST_HANDOFF_TIMEOUT_MS_ENV = 'PIE_HOST_HANDOFF_TIMEOUT_MS';
export const PIE_HOST_PROFILE_ENV = 'PIE_HOST_PROFILE';
export const PIE_DEVELOPMENT_PROFILE_DIR_ENV = 'PIE_DEVELOPMENT_PROFILE_DIR';
export const PIE_DEVELOPMENT_PI_WORKSPACE_ENV = 'PIE_DEVELOPMENT_PI_WORKSPACE';
export const PIE_DEVELOPMENT_PI_RUNTIME_ENV = 'PIE_DEVELOPMENT_PI_RUNTIME';
export const PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK_ENV = 'PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK';
export const PRODUCTION_PIE_HOST_PROFILE = 'production';
export const PIE_HOST_COORDINATOR_PROTOCOL = 1;

const DEFAULT_HANDOFF_TIMEOUT_MS = 30_000;
const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
const RELEASE_GRACE_MS = 500;
const MAX_PROBE_MISSES = 5;

export interface PieHostActiveInfo {
  kind: PieHostKind;
  pid: number;
  startedAtMs: number;
  /** Explicit host profile; absent on older peers and interpreted as production. */
  profile?: string;
}

export interface PieHostRuntimeProfile {
  name: string;
  development: boolean;
  coordinatorPort: number;
}

export interface PieDevelopmentProfilePaths {
  profileDir: string;
  agentDir: string;
  authDir: string;
  authFile: string;
  dataDir: string;
  sessionDir: string;
  sessionSettingsDir: string;
}

/** Ownership handle held by the active host from acquisition to completed
 *  shutdown. `release()` closes the listener and ends tracked connections;
 *  `abort()` is the immediate crash-path teardown with no graceful wait. */
export interface PieHostOwnership {
  readonly kind: PieHostKind;
  readonly port: number;
  release(): Promise<void>;
  abort(): void;
}

export type PieHostRefusal =
  | { status: 'refused-host-active'; active: PieHostActiveInfo }
  | { status: 'refused-profile-mismatch'; active: PieHostActiveInfo; requestedProfile: string }
  | { status: 'refused-handoff-timeout'; active: PieHostActiveInfo }
  | { status: 'refused-port-unavailable'; error: string };

export type PieHostAcquisition =
  | { status: 'acquired'; ownership: PieHostOwnership }
  | PieHostRefusal;

export interface AcquirePieHostOwnershipOptions {
  kind: PieHostKind;
  /** Profile boundary advertised to other hosts; defaults from the launcher environment. */
  profile?: string;
  /** Coordinator port override (tests); defaults to the env override or the
   *  fixed {@link PIE_HOST_COORDINATOR_PORT}. */
  port?: number;
  /** Total bounded wait for a standalone host's graceful release when VS Code
   *  performs a handoff. `0` disables handoff (quick refusal). */
  handoffTimeoutMs?: number;
  probeTimeoutMs?: number;
  /** Standalone only: invoked once when a host requests graceful shutdown. */
  onHandoffRequested?: () => void;
  /** VS Code only: the bounded handoff wait is beginning for this host. */
  onHandoffStart?: (active: PieHostActiveInfo) => void;
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < 65536;
}

/** Resolve the coordinator port: explicit argument, then the env override,
 *  then the fixed default. Invalid values fall back to the fixed default. */
export function resolvePieHostCoordinatorPort(explicit?: number): number {
  if (explicit !== undefined && isValidPort(explicit)) return explicit;
  const env = process.env[PIE_HOST_COORDINATOR_PORT_ENV]?.trim();
  if (env) {
    const parsed = Number(env);
    if (isValidPort(parsed)) return parsed;
  }
  return PIE_HOST_COORDINATOR_PORT;
}

/** Resolve an isolated development profile's state roots. Every mutable PI/Pie
 * path is either derived from the explicit root or validated beneath it; an
 * existing symlink/junction may not redirect the path outside the profile. */
export function resolvePieDevelopmentProfilePaths(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: { agentDir?: string; dataDir?: string } = {},
): PieDevelopmentProfilePaths | undefined {
  const rawRoot = environment[PIE_DEVELOPMENT_PROFILE_DIR_ENV];
  const root = rawRoot?.trim();
  const workspaceRoot = environment[PIE_DEVELOPMENT_PI_WORKSPACE_ENV]?.trim();
  const developmentRuntime = environment[PIE_DEVELOPMENT_PI_RUNTIME_ENV]?.trim();
  const profile = environment[PIE_HOST_PROFILE_ENV]?.trim();
  const requested = rawRoot !== undefined
    || Boolean(workspaceRoot)
    || Boolean(developmentRuntime)
    || Boolean(profile && profile !== PRODUCTION_PIE_HOST_PROFILE);
  if (!requested) return undefined;
  if (!root) {
    throw new Error(`${PIE_DEVELOPMENT_PROFILE_DIR_ENV} is required for a development profile; production state is never used as a fallback.`);
  }
  if (!path.isAbsolute(root)) {
    throw new Error(`${PIE_DEVELOPMENT_PROFILE_DIR_ENV} must be an absolute development profile root.`);
  }
  if (workspaceRoot && developmentRuntime) {
    throw new Error(`${PIE_DEVELOPMENT_PI_WORKSPACE_ENV} and ${PIE_DEVELOPMENT_PI_RUNTIME_ENV} cannot be selected together.`);
  }
  if (profile === PRODUCTION_PIE_HOST_PROFILE) {
    throw new Error(`${PIE_HOST_PROFILE_ENV} cannot be production when ${PIE_DEVELOPMENT_PROFILE_DIR_ENV} selects development state.`);
  }

  const profileDir = path.resolve(root);
  const configuredPath = (envName: string, override: string | undefined, fallback: string): string => {
    const fromEnvironment = environment[envName];
    if (fromEnvironment !== undefined && !fromEnvironment.trim()) {
      throw new Error(`${envName} must not be empty for a development profile.`);
    }
    if (fromEnvironment !== undefined && override !== undefined
        && path.resolve(fromEnvironment.trim()) !== path.resolve(override)) {
      throw new Error(`${envName} and the explicit startup path must identify the same development-profile location.`);
    }
    const value = fromEnvironment ?? override ?? fallback;
    if (!path.isAbsolute(value.trim())) {
      throw new Error(`${envName} must be an absolute path inside ${PIE_DEVELOPMENT_PROFILE_DIR_ENV}.`);
    }
    return path.resolve(value.trim());
  };
  const agentDir = configuredPath('PI_CODING_AGENT_DIR', overrides.agentDir, path.join(profileDir, 'agent'));
  const authDir = configuredPath('PI_CODING_AGENT_AUTH_DIR', undefined, path.join(profileDir, 'auth'));
  const dataDir = configuredPath('PIE_DATA_DIR', overrides.dataDir, path.join(profileDir, 'data'));
  const sessionDir = configuredPath(
    'PI_CODING_AGENT_SESSION_DIR',
    undefined,
    path.join(dataDir, 'sessions'),
  );
  const authFile = path.join(authDir, 'auth.json');
  const sessionSettingsDir = path.join(dataDir, 'state', 'session-settings');
  const rootCanonical = canonicalPath(profileDir);
  const protectedPaths = [
    ['agent directory', agentDir],
    ['agent settings', path.join(agentDir, 'settings.json')],
    ['agent models', path.join(agentDir, 'models.json')],
    ['agent auth', path.join(agentDir, 'auth.json')],
    ['auth directory', authDir],
    ['auth file', authFile],
    ['data directory', dataDir],
    ...['analytics', 'sessions', 'artifacts', 'state', 'cache'].map((name) => [
      `${name} data directory`, path.join(dataDir, name),
    ] as const),
    ['session directory', sessionDir],
    ['session settings directory', sessionSettingsDir],
    ['session reviews directory', path.join(path.dirname(sessionDir), 'session-reviews')],
    ['deferred triggers directory', path.join(path.dirname(sessionDir), 'deferred-triggers')],
  ] as const;
  for (const [label, candidate] of protectedPaths) {
    if (!isWithinPath(rootCanonical, canonicalPath(candidate))) {
      throw new Error(`Development ${label} must resolve within ${PIE_DEVELOPMENT_PROFILE_DIR_ENV} (${profileDir}): ${candidate}`);
    }
  }

  return { profileDir, agentDir, authDir, authFile, dataDir, sessionDir, sessionSettingsDir };
}

function canonicalPath(value: string): string {
  const pending: string[] = [];
  let current = path.resolve(value);
  for (;;) {
    try {
      return path.resolve(realpathSync.native(current), ...pending);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      pending.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isWithinPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return normalized === '' || (normalized !== '..'
    && !normalized.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

/** Resolve the launcher-owned runtime profile. Development mode requires an
 * explicit isolated state root, a non-production identity, and a distinct
 * coordinator endpoint; it never derives a development port from production. */
export function resolvePieHostRuntimeProfile(
  environment: NodeJS.ProcessEnv = process.env,
  explicitPort?: number,
): PieHostRuntimeProfile {
  const developmentPaths = resolvePieDevelopmentProfilePaths(environment);
  if (!developmentPaths) {
    return {
      name: PRODUCTION_PIE_HOST_PROFILE,
      development: false,
      coordinatorPort: resolvePieHostCoordinatorPort(explicitPort),
    };
  }
  const workspaceRoot = environment[PIE_DEVELOPMENT_PI_WORKSPACE_ENV]?.trim();
  if (workspaceRoot && !path.isAbsolute(workspaceRoot)) {
    throw new Error(`${PIE_DEVELOPMENT_PI_WORKSPACE_ENV} must be an absolute Pi workspace root.`);
  }
  if (workspaceRoot && environment[PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK_ENV] !== '1') {
    throw new Error(`${PIE_DEVELOPMENT_PI_WORKSPACE_ENV} requires ${PIE_ALLOW_WORKSPACE_DEVELOPMENT_SDK_ENV}=1.`);
  }
  const name = environment[PIE_HOST_PROFILE_ENV]?.trim();
  if (!name || name === PRODUCTION_PIE_HOST_PROFILE || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name)) {
    throw new Error(`${PIE_HOST_PROFILE_ENV} must be an explicit non-production profile id when ${PIE_DEVELOPMENT_PROFILE_DIR_ENV} is set.`);
  }
  const portValue = environment[PIE_HOST_COORDINATOR_PORT_ENV]?.trim();
  const configuredPort = portValue ? Number(portValue) : undefined;
  if (!portValue || !isValidPort(configuredPort!) || configuredPort === PIE_HOST_COORDINATOR_PORT) {
    throw new Error(
      `${PIE_DEVELOPMENT_PROFILE_DIR_ENV} requires an explicit ${PIE_HOST_COORDINATOR_PORT_ENV} different from production port ${PIE_HOST_COORDINATOR_PORT}.`,
    );
  }
  if (explicitPort !== undefined && explicitPort !== configuredPort) {
    throw new Error(`The development coordinator port override must match ${PIE_HOST_COORDINATOR_PORT_ENV}.`);
  }
  return { name, development: true, coordinatorPort: configuredPort! };
}

export function resolvePieHostHandoffTimeoutMs(explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const env = process.env[PIE_HOST_HANDOFF_TIMEOUT_MS_ENV]?.trim();
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_HANDOFF_TIMEOUT_MS;
}

export function describePieHost(info: PieHostActiveInfo): string {
  const host = info.kind === 'vscode'
    ? `VS Code pie host (pid ${info.pid})`
    : `standalone pie host (pid ${info.pid})`;
  return info.profile && info.profile !== PRODUCTION_PIE_HOST_PROFILE
    ? `${host}, profile ${info.profile}`
    : host;
}

/** One human-readable sentence per refusal shape, used by both adapters. */
export function describePieHostRefusal(
  refusal: PieHostRefusal,
  port = resolvePieHostCoordinatorPort(),
): string {
  switch (refusal.status) {
    case 'refused-host-active':
      return `another pie host is already active on this machine: ${describePieHost(refusal.active)} (coordinator port ${port}). Stop that host first; pie started nothing here.`;
    case 'refused-profile-mismatch':
      return `coordinator port ${port} belongs to a different pie profile (${describePieHost(refusal.active)}); requested profile ${refusal.requestedProfile} will not hand off to or replace it. Pie started nothing here and terminated no process.`;
    case 'refused-handoff-timeout':
      return `the standalone pie host (${describePieHost(refusal.active)}) did not release coordinator port ${port} within the bounded handoff window after a stop request. Pie started nothing here and terminated no process.`;
    case 'refused-port-unavailable':
      return `the pie host coordinator port ${port} is occupied by a process that did not answer the pie probe (${refusal.error}). Close that process or set ${PIE_HOST_COORDINATOR_PORT_ENV} to a free port; pie started nothing here.`;
  }
}

// ─── Wire protocol (newline-delimited JSON over 127.0.0.1) ──────────────────

interface HostInfoMessage {
  type: 'info';
  protocol: number;
  kind: PieHostKind;
  pid: number;
  startedAtMs: number;
  profile?: string;
}
interface AcceptedMessage { type: 'accepted' }
interface RejectedMessage { type: 'rejected' }

type CoordinatorMessage = HostInfoMessage | AcceptedMessage | RejectedMessage;
type CoordinatorRequest = { type: 'probe' } | { type: 'shutdown' };

function writeMessage(socket: net.Socket, message: CoordinatorMessage | CoordinatorRequest): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function parseCoordinatorMessage(line: string): CoordinatorMessage | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (record.type === 'accepted') return { type: 'accepted' };
    if (record.type === 'rejected') return { type: 'rejected' };
    if (record.type === 'info'
      && record.protocol === PIE_HOST_COORDINATOR_PROTOCOL
      && (record.kind === 'vscode' || record.kind === 'standalone')
      && Number.isInteger(record.pid) && (record.pid as number) > 0
      && Number.isFinite(record.startedAtMs) && (record.startedAtMs as number) >= 0
      && (record.profile === undefined || (typeof record.profile === 'string' && record.profile.length > 0 && record.profile.length <= 128))) {
      return {
        type: 'info',
        protocol: PIE_HOST_COORDINATOR_PROTOCOL,
        kind: record.kind as PieHostKind,
        pid: record.pid as number,
        startedAtMs: record.startedAtMs as number,
        profile: typeof record.profile === 'string' ? record.profile : PRODUCTION_PIE_HOST_PROFILE,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseCoordinatorRequest(line: string): CoordinatorRequest | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') return undefined;
    const type = (value as Record<string, unknown>).type;
    if (type === 'probe') return { type: 'probe' };
    if (type === 'shutdown') return { type: 'shutdown' };
    return undefined;
  } catch {
    return undefined;
  }
}

// ─── Listener (the OS-owned lock itself) ────────────────────────────────────

interface BoundServer {
  kind: PieHostKind;
  server: net.Server;
  sockets: Set<net.Socket>;
  releaseRequested: boolean;
}

function tryBind(
  port: number,
  info: PieHostActiveInfo,
  options: AcquirePieHostOwnershipOptions,
): Promise<{ ok: true; bound: BoundServer } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const sockets = new Set<net.Socket>();
    const bound: BoundServer = {
      kind: info.kind,
      server: undefined as unknown as net.Server,
      sockets,
      releaseRequested: false,
    };
    let settled = false;
    const server = net.createServer((socket) => {
      sockets.add(socket);
      let buffer = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handleRequest(line);
        }
      });
      socket.on('close', () => { sockets.delete(socket); });
      socket.on('error', () => { sockets.delete(socket); });
      function handleRequest(line: string): void {
        const request = parseCoordinatorRequest(line);
        if (!request) {
          writeMessage(socket, { type: 'rejected' });
          return;
        }
        if (request.type === 'probe') {
          writeMessage(socket, {
            type: 'info',
            protocol: PIE_HOST_COORDINATOR_PROTOCOL,
            ...info,
          });
          return;
        }
        // Only a standalone host may accept a graceful shutdown request, and
        // only once. The accepting socket stays open until the owner releases
        // ownership; its close is the requester's release evidence.
        if (info.kind === 'standalone' && options.onHandoffRequested && !bound.releaseRequested) {
          bound.releaseRequested = true;
          writeMessage(socket, { type: 'accepted' });
          setImmediate(() => {
            try {
              options.onHandoffRequested!();
            } catch {
              // The requester treats a missing release as failed handoff.
            }
          });
          return;
        }
        writeMessage(socket, { type: 'rejected' });
      }
    });
    server.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: error.message });
    });
    server.listen(port, '127.0.0.1', () => {
      if (settled) return;
      settled = true;
      // After ownership is granted, later socket errors are ordinary
      // per-connection noise and must not crash the host.
      server.on('error', () => undefined);
      bound.server = server;
      resolve({ ok: true, bound });
    });
  });
}

function closeBoundServer(bound: BoundServer): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      for (const socket of [...bound.sockets]) socket.destroy();
      finish();
    }, RELEASE_GRACE_MS);
    bound.server.close(() => {
      clearTimeout(timer);
      finish();
    });
    for (const socket of [...bound.sockets]) socket.end();
  });
}

// ─── Client requests (probe / shutdown request) ─────────────────────────────

interface RequestOutcome {
  message: CoordinatorMessage | undefined;
  closed: boolean;
}

function requestOnce(
  port: number,
  request: CoordinatorRequest,
  timeoutMs: number,
  awaitClose = false,
): Promise<RequestOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let lastMessage: CoordinatorMessage | undefined;
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = '';
    socket.setEncoding('utf8');
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ message: lastMessage, closed });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on('connect', () => writeMessage(socket, request));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        const message = line ? parseCoordinatorMessage(line) : undefined;
        if (!message) continue;
        lastMessage = message;
        if (!(awaitClose && message.type === 'accepted')) finish(true);
      }
    });
    socket.on('error', () => finish(false));
    socket.on('close', () => finish(true));
  });
}

/** Identify the host that currently owns the coordinator port, if it is a
 *  pie host. Any non-answer (foreign process, crash, timeout) is `undefined`
 *  and fails the caller closed. */
export async function probePieHost(
  port?: number,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<PieHostActiveInfo | undefined> {
  const outcome = await requestOnce(resolvePieHostCoordinatorPort(port), { type: 'probe' }, probeTimeoutMs);
  if (!outcome.message || outcome.message.type !== 'info') return undefined;
  return {
    kind: outcome.message.kind,
    pid: outcome.message.pid,
    startedAtMs: outcome.message.startedAtMs,
    profile: outcome.message.profile ?? PRODUCTION_PIE_HOST_PROFILE,
  };
}

/** Ask the current host to release ownership. Returns true only when the
 *  host accepted a graceful shutdown request AND its listener closed (the
 *  actual release evidence). Never kills anything. */
export async function requestPieHostRelease(
  port: number,
  timeoutMs: number,
): Promise<boolean> {
  const outcome = await requestOnce(port, { type: 'shutdown' }, timeoutMs, true);
  return outcome.message?.type === 'accepted' && outcome.closed;
}

function createOwnership(bound: BoundServer, port: number): PieHostOwnership {
  let released = false;
  return {
    kind: bound.kind,
    port,
    release: async () => {
      if (released) return;
      released = true;
      await closeBoundServer(bound);
    },
    abort: () => {
      if (released) return;
      released = true;
      try {
        bound.server.close();
      } catch {
        // The port is freed by the OS regardless.
      }
      for (const socket of [...bound.sockets]) socket.destroy();
    },
  };
}

/**
 * Acquire the machine-wide pie host ownership for `options.kind`.
 *
 * - Standalone: one bounded attempt. Any active host in this profile is a
 *   hard refusal; another profile is refused as a mismatch. A foreign process
 *   on the endpoint fails closed.
 * - VS Code: with `handoffTimeoutMs > 0`, an active same-profile standalone
 *   host is asked (once per holder) to stop gracefully; the wait is bounded
 *   and ownership is taken only after a fresh successful bind. Cross-profile
 *   requests never hand off.
 */
export async function acquirePieHostOwnership(
  options: AcquirePieHostOwnershipOptions,
): Promise<PieHostAcquisition> {
  const runtimeProfile = options.profile === undefined && options.port === undefined
    ? resolvePieHostRuntimeProfile()
    : undefined;
  const profile = options.profile ?? runtimeProfile?.name ?? PRODUCTION_PIE_HOST_PROFILE;
  const port = options.port ?? runtimeProfile?.coordinatorPort ?? resolvePieHostCoordinatorPort();
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const handoffTimeoutMs = options.handoffTimeoutMs ?? resolvePieHostHandoffTimeoutMs();
  const info: PieHostActiveInfo = { kind: options.kind, pid: process.pid, startedAtMs: Date.now(), profile };
  const deadline = handoffTimeoutMs > 0 ? Date.now() + handoffTimeoutMs : 0;
  let probeMisses = 0;
  for (;;) {
    const bind = await tryBind(port, info, options);
    if (bind.ok) {
      return { status: 'acquired', ownership: createOwnership(bind.bound, port) };
    }
    const active = await probePieHost(port, probeTimeoutMs);
    if (!active) {
      // The previous holder may be mid-release (bind raced its close) or may
      // have crashed. A fresh bind attempt is the only release evidence.
      probeMisses += 1;
      if (probeMisses > MAX_PROBE_MISSES) {
        return { status: 'refused-port-unavailable', error: bind.error };
      }
      continue;
    }
    probeMisses = 0;
    if ((active.profile ?? PRODUCTION_PIE_HOST_PROFILE) !== profile) {
      return { status: 'refused-profile-mismatch', active, requestedProfile: profile };
    }
    if (options.kind === 'standalone' || active.kind === 'vscode' || deadline === 0) {
      return { status: 'refused-host-active', active };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return { status: 'refused-handoff-timeout', active };
    }
    options.onHandoffStart?.(active);
    await requestPieHostRelease(port, remainingMs);
  }
}