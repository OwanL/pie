import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  cleanupChildToolRuntimeOwner,
  createChildToolRuntimeOwner,
  registerChildToolRuntimeCleanup,
  runWithChildToolRuntimeOwner,
} from '../../../agent-processes/lib/process-lifecycle/child-tool-runtime-owner.js';
import { DesktopCoordinator } from '../desktop-ownership.js';
import registerComputer from '../index.js';
import { RuntimeRegistry } from '../runtime-client.js';

function makeExtension(coordinator: DesktopCoordinator, registry: any) {
  let tool: any;
  const handlers = new Map<string, Function>();
  registerComputer({
    registerTool(value: any) { tool = value; },
    on(name: string, handler: Function) { handlers.set(name, handler); },
  } as any, { desktopCoordinator: coordinator, runtimeRegistry: registry });
  return { tool, handlers };
}

test('in-memory child sessions get owner-scoped runtimes and retained OS-temp artifacts, never parent paths', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pie-computer-child-scope-'));
  const parentSessionPath = path.join(dir, 'main-session.jsonl');
  await writeFile(parentSessionPath, '');
  const requestPaths: string[] = [];
  const openParams: any[] = [];
  const runtimeIdentities: Array<{ kind: 'persistent'; sessionPath: string } | { kind: 'child'; owner: { id: string } }> = [];
  const shutdownPaths: string[] = [];
  const shutdownChildOwners: string[] = [];
  const childClients = new Map<string, any>();
  const makeClient = () => ({
    hasHeldInput: false,
    async releaseAllHeldKnown() {},
    async request(method: string, params: any) {
      requestPaths.push(method);
      if (method === 'open') openParams.push(params);
      return { sessionId: params.sessionId, targetId: 'desktop', held: { keys: [], buttons: [] } };
    },
    markReopened() {},
  });
  const parentClient = makeClient();
  const registry = {
    async get(sessionPath: string) { runtimeIdentities.push({ kind: 'persistent', sessionPath }); return parentClient; },
    getForChild(owner: { id: string }) {
      runtimeIdentities.push({ kind: 'child', owner });
      let client = childClients.get(owner.id);
      if (!client) { client = makeClient(); childClients.set(owner.id, client); }
      return client;
    },
    async peek() { return parentClient; },
    peekForChild(owner: { id: string }) { return childClients.get(owner.id); },
    async shutdownSession(sessionPath: string) { shutdownPaths.push(sessionPath); },
    async shutdownChild(owner: { id: string }) { shutdownChildOwners.push(owner.id); },
  };
  const coordinator = new DesktopCoordinator(path.join(dir, 'desktop-owner.lock'));
  const { tool, handlers } = makeExtension(coordinator, registry);
  const parentContext = {
    sessionManager: { getSessionFile: () => parentSessionPath, getSessionName: () => 'Main design session' },
    model: { input: ['text'] },
  };
  const childContext = { sessionManager: {}, model: { input: ['text'] } };
  const params = { action: 'open', sessionId: 'shared-tool-session', selector: { kind: 'desktop' } };

  try {
    await handlers.get('agent_start')!({}, parentContext);
    await tool.execute('parent-open', params, undefined, undefined, parentContext);
    await handlers.get('agent_settled')!({}, parentContext);

    const firstChild = createChildToolRuntimeOwner('researcher: inspect desktop preferences');
    await runWithChildToolRuntimeOwner(firstChild, async () => {
      await tool.execute('child-open-a', params, undefined, undefined, childContext);
      await tool.execute('child-observe-a', { action: 'observe', sessionId: 'shared-tool-session' }, undefined, undefined, childContext);
    });
    assert.equal(firstChild.cleanups.size, 1, 'one closer is registered for the child runtime despite multiple calls');
    await cleanupChildToolRuntimeOwner(firstChild);

    const secondChild = createChildToolRuntimeOwner('worker: confirm visible dialog');
    await runWithChildToolRuntimeOwner(secondChild, async () => {
      await tool.execute('child-open-b', params, undefined, undefined, childContext);
    });
    await cleanupChildToolRuntimeOwner(secondChild);

    assert.equal(runtimeIdentities.length, 4);
    assert.equal(runtimeIdentities[0]?.kind, 'persistent');
    assert.equal(runtimeIdentities[0]?.kind === 'persistent' && path.resolve(runtimeIdentities[0].sessionPath), path.resolve(parentSessionPath));
    const childOwnerIds = runtimeIdentities.flatMap((identity) => identity.kind === 'child' ? [identity.owner.id] : []);
    assert.deepEqual(childOwnerIds, [firstChild.id, firstChild.id, secondChild.id], 'each child owner reuses its private runtime and never shares the primary runtime');
    assert.ok(runtimeIdentities.slice(1).every((identity) => identity.kind === 'child' && !('sessionPath' in identity)), 'child runtime identity is an owner descriptor, not a fabricated session path');
    assert.equal(openParams.length, 3);
    assert.ok(openParams[0].artifactDir.startsWith(path.join(await realpath(dir), 'computer-use')));
    const childArtifactRoot = path.join(os.tmpdir(), 'pie-computer-child-artifacts');
    assert.ok(openParams[1].artifactDir.startsWith(childArtifactRoot));
    assert.ok(openParams[2].artifactDir.startsWith(childArtifactRoot));
    assert.notEqual(openParams[1].artifactDir, openParams[2].artifactDir);
    assert.ok(!openParams[1].artifactDir.includes(path.basename(parentSessionPath)));
    assert.deepEqual(shutdownChildOwners, [firstChild.id, secondChild.id], 'each child closer shuts down only its owned runtime');
    assert.deepEqual(shutdownPaths, [], 'child shutdown never routes through persistent session registry access');
    assert.deepEqual(requestPaths, ['open', 'open', 'observe', 'open'], 'all sidecar calls are mocked; no desktop executable is invoked');

    const callsBeforeLateRequest = runtimeIdentities.length;
    await assert.rejects(
      tool.execute('late-parent-request', { action: 'observe', sessionId: 'shared-tool-session' }, undefined, undefined, parentContext),
      (error: any) => error.code === 'DESKTOP_OWNER_CLOSED',
    );
    assert.equal(runtimeIdentities.length, callsBeforeLateRequest, 'settled primary turn cannot reacquire the desktop');

    await handlers.get('agent_start')!({}, parentContext);
    await tool.execute('next-turn-open', params, undefined, undefined, parentContext);
    await handlers.get('agent_settled')!({}, parentContext);
    await handlers.get('session_shutdown')!({}, parentContext);
    assert.deepEqual(shutdownPaths, [path.resolve(parentSessionPath)]);
  } finally {
    await coordinator.shutdownAll(async () => {});
    const childArtifactRoot = path.join(os.tmpdir(), 'pie-computer-child-artifacts');
    for (const { artifactDir } of openParams) {
      if (artifactDir?.startsWith(childArtifactRoot)) await rm(path.dirname(artifactDir), { recursive: true, force: true });
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('shared child shutdown keeps desktop ownership until delayed runtime shutdown completes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pie-computer-child-shutdown-'));
  const child = new DelayedShutdownChild();
  const registry = new RuntimeRegistry(() => child as any);
  const coordinator = new DesktopCoordinator(path.join(dir, 'desktop-owner.lock'));
  const owner = createChildToolRuntimeOwner('delayed shutdown child');
  const childScope = coordinator.child(owner, 'Sub-agent “delayed shutdown child”', async (runtime) => {
    if (runtime.kind !== 'child') return;
    const client = registry.peekForChild(runtime.owner);
    await client?.releaseAllHeldKnown();
    await registry.shutdownChild(runtime.owner);
  });
  const contender = coordinator.primary(path.join(dir, 'contender.jsonl'), 'Other desktop controller');
  let cleanup: Promise<void> | undefined;

  try {
    await coordinator.run(childScope, async () => {
      const client = registry.getForChild(owner);
      await client.request('ping', {}, { allowNeedsReopen: true });
    });
    assert.equal(owner.cleanups.size, 2, 'desktop and registry independently register cleanup for the same child runtime');

    cleanup = cleanupChildToolRuntimeOwner(owner);
    await child.shutdownRequested;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await assert.rejects(
      coordinator.run(contender, async () => undefined),
      (error: any) => error.code === 'DESKTOP_BUSY' && error.message.includes('delayed shutdown child'),
      'another controller cannot claim the desktop while the runtime shutdown is pending',
    );
    assert.equal(registry.size, 1, 'registry retains the runtime while its shutdown is pending');

    child.finishShutdown();
    await cleanup;
    assert.equal(registry.size, 0, 'registry removes the child after shutdown completes');
    await coordinator.run(contender, async () => undefined);
    await coordinator.settle(contender, async () => {});
  } finally {
    child.finishShutdown();
    await cleanup?.catch(() => {});
    await coordinator.shutdownAll(async (runtime) => {
      if (runtime.kind === 'child') await registry.shutdownChild(runtime.owner);
    });
    await registry.shutdownAll();
    await rm(dir, { recursive: true, force: true });
  }
});

class DelayedShutdownChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  private resolveShutdownRequested!: () => void;
  readonly shutdownRequested = new Promise<void>((resolve) => { this.resolveShutdownRequested = resolve; });
  readonly stdin = {
    write: (data: string) => {
      for (const line of data.trim().split('\n')) {
        if (!line) continue;
        const record = JSON.parse(line);
        if (record.kind === 'shutdown') this.resolveShutdownRequested();
        else if (record.kind === 'request') {
          queueMicrotask(() => this.stdout.emit('data', Buffer.from(`${JSON.stringify({
            v: 1, kind: 'response', id: record.id, ok: true, result: {},
          })}\n`)));
        }
      }
      return true;
    },
  };

  finishShutdown(): void { this.emit('close', 0, null); }
  kill(): boolean { queueMicrotask(() => this.emit('close', 1, null)); return true; }
}

test('failed child cleanup retains desktop ownership until its retained callback succeeds', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pie-computer-child-retry-'));
  const coordinator = new DesktopCoordinator(path.join(dir, 'desktop-owner.lock'));
  const owner = createChildToolRuntimeOwner('retry desktop cleanup');
  let desktopCleanupCalls = 0;
  let otherCleanupCalls = 0;
  const childScope = coordinator.child(owner, 'Sub-agent “retry desktop cleanup”', async () => {
    desktopCleanupCalls++;
    if (desktopCleanupCalls === 1) throw new Error('transient desktop shutdown failure');
  });
  registerChildToolRuntimeCleanup(owner, 'other-child-runtime', async () => { otherCleanupCalls++; });
  const contender = coordinator.primary(path.join(dir, 'contender.jsonl'), 'Other desktop controller');

  try {
    await coordinator.run(childScope, async () => undefined);
    await assert.rejects(cleanupChildToolRuntimeOwner(owner), /failed to close/);
    assert.equal(owner.state, 'closing', 'a failed cleanup keeps the child owner fenced');
    assert.equal(owner.cleanups.size, 1, 'the successful non-desktop callback is not retained');
    assert.equal(otherCleanupCalls, 1);
    await assert.rejects(
      coordinator.run(contender, async () => undefined),
      (error: any) => error.code === 'DESKTOP_BUSY',
      'failed desktop cleanup must retain the exclusive claim',
    );

    await cleanupChildToolRuntimeOwner(owner);
    assert.equal(owner.state, 'closed');
    assert.equal(desktopCleanupCalls, 2, 'only the failed desktop callback is retried');
    assert.equal(otherCleanupCalls, 1, 'successful callbacks are never repeated');
    await coordinator.run(contender, async () => undefined);
    await coordinator.settle(contender, async () => {});
  } finally {
    await cleanupChildToolRuntimeOwner(owner).catch(() => {});
    await coordinator.shutdownAll(async () => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('computer runtime registry separates child owners from persistent session paths and closes child entries', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pie-computer-child-registry-'));
  const parentSessionPath = path.join(dir, 'parent.jsonl');
  await writeFile(parentSessionPath, '');
  const registry = new RuntimeRegistry();
  const firstChild = createChildToolRuntimeOwner('first child');
  const secondChild = createChildToolRuntimeOwner('second child');
  try {
    const firstRuntime = registry.getForChild(firstChild);
    assert.equal(registry.getForChild(firstChild), firstRuntime, 'an owner resolves the same sidecar runtime on every call');
    const secondRuntime = registry.getForChild(secondChild);
    const persistentRuntime = await registry.get(parentSessionPath);
    assert.notEqual(firstRuntime, secondRuntime);
    assert.notEqual(firstRuntime, persistentRuntime);
    assert.notEqual(secondRuntime, persistentRuntime);
    assert.equal(registry.size, 3);

    await cleanupChildToolRuntimeOwner(firstChild);
    assert.equal(registry.size, 2, 'closing one child removes only its private registry entry');
    assert.throws(
      () => registry.getForChild(firstChild),
      (error: any) => error.code === 'CHILD_RUNTIME_CLOSING',
    );
    assert.equal(registry.getForChild(secondChild), secondRuntime, 'a sibling remains usable after the first owner closes');
    assert.equal(await registry.get(parentSessionPath), persistentRuntime, 'persistent runtime API remains path-keyed and unchanged');

    await cleanupChildToolRuntimeOwner(secondChild);
    assert.equal(registry.size, 1);
    await registry.shutdownSession(parentSessionPath);
    assert.equal(registry.size, 0);
  } finally {
    await Promise.all([cleanupChildToolRuntimeOwner(firstChild), cleanupChildToolRuntimeOwner(secondChild)]);
    await registry.shutdownAll();
    await rm(dir, { recursive: true, force: true });
  }
});
