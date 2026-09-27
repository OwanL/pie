import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { tmpdir } from 'node:os';

import registerPlaywright from '../index.js';
import {
  cleanupChildToolRuntimeOwner,
  createChildToolRuntimeOwner,
  runWithChildToolRuntimeOwner,
  type ChildToolRuntimeOwner,
} from '../../../agent-processes/lib/process-lifecycle/child-tool-runtime-owner.js';
import { RuntimeRegistry, runtimeRegistry, type SidecarSpawn } from '../runtime-client.js';

class MockSidecar {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly events = new EventEmitter();
  readonly requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly stdin = {
    write: (line: string): boolean => {
      const record = JSON.parse(line) as Record<string, any>;
      if (record.kind === 'shutdown') {
        queueMicrotask(() => this.events.emit('close', 0, null));
      } else if (record.kind === 'request') {
        this.requests.push({ method: record.method, params: record.params ?? {} });
        queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify({
          v: 1,
          kind: 'response',
          id: record.id,
          ok: true,
          result: { sessionId: record.params?.sessionId, headless: true, isolated: true },
        })}\n`)));
      }
      return true;
    },
  };
  readonly pid = Math.floor(Math.random() * 100_000) + 1;
  closed = false;

  constructor() { this.events.on('close', () => { this.closed = true; }); }

  on(event: 'error' | 'close' | 'exit', listener: (...args: any[]) => void): this {
    this.events.on(event, listener);
    return this;
  }

  kill(): boolean {
    this.closed = true;
    this.events.emit('close', null, 'SIGKILL');
    return true;
  }
}

function makeTool(): Record<string, any> {
  let tool: Record<string, any> | undefined;
  registerPlaywright({ registerTool(value: Record<string, any>) { tool = value; }, on() {} } as never);
  return tool!;
}

async function open(tool: Record<string, any>, sessionManager: { getSessionFile(): string | undefined }, sessionId: string) {
  return await tool.execute('call', { action: 'open', sessionId }, undefined, undefined, {
    sessionManager,
    model: { input: ['text'] },
  });
}

test('in-memory child Playwright scope opens privately, retains artifacts, and rejects late recreation', async () => {
  const parentDir = await mkdtemp(path.join(tmpdir(), 'pw-child-scope-'));
  const parentSessionPath = path.join(parentDir, 'parent.jsonl');
  await writeFile(parentSessionPath, '');
  const owners = [createChildToolRuntimeOwner(), createChildToolRuntimeOwner()];
  const sidecars: MockSidecar[] = [];
  const isolatedRegistry = new RuntimeRegistry((() => {
    const sidecar = new MockSidecar();
    sidecars.push(sidecar);
    return sidecar;
  }) as SidecarSpawn);
  const sharedRegistry = runtimeRegistry as unknown as {
    get(sessionPath: string): Promise<unknown>;
    getForChild(owner: ChildToolRuntimeOwner): unknown;
  };
  const originalGet = sharedRegistry.get;
  const originalGetForChild = sharedRegistry.getForChild;
  sharedRegistry.get = (sessionPath) => isolatedRegistry.get(sessionPath);
  sharedRegistry.getForChild = (owner) => isolatedRegistry.getForChild(owner);
  const tool = makeTool();
  let artifactDirs: string[] = [];
  try {
    await runWithChildToolRuntimeOwner(owners[0]!, async () => await open(tool, { getSessionFile: () => undefined }, 'same-id'));
    await runWithChildToolRuntimeOwner(owners[1]!, async () => await open(tool, { getSessionFile: () => undefined }, 'same-id'));
    await open(tool, { getSessionFile: () => parentSessionPath }, 'parent-id');

    assert.equal(sidecars.length, 3, 'each of two child owners and the persistent parent starts a distinct sidecar');
    assert.notEqual(isolatedRegistry.getForChild(owners[0]!), isolatedRegistry.getForChild(owners[1]!));
    assert.notEqual(isolatedRegistry.getForChild(owners[0]!), await isolatedRegistry.get(parentSessionPath));
    artifactDirs = sidecars.flatMap((sidecar) => sidecar.requests.map((request) => request.params['artifactDir'] as string));
    assert.equal(artifactDirs.length, 3);
    assert.ok(artifactDirs[0]!.includes('pie-playwright-child-artifacts'));
    assert.ok(!artifactDirs[0]!.includes(path.basename(parentSessionPath)));

    await cleanupChildToolRuntimeOwner(owners[0]!);
    assert.equal(owners[0]!.state, 'closed');
    assert.equal(sidecars[0]!.closed, true, 'owner cleanup awaits graceful sidecar exit');
    await stat(artifactDirs[0]!);
    await assert.rejects(
      runWithChildToolRuntimeOwner(owners[0]!, async () => await open(tool, { getSessionFile: () => undefined }, 'late')),
      (error: unknown) => (error as { code?: string }).code === 'CHILD_RUNTIME_CLOSING',
    );
    assert.equal(sidecars.length, 3, 'a closed owner cannot recreate its sidecar');

    await runWithChildToolRuntimeOwner(owners[1]!, async () => await tool.execute('call', { action: 'observe', sessionId: 'same-id' }, undefined, undefined, {
      sessionManager: { getSessionFile: () => undefined }, model: { input: ['text'] },
    }));
    await tool.execute('call', { action: 'observe', sessionId: 'parent-id' }, undefined, undefined, {
      sessionManager: { getSessionFile: () => parentSessionPath }, model: { input: ['text'] },
    });
    assert.deepEqual(sidecars.map((sidecar) => sidecar.requests.map((request) => request.method)), [
      ['open'], ['open', 'observe'], ['open', 'observe'],
    ], 'closing one child leaves its sibling and the persistent parent usable');

    await cleanupChildToolRuntimeOwner(owners[0]!);
    assert.equal(sidecars[0]!.requests.length, 1, 'cleanup is idempotent');
  } finally {
    await Promise.all(owners.map((owner) => cleanupChildToolRuntimeOwner(owner).catch(() => undefined)));
    await isolatedRegistry.shutdownSession(parentSessionPath);
    sharedRegistry.get = originalGet;
    sharedRegistry.getForChild = originalGetForChild;
    for (const artifactDir of artifactDirs) {
      const ownerPartition = path.dirname(path.dirname(artifactDir));
      if (ownerPartition.includes('pie-playwright-child-artifacts')) await rm(ownerPartition, { recursive: true, force: true });
    }
    await rm(parentDir, { recursive: true, force: true });
  }
});
