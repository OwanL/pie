import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Writable } from 'node:stream';

import { BackendClient, STOP_KILL_TIMEOUT_MS } from '../host/backend/client';
import { BrowserServer } from '../host/browser-server/browser-server';
import {
  acquirePieHostOwnership,
  describePieHostRefusal,
  resolvePieHostCoordinatorPort,
  type PieHostAcquisition,
  type PieHostOwnership,
} from '../host/coordinator/host-coordinator';
import { appendPieLog } from '../host/util/pie-log';
import { toErrorMessage } from '../host/util/error-message';
import { HostRuntime } from '../host/runtime/host-runtime';
import { createStandaloneHostRuntimePlatform } from './platform';
import {
  resolveStandaloneEnvironment,
  validateStandaloneRuntimeIdentity,
  type ResolveStandaloneEnvironmentOptions,
  type StandaloneDependencyPaths,
  type StandaloneEnvironment,
  StandaloneStartupError,
} from './startup';
import type { BrowserServerSettings } from '../host/browser-server/types';
import type { HostRuntimePlatform } from '../host/runtime/platform';

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 12_000;

/**
 * Bounded wait for CONFIRMED backend process exit during teardown.
 * `BackendClient.stop()` closes stdin and escalates to SIGKILL/tree
 * termination after `STOP_KILL_TIMEOUT_MS`; the margin below budgets the kill
 * itself (tree termination can take additional time) before the exit is
 * declared unconfirmed and the caller must fail closed.
 */
const BACKEND_STOP_CONFIRM_TIMEOUT_MS = STOP_KILL_TIMEOUT_MS + 5_000;

/** After the backend exit is confirmed, give the remaining HostRuntime
 *  teardown a short bounded grace before the coordinator port is handed to a
 *  waiting host. This wait can no longer delay or skip the release on a hung
 *  producer: the backend invariant is already proven at this point. */
const OWNERSHIP_RELEASE_DRAIN_GRACE_MS = 250;

const DEFAULT_EXIT_CODES: Record<'SIGINT' | 'SIGTERM', number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

const STANDALONE_USAGE = 'Usage: standalone.js --cwd <absolute workspace path> [--lan | --no-lan]';

export const STANDALONE_HELP_TEXT = [
  STANDALONE_USAGE,
  '       standalone.js --help',
  '',
  'Without --lan or --no-lan, startup restores the saved LAN preference.',
  'Either explicit LAN flag overrides and saves that preference before the server starts.',
].join('\n');

export interface StandaloneArguments {
  cwd: string;
  /** Explicit startup override; omitted restores the saved host preference. */
  allowLan?: boolean;
}

export interface StandaloneProcessLike {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  removeListener?(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  exitCode?: number | string;
  exit?(code?: number): never | void;
}

export interface StandaloneStartOptions {
  cwd: string;
  extensionPath?: string;
  runtimeOutputDirectory?: string;
  dataRoot?: string;
  dependencies?: StandaloneDependencyPaths;
  environment?: StandaloneEnvironment;
  backend?: BackendClient;
  browserServerSettings?: Partial<BrowserServerSettings>;
  output?: { stdout?: Writable; stderr?: Writable };
  /** Skip filesystem/dependency checks only for injected test compositions. */
  skipValidation?: boolean;
  shutdownTimeoutMs?: number;
  /** Machine-wide host-coordinator port override (tests/embedders). */
  coordinatorPort?: number;
  /** Process-like used for coordinator-requested stop exit codes (mirrors
   *  the signal-handler seam). Omitted by tests that only call shutdown(). */
  process?: StandaloneProcessLike;
}

export type StandaloneHostRefusal = Exclude<PieHostAcquisition, { status: 'acquired' }>;

/** Thrown by {@link startStandalone} BEFORE any environment resolution,
 *  runtime construction, or backend startup when another pie host already
 *  owns the machine-wide host coordinator. */
export class StandaloneHostActiveError extends StandaloneStartupError {
  constructor(
    readonly refusal: StandaloneHostRefusal,
    readonly coordinatorPort: number,
  ) {
    super(describePieHostRefusal(refusal, coordinatorPort));
    this.name = 'StandaloneHostActiveError';
  }

