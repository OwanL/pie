/**
 * Standalone host-coordinator adapter tests.
 *
 * The standalone entry must refuse to start (BEFORE environment resolution,
 * runtime construction, or backend startup) when any pie host already owns
 * the machine-wide coordinator, print an explicit terminal refusal message,
 * and exit with a distinct code. Full runtime startup is intentionally not
 * exercised here (it spawns the real backend); ownership/handoff/release
 * semantics are covered by `test/host/coordinator/host-coordinator.test.ts`.
 */
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';

import { acquirePieHostOwnership } from '../../src/host/coordinator/host-coordinator';
import {
  installStandaloneSignalHandlers,
  main,
  StandaloneHostActiveError,
  startStandalone,
  type StandaloneProcessLike,
} from '../../src/standalone';

async function tempDirectory(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pie-standalone-hostlock-'));
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function collectStream(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let collected = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => { collected += chunk; });
  return { stream, text: () => collected };
}

test('standalone refuses to start while any pie host owns the machine-wide coordinator', { timeout: 15_000 }, async () => {
  const workspace = await tempDirectory();
  const port = await freePort();
  const holder = await acquirePieHostOwnership({ kind: 'vscode', port, handoffTimeoutMs: 0 });
  assert.equal(holder.status, 'acquired');
  try {
    await assert.rejects(
      startStandalone({ cwd: workspace, coordinatorPort: port }),
      (error: unknown) => {
        assert.ok(error instanceof StandaloneHostActiveError);
        assert.equal(error.refusal.status, 'refused-host-active');
        assert.equal(error.refusal.active.kind, 'vscode');
        assert.equal(error.refusal.active.pid, process.pid);
        const lines = error.terminalLines();
        assert.ok(lines.some((line) => line.includes('pie standalone: refusing to start.')));
        assert.ok(lines.some((line) => line.includes('VS Code') && line.includes(`pid ${process.pid}`)));
        return true;
      },
    );
  } finally {
    await holder.ownership.release();
  }
});

test('standalone startup releases ownership when environment validation fails', { timeout: 15_000 }, async () => {
  const workspace = await tempDirectory();
  const port = await freePort();

  await assert.rejects(
    startStandalone({
      cwd: workspace,
      extensionPath: path.join(workspace, 'missing-extension'),
      coordinatorPort: port,
    }),
    /Standalone extension root is unavailable/,
  );

  const retry = await acquirePieHostOwnership({ kind: 'standalone', port, handoffTimeoutMs: 0 });
  try {
    assert.equal(retry.status, 'acquired', 'a failed startup must release the coordinator for a later host');
  } finally {
    if (retry.status === 'acquired') await retry.ownership.release();
  }
});

test('standalone CLI prints the explicit refusal message and exits 2', { timeout: 15_000 }, async () => {
  const workspace = await tempDirectory();
  const port = await freePort();
  const holder = await acquirePieHostOwnership({ kind: 'standalone', port, handoffTimeoutMs: 0 });
  assert.equal(holder.status, 'acquired');
  const stdout = collectStream();
  const stderr = collectStream();
  const processLike: { exitCode?: number | string } & StandaloneProcessLike = {
    once: () => undefined,
    removeListener: () => undefined,
  };
  try {
    const result = await main(['--cwd', workspace], {
      coordinatorPort: port,
      installSignalHandlers: false,
      output: { stdout: stdout.stream, stderr: stderr.stream },
      process: processLike as StandaloneProcessLike,
    });
    assert.equal(result, undefined, 'the CLI must not report a started application on refusal');
    const text = stderr.text();
    assert.match(text, /pie standalone: refusing to start\./);
    assert.match(text, /standalone pie host is already active/);
    assert.match(text, new RegExp(`pid ${process.pid}`));
    assert.match(text, /terminated no process/);
    assert.equal(processLike.exitCode, 2);
    assert.equal(stdout.text(), '', 'no URL may be printed when startup is refused');
  } finally {
    await holder.ownership.release();
  }
});

test('signal-handler seam is unchanged alongside the coordinator-requested stop path', async () => {
  let shutdownCount = 0;
  let sigint: (() => void) | undefined;
  const processLike = {
    exitCode: undefined as number | undefined,
    once: (event: 'SIGINT' | 'SIGTERM', listener: () => void) => {
      if (event === 'SIGINT') sigint = listener;
    },
    removeListener: () => undefined,
  };
  const application = { shutdown: async () => { shutdownCount += 1; } } as never;
  const remove = installStandaloneSignalHandlers(application, processLike, { forceExit: false });
  sigint!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(shutdownCount, 1);
  assert.equal(processLike.exitCode, 130);
  remove();
});