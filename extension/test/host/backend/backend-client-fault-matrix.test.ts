import assert from 'node:assert/strict';
import * as cp from 'node:child_process';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { PROTOCOL_VERSION } from '../../../src/shared/protocol.js';

class ImmediateReadyStream extends PassThrough {
  private readySent = false;

  override on(eventName: string | symbol, listener: (...args: any[]) => void): this {
    const result = super.on(eventName, listener);
    if (!this.readySent && eventName === 'data') {
      this.readySent = true;
      listener(Buffer.from(`${JSON.stringify({
        event: 'backend.ready',
        payload: {
          sdkPath: '/mock/sdk', agentDir: '/mock/agent', sdkVersion: 'test',
          protocolVersion: PROTOCOL_VERSION, authPath: '/mock/auth.json',
        },
      })}\n`));
    }
    return result;
  }
}

class FaultProcess extends EventEmitter {
  readonly stdout = new ImmediateReadyStream();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly requests: Array<{ id: string; method: string; params?: unknown }> = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk) => {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        this.requests.push(JSON.parse(line) as { id: string; method: string; params?: unknown });
      }
    });
  }

  respond(index: number, result: unknown = {}): void {
    const request = this.requests[index];
    if (!request) throw new Error(`missing request ${index}`);
    this.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
  }

  event(event: string, payload: unknown): void {
    this.stdout.write(`${JSON.stringify({ event, payload })}\n`);
  }

  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    this.emit('exit', 1);
    return true;
  }
}

let uninstallMock: (() => void) | undefined;
let BackendClientCtor: typeof import('../../../src/host/backend/client.js').BackendClient;
const spawned: FaultProcess[] = [];
let nextProcess: FaultProcess;

function installMocks(): () => void {
  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return {
        version: 'test',
        EventEmitter: class<TValue> {
          private readonly emitter = new EventEmitter();
          readonly event = (listener: (value: TValue) => void) => {
            this.emitter.on('event', listener);
            return { dispose: () => this.emitter.off('event', listener) };
          };
          fire(value: TValue): void { this.emitter.emit('event', value); }
          dispose(): void { this.emitter.removeAllListeners(); }
        },
      };
    }
    if (request === 'node:child_process' || request === 'child_process') {
      return {
        ...cp,
        spawn: (() => {
          spawned.push(nextProcess);
          return nextProcess as unknown as cp.ChildProcess;
        }) as typeof cp.spawn,
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => { moduleWithLoad._load = originalLoad; };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test.before(async () => {
  uninstallMock = installMocks();
  BackendClientCtor = (await import('../../../src/host/backend/client.js')).BackendClient;
});

test.after(() => uninstallMock?.());

test('command transport fault matrix preserves events, crash evidence, and replacement generation', async () => {
  const noOrphans = async () => ({ candidates: [], reaped: [], failures: [] });
  const first = new FaultProcess();
  nextProcess = first;
  const client = new BackendClientCtor({ orphanReaper: noOrphans, stdoutMaxLineBytes: 2_048 });
  const events: Array<{ event: string; payload: any }> = [];
  const exits: Array<{ code: number | null }> = [];
  const eventSubscription = client.onEvent((event) => events.push(event as never));
  const exitSubscription = client.onExit((event) => exits.push(event));

  try {
    await client.start({ nodePath: '/mock/node', backendPath: '/mock/backend', sdkPath: '/mock/sdk', cwd: '/mock' });
    assert.equal(client.getGeneration(), 1);

    // Dropped acknowledgement + delayed semantic event: the local command
    // waiter times out, but the independently delivered event remains visible.
    const droppedAck = client.request('message.send', { sessionPath: '/s', text: 'hello' }, { timeoutMs: 5 });
    await assert.rejects(droppedAck, /Timed out waiting for response/);
    first.event('message.started', {
      sessionPath: '/s', messageId: 'assistant-1', requestId: 'worker-request', operationId: 'semantic-op',
    });
    await tick();
    assert.equal(events.at(-1)?.event, 'message.started');

    const afterDroppedAck = client.request('app.ping');
    await tick();
    first.respond(1, { pong: true });
    assert.deepEqual(await afterDroppedAck, { pong: true });

    // A worker crash is an event-level fault, not a coordinator transport
    // death. It must be delivered and leave subsequent commands usable.
    first.event('operational-error', {
      incidentId: 'worker-exit:worker-1:3',
      dedupeKey: 'worker-exit:worker-1:3',
      code: 'SESSION_WORKER_EXITED',
      message: 'The session worker exited. Live work was interrupted and was not replayed.',
      detail: 'worker crashed in the fault matrix',
      sessionPath: '/s',
      operationId: 'semantic-op',
      severity: 'error',
      certainty: 'definitive',
      phase: 'runtime',
      recovery: { retry: false, restart: true, showLogs: true },
      checkpoint: { rootSessionPath: '/s', currentLeasePath: '/s', workerGeneration: 3 },
    });
    await tick();
    assert.equal(events.at(-1)?.event, 'operational-error');
    assert.equal(events.at(-1)?.payload.code, 'SESSION_WORKER_EXITED');
    const afterWorkerCrash = client.request('app.ping');
    await tick();
    first.respond(2, { pong: 'after-worker-crash' });
    assert.deepEqual(await afterWorkerCrash, { pong: 'after-worker-crash' });

    // An overlong backend record terminalizes the transport instead of being
    // parsed as a partial command response.
    const interruptedByOverflow = client.request('session.open', { sessionPath: '/s' });
    first.stdout.write(`${JSON.stringify({ id: first.requests[3]!.id, ok: true, result: 'x'.repeat(3_000) })}\n`);
    await assert.rejects(interruptedByOverflow, /Backend exited unexpectedly/);
    assert.equal(first.killed, true);
    assert.equal(exits.length, 1);

    // Starting again creates a new backend generation. Output from the retired
    // process is detached and cannot cross into the replacement stream.
    const replacement = new FaultProcess();
    nextProcess = replacement;
    await client.start({ nodePath: '/mock/node', backendPath: '/mock/backend', sdkPath: '/mock/sdk', cwd: '/mock' });
    assert.equal(client.getGeneration(), 2);
    const beforeStale = events.length;
    first.event('message.started', { sessionPath: '/s', messageId: 'stale' });
    await tick();
    assert.equal(events.length, beforeStale);

    const replacementPing = client.request('app.ping');
    await tick();
    replacement.respond(0, { generation: 2 });
    assert.deepEqual(await replacementPing, { generation: 2 });
  } finally {
    eventSubscription.dispose();
    exitSubscription.dispose();
    client.dispose();
  }
});