  /** Explicit multi-line terminal message for the standalone CLI. */
  terminalLines(): string[] {
    const lines = ['pie standalone: refusing to start.'];
    if (this.refusal.status === 'refused-host-active') {
      const active = this.refusal.active;
      lines.push(active.kind === 'vscode'
        ? `A pie host is already active in VS Code: pid ${active.pid} (host coordinator port ${this.coordinatorPort}).`
        : `A standalone pie host is already active: pid ${active.pid} (host coordinator port ${this.coordinatorPort}).`);
      lines.push('Run pie from that host, or stop it first. This process started no runtime or backend and terminated no process.');
      return lines;
    }
    lines.push(describePieHostRefusal(this.refusal, this.coordinatorPort));
    return lines;
  }
}

export interface StandaloneApplication {
  readonly cwd: string;
  readonly environment: StandaloneEnvironment;
  readonly platform: HostRuntimePlatform;
  readonly runtime: HostRuntime;
  readonly url: string;
  readonly lanEnabled: boolean;
  readonly lanUrls: string[];
  shutdown(): Promise<void>;
}

export interface StandaloneMainOptions extends Omit<StandaloneStartOptions, 'cwd'> {
  process?: StandaloneProcessLike;
  installSignalHandlers?: boolean;
}

function defaultOutput(): { stdout: Writable; stderr: Writable } {
  return { stdout: process.stdout, stderr: process.stderr };
}

/**
 * Standalone backend composition. The launcher shares its console with this
 * host, so a console-attached backend would receive the launcher's Ctrl+C (or
 * any console-wide stop event) and die before the host's stdin-close graceful
 * drain; the scoped isolation gives the backend a private hidden Windows
 * console instead. See `BackendClientOptions.standaloneConsoleIsolation`.
 */
export function createStandaloneBackendClient(): BackendClient {
  return new BackendClient({ standaloneConsoleIsolation: true });
}

/** Surfaces the owned standalone shutdown needs. Structural so tests can
 *  inject fakes; `HostRuntime`/`BrowserServer`/`BackendClient` satisfy them. */
export interface OwnedStandaloneShutdownSurfaces {
  runtime: { shutdown(): Promise<void>; backend: Pick<BackendClient, 'stop' | 'dispose'> };
  browserServer: { stop(): Promise<void>; dispose(): void };
  ownership: PieHostOwnership;
  restoreEnvironment: () => void;
  shutdownTimeoutMs?: number;
  backendStopConfirmTimeoutMs?: number;
}

export interface OwnedStandaloneStartupFailureSurfaces {
  runtime?: { shutdown(): Promise<void>; backend: Pick<BackendClient, 'stop' | 'dispose'> };
  browserServer?: { dispose(): void };
  ownership: PieHostOwnership;
  restoreEnvironment: () => void;
  shutdownTimeoutMs?: number;
  backendStopConfirmTimeoutMs?: number;
}

/**
 * Await CONFIRMED exit of the owned backend process.
 *
 * `BackendClient.stop()` resolves only after the child `exit` event (stdin
 * close first, then a `STOP_KILL_TIMEOUT_MS` SIGKILL/tree-termination
 * escalation), so a resolved stop is proof the backend is dead;
 * `dispose()` merely KICKS the same stop and returns immediately, which is
 * why a fixed short wait after it can release ownership mid-drain. Returns
 * false — the caller must fail closed — when exit cannot be confirmed within
 * the budget.
 */
export async function confirmBackendProcessExit(
  backend: Pick<BackendClient, 'stop'>,
  timeoutMs = BACKEND_STOP_CONFIRM_TIMEOUT_MS,
): Promise<boolean> {
  let confirmed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      backend.stop().then(() => { confirmed = true; }),
      new Promise<'unconfirmed'>((resolve) => {
        timer = setTimeout(() => resolve('unconfirmed'), timeoutMs);
      }),
    ]);
  } catch {
    // A rejecting stop() cannot confirm the exit either.
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return confirmed;
}

/**
 * Ordered teardown of a standalone host that owns the machine-wide
 * coordinator. The graceful runtime shutdown is raced against a timeout; a
 * timed-out or failed shutdown force-disposes the browser server; and in
 * every case machine-wide ownership is released ONLY after the owned
 * backend's process exit is confirmed (see {@link confirmBackendProcessExit})
 * — and never released at all when that confirmation fails. A graceful
 * shutdown error is rethrown after the confirmed-stopped release so the
 * ownership handling cannot mask it.
 */
export async function shutdownOwnedStandaloneHost(surfaces: OwnedStandaloneShutdownSurfaces): Promise<void> {
  const { runtime, browserServer, ownership, restoreEnvironment } = surfaces;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), surfaces.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
  });
  const shutdown = runtime.shutdown().then(async () => {
    // HostRuntime starts the stop as part of dispose(); awaiting it here
    // makes the CLI's graceful signal path deterministic.
    await browserServer.stop();
    return 'stopped' as const;
  });
  // Rejection guard: the in-flight promise may reject while this function is
  // waiting on the backend fence below; the error is captured (and rethrown
  // after teardown) instead of surfacing as an unhandled rejection.
  shutdown.catch(() => undefined);
  let timedOut = false;
  let shutdownError: unknown;
  try {
    const result = await Promise.race([shutdown, timeout]);
    if (result === 'timeout') timedOut = true;
  } catch (error) {
    shutdownError = error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (timedOut || shutdownError !== undefined) {
    // BackendClient performs its own SIGTERM/SIGKILL escalation; the fence
    // below is the final owned-tree authority if another runtime producer
    // prevented HostRuntime from reaching backend shutdown.
    browserServer.dispose();
  }

  // Ownership invariant: the machine-wide lock is never released while the
  // owned backend may still be alive. A timed-out or failed shutdown may not
  // have reached `backend.stop()`, and `dispose()` only KICKS that stop
  // without awaiting it — so await a confirmed process exit here before any
  // release. (The previous 250ms wait released ownership mid-drain; stop can
  // legitimately take ~5s to escalate.)
  const backendConfirmedStopped = await confirmBackendProcessExit(
    runtime.backend,
    surfaces.backendStopConfirmTimeoutMs,
  );
  runtime.backend.dispose();
  if (!backendConfirmedStopped) {
    // Fail closed: retain the coordinator port (and the environment
    // overrides, which stay installed for the still-claimed host) rather than
    // handing the machine to a new host while this host's backend may still
    // be running.
    appendPieLog('error', 'host-coordinator',
      'standalone shutdown could not confirm backend exit; machine-wide host ownership retained', {});
    throw new Error(
      'pie standalone shutdown did not confirm that the backend process exited; '
      + 'machine-wide host ownership is retained (fail closed).');
  }
  if (timedOut) {
    // The backend is confirmed dead; give the remaining HostRuntime teardown
    // a bounded grace to finish before the port is handed over. This cannot
    // delay or skip the release on a hung producer.
    await Promise.race([
      shutdown.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, OWNERSHIP_RELEASE_DRAIN_GRACE_MS)),
    ]);
  }
  try {
    await ownership.release();
  } finally {
    restoreEnvironment();
  }
  if (shutdownError !== undefined) throw shutdownError;
}

/**
 * Startup-failure teardown for a standalone host that already owns the
 * machine-wide coordinator. Bounds the runtime's own shutdown, force-disposes
 * the browser server on shutdown timeout or failure, CONFIRMS the backend
 * process exit, and only then aborts ownership. Fails closed when the exit
 * cannot be confirmed: ownership is retained and a combined error is thrown.
 * Always throws — either the original `error` (after the confirmed teardown)
 * or the fail-closed error. `restoreEnvironment` still runs on the fail-closed
 * path: the startup failed and this host performs no further spawns; only the
 * ownership handle (and the possibly still-live backend) is deliberately
 * retained.
 */
export async function teardownAfterStandaloneStartupFailure(
  surfaces: OwnedStandaloneStartupFailureSurfaces,
  error: unknown,
): Promise<never> {
  try {
    if (surfaces.runtime) {
      let runtimeShutdownFailed = false;
      const shutdown = surfaces.runtime.shutdown().catch(() => {
        runtimeShutdownFailed = true;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), surfaces.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([shutdown.then(() => 'settled' as const), timeout]);
        if (result === 'timeout' || runtimeShutdownFailed) {
          surfaces.browserServer?.dispose();
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
      // Ownership invariant (startup-failure path): the machine-wide lock is
      // never aborted while the owned backend may still be alive. A failed or
      // timed-out startup teardown may not have reached `backend.stop()`, and
      // `dispose()` only kicks it — so await a confirmed exit here.
      const backendConfirmedStopped = await confirmBackendProcessExit(
        surfaces.runtime.backend,
        surfaces.backendStopConfirmTimeoutMs,
      );
      surfaces.runtime.backend.dispose();
      if (!backendConfirmedStopped) {
        appendPieLog('error', 'host-coordinator',
          'standalone startup teardown could not confirm backend exit; machine-wide host ownership retained', {});
        throw new Error(
          'pie standalone startup failed and the backend process exit could not be confirmed; '
          + 'machine-wide host ownership is retained (fail closed). '
          + `Startup failure: ${toErrorMessage(error)}`);
      }
    } else {
      surfaces.browserServer?.dispose();
    }
    // Nothing that needs draining ever started under this handle, and every
    // owned process is confirmed dead: immediate crash-path teardown.
    surfaces.ownership.abort();
  } finally {
    surfaces.restoreEnvironment();
  }
  throw error;
}

function writeLine(stream: Writable, message: string): void {
  stream.write(`${message}\n`);
}

/** Parse the launcher contract without consulting process state. */
export function parseStandaloneArguments(argv: readonly string[]): StandaloneArguments {
  let cwd: string | undefined;
  let allowLan: boolean | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--lan' || argument === '--no-lan') {
      if (allowLan !== undefined) throw new StandaloneStartupError(STANDALONE_USAGE);
      allowLan = argument === '--lan';
      continue;
    }
    if (argument === '--cwd') {
      if (cwd !== undefined || index + 1 >= argv.length) {
        throw new StandaloneStartupError(STANDALONE_USAGE);
      }
      cwd = argv[++index];
      continue;
    }
    if (argument?.startsWith('--cwd=')) {
      if (cwd !== undefined || argument.slice('--cwd='.length).length === 0) {
        throw new StandaloneStartupError(STANDALONE_USAGE);
      }
      cwd = argument.slice('--cwd='.length);
      continue;
    }
    throw new StandaloneStartupError(`Unknown standalone argument: ${argument ?? '(empty)'}`);
  }

  if (!cwd || !path.isAbsolute(cwd)) {
    throw new StandaloneStartupError(STANDALONE_USAGE);
  }
  const resolvedCwd = path.resolve(cwd);
  try {
    if (!fs.statSync(resolvedCwd).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new StandaloneStartupError(
      `Standalone workspace does not exist or is not a directory: ${resolvedCwd} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return { cwd: resolvedCwd, ...(allowLan !== undefined ? { allowLan } : {}) };
}

function defaultExtensionPath(): string {
  // Vite emits this entry directly under extension/out.
  return path.resolve(__dirname, '..');
}

function installEnvironmentOverrides(environment: StandaloneEnvironment): () => void {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousDataRoot = process.env.PIE_DATA_DIR;
  if (environment.dependencies.agentDir) process.env.PI_CODING_AGENT_DIR = environment.dependencies.agentDir;
  else delete process.env.PI_CODING_AGENT_DIR;
  process.env.PIE_DATA_DIR = environment.dataPaths.rootDir;
  return () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousDataRoot === undefined) delete process.env.PIE_DATA_DIR;
    else process.env.PIE_DATA_DIR = previousDataRoot;
  };
}

/**
 * Compose and start the shared HostRuntime with the browser server as its only
 * renderer surface. This is the deterministic seam used by CLI startup and
 * tests; it does not import or emulate VS Code.
 */
export async function startStandalone(options: StandaloneStartOptions): Promise<StandaloneApplication> {
  if (!path.isAbsolute(options.cwd)) {
    throw new StandaloneStartupError('Standalone workspace path must be absolute.');
  }
  const cwd = path.resolve(options.cwd);
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new StandaloneStartupError(
      `Standalone workspace does not exist or is not a directory: ${cwd} (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const output = options.output ?? defaultOutput();

  // OS-owned single-host ownership: acquired BEFORE environment resolution,
  // runtime construction, and backend startup; held until shutdown actually
  // finishes (released in the app's shutdown finally block below).
  let activeApplication: StandaloneApplication | undefined;
  let stopRequestedBeforeStart = false;
  const requestGracefulStop = (): void => {
    const app = activeApplication;
    if (!app) {
      stopRequestedBeforeStart = true;
      return;
    }
    activeApplication = undefined;
    void app.shutdown().then(
      () => {
        if (options.process) options.process.exitCode = DEFAULT_EXIT_CODES.SIGTERM;
      },
      (error: unknown) => {
        writeLine(output.stderr ?? process.stderr, `pie standalone shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        if (options.process) options.process.exitCode = 1;
      },
    );
  };
  const ownershipAcquisition = await acquirePieHostOwnership({
    kind: 'standalone',
    ...(options.coordinatorPort !== undefined ? { port: options.coordinatorPort } : {}),
    onHandoffRequested: () => {
      // Yielding message: names the requester, the stop request, and that
      // Active requests stop during the graceful shutdown; saved sessions remain available.
      writeLine(output.stdout ?? process.stdout, '[pie info] Another pie host (VS Code) requested pie to stop; stopping gracefully. Active requests will stop; saved sessions will remain available.');
      appendPieLog('info', 'host-coordinator', 'standalone host yielded to a VS Code pie host; stop requested; saved sessions are retained', {});
      requestGracefulStop();
    },
  });
  if (ownershipAcquisition.status !== 'acquired') {
    throw new StandaloneHostActiveError(ownershipAcquisition, resolvePieHostCoordinatorPort(options.coordinatorPort));
  }
  const ownership: PieHostOwnership = ownershipAcquisition.ownership;

  let restoreEnvironment: () => void = () => undefined;
  let browserServer: BrowserServer | undefined;
  let runtime: HostRuntime | undefined;
  let shutdownPromise: Promise<void> | undefined;
  try {
    const environment = options.environment ?? await resolveStandaloneEnvironment({
      extensionPath: options.extensionPath ?? defaultExtensionPath(),
      ...(options.runtimeOutputDirectory ? { runtimeOutputDirectory: options.runtimeOutputDirectory } : {}),
      ...(options.dataRoot ? { dataRoot: options.dataRoot } : {}),
      ...(options.dependencies ? { dependencies: options.dependencies } : {}),
      ...(options.skipValidation !== undefined ? { skipValidation: options.skipValidation } : {}),
    } satisfies ResolveStandaloneEnvironmentOptions);
    validateStandaloneRuntimeIdentity(environment);
    restoreEnvironment = installEnvironmentOverrides(environment);

    const platform = createStandaloneHostRuntimePlatform({
      workspaceCwd: cwd,
      extensionPath: environment.paths.extensionPath,
      runtimeOutputDirectory: environment.paths.runtimeOutputDirectory,
      dataPaths: environment.dataPaths,
      dependencies: environment.dependencies,
      ...(environment.runtimeIdentity ? { runtimeIdentity: environment.runtimeIdentity } : {}),
      ...(options.browserServerSettings ? { browserServerSettings: options.browserServerSettings } : {}),
      output,
      getBrowserServer: () => browserServer,
    });
    await applyStandaloneStartupLanPreference(platform, options.browserServerSettings?.allowLan);

    const backend = options.backend ?? createStandaloneBackendClient();
    runtime = new HostRuntime(platform, backend);
    browserServer = runtime.browserServer;

    await runtime.start();
    const state = browserServer.getState();
    if (!state.running || state.url === null) {
      throw new StandaloneStartupError(
        state.url === null
          ? 'Standalone browser server did not start; no URL is available.'
          : 'Standalone browser server did not report a running state.',
      );
    }

    const app: StandaloneApplication = {
      cwd,
      environment,
      platform,
      runtime,
      url: state.url,
      lanEnabled: state.lanEnabled,
      lanUrls: [...state.lanUrls],
      shutdown: async () => {
        if (shutdownPromise) return shutdownPromise;
        // The owned teardown helper releases machine-wide ownership only
        // after the backend's process exit is confirmed, and fails closed
        // (retains ownership) when it cannot be.
        shutdownPromise = shutdownOwnedStandaloneHost({
          runtime: runtime!,
          browserServer: browserServer!,
          ownership,
          restoreEnvironment,
          ...(options.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: options.shutdownTimeoutMs } : {}),
        });
        return shutdownPromise;
      },
    };
    activeApplication = app;
    if (stopRequestedBeforeStart) requestGracefulStop();
    return app;
  } catch (error) {
    // A startup failure must not hold the machine-wide lock once every owned
    // process is confirmed dead: bounded teardown, then a confirmed backend
    // exit, then immediate crash-path ownership abort. The helper always
    // throws — the original error, or a fail-closed error that retains
    // ownership when the backend exit cannot be confirmed.
    await teardownAfterStandaloneStartupFailure({
      runtime,
      browserServer,
      ownership,
      restoreEnvironment,
      ...(options.shutdownTimeoutMs !== undefined ? { shutdownTimeoutMs: options.shutdownTimeoutMs } : {}),
    }, error);
    throw error;
  }
}

/** Stable short name for tests and embedders that want composition without
 * installing CLI signal handlers or printing the URL. */
export const start = startStandalone;

/** Persist an explicit startup preference before HostRuntime starts the server.
 *  With no explicit value the platform's storage-backed getter restores the
 *  previously saved preference unchanged. */
export async function applyStandaloneStartupLanPreference(
  platform: Pick<HostRuntimePlatform, 'setBrowserServerLanEnabled'>,
  allowLan: boolean | undefined,
): Promise<void> {
  if (allowLan !== undefined) await platform.setBrowserServerLanEnabled(allowLan);
}

/** Install signal handling separately from startup so tests can drive it with
 * an injected process-like object and assert bounded shutdown behavior. */
export function installStandaloneSignalHandlers(
  application: StandaloneApplication,
  processLike: StandaloneProcessLike = process,
  options: { forceExit?: boolean; stderr?: Writable } = {},
): () => void {
  let signalPromise: Promise<void> | undefined;
  const handlers: Record<'SIGINT' | 'SIGTERM', () => void> = {
    SIGINT: () => handleSignal('SIGINT'),
    SIGTERM: () => handleSignal('SIGTERM'),
  };
  const handleSignal = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (signalPromise) return;
    signalPromise = application.shutdown().then(
      () => {
        processLike.exitCode = DEFAULT_EXIT_CODES[signal];
        if (options.forceExit === true) processLike.exit?.(DEFAULT_EXIT_CODES[signal]);
      },
      (error) => {
        writeLine(options.stderr ?? process.stderr, `pie standalone shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        // A rejected shutdown may mean the backend is still alive and the
        // coordinator listener is deliberately retaining ownership. Never
        // force-exit here: doing so would drop that fail-closed lock.
        processLike.exitCode = 1;
      },
    );
  };
  processLike.once('SIGINT', handlers.SIGINT);
  processLike.once('SIGTERM', handlers.SIGTERM);
  return () => {
    processLike.removeListener?.('SIGINT', handlers.SIGINT);
    processLike.removeListener?.('SIGTERM', handlers.SIGTERM);
  };
}

/** CLI entry. Printing is intentionally done only after BrowserServer reports
 *  its bound port, so launcher/browser consumers receive the actual fallback
 *  URL rather than the configured preferred port. A host-ownership refusal is
 *  reported as an explicit multi-line terminal message with exit code 2. */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  options: StandaloneMainOptions = {},
): Promise<StandaloneApplication | undefined> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    writeLine(options.output?.stdout ?? process.stdout, STANDALONE_HELP_TEXT);
    return undefined;
  }
  const { cwd, allowLan } = parseStandaloneArguments(argv);
  let application: StandaloneApplication;
  try {
    application = await startStandalone({
      cwd,
      ...options,
      browserServerSettings: {
        ...options.browserServerSettings,
        ...(allowLan !== undefined ? { allowLan } : {}),
      },
    });
  } catch (error) {
    if (error instanceof StandaloneHostActiveError) {
      const stderr = options.output?.stderr ?? process.stderr;
      for (const line of error.terminalLines()) writeLine(stderr, line);
      (options.process ?? process).exitCode = 2;
      return undefined;
    }
    throw error;
  }
  const output = options.output ?? defaultOutput();
  writeLine(output.stdout ?? process.stdout, application.url);
  if (application.lanEnabled) {
    writeLine(
      output.stderr ?? process.stderr,
      '[pie warning] Trusted LAN access has no authentication or TLS. Anyone who can reach these URLs can execute commands and read or modify files. Use only on a trusted network; public/internet access is unsupported.',
    );
    if (application.lanUrls.length === 0) {
      writeLine(output.stderr ?? process.stderr, '[pie warning] No private IPv4 LAN interface was detected.');
    }
    for (const url of application.lanUrls) writeLine(output.stdout ?? process.stdout, `[pie LAN] ${url}`);
  }
  if (options.installSignalHandlers !== false) {
    installStandaloneSignalHandlers(application, options.process ?? process, {
      forceExit: true,
      stderr: output.stderr,
    });
  }
  return application;
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    writeLine(process.stderr, `pie standalone failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

