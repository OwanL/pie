import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import test from 'node:test';

import type { WebviewToHostMessage } from '../../../../src/shared/protocol';
import { setLogLevel } from '../../../../src/host/util/pie-logger';

/**
 * Strict protocol-validation cases for the pinned-group message handlers.
 * The webview→host boundary must reject malformed payloads (missing/empty
 * paths, and non-finite / negative / fractional `toItemIndex`) as protocol
 * defects before they reach the reducer, surfacing a `NoticeShown` and
 * dispatching no Command. Mirrors the existing sessionPath-defect pattern.
 *
 * Same vscode-stub + dynamic-import isolation as `message-router-log.test.ts`
 * (the router imports `vscode` at module load).
 */

let uninstallVscodeMock: (() => void) | undefined;
let MessageRouterCtor: typeof import('../../../../src/host/core/message-router').MessageRouter;

function installVscodeMock(): () => void {
  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return {
        version: '1.102.3-test',
        EventEmitter: class<TValue> {
          private readonly emitter = new EventEmitter();

          readonly event = (listener: (value: TValue) => void) => {
            this.emitter.on('event', listener);
            return { dispose: () => this.emitter.off('event', listener) };
          };

          fire(value: TValue): void {
            this.emitter.emit('event', value);
          }

          dispose(): void {
            this.emitter.removeAllListeners();
          }
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => {
    moduleWithLoad._load = originalLoad;
  };
}

test.before(async () => {
  uninstallVscodeMock = installVscodeMock();
  setLogLevel('debug');
  ({ MessageRouter: MessageRouterCtor } = await import('../../../../src/host/core/message-router'));
});

test.after(() => {
  uninstallVscodeMock?.();
  setLogLevel('info');
});

interface Captured {
  events: unknown[];
  notices: { kind: string; notice: string }[];
  commands: { kind: string; cmdKind: string; cmd: Record<string, unknown> }[];
}

function newRouter(): { router: import('../../../../src/host/core/message-router').MessageRouter; capture: () => Captured } {
  const events: unknown[] = [];
  const router = new MessageRouterCtor(
    (event) => events.push(event),
    () => ({ sessions: { activeSessionPath: null, openTabPaths: [], pinnedTabPaths: [], pinnedTabGroups: [], runningSessionPaths: [] } } as never),
    {} as never,
    { reveal: () => undefined, postState: () => undefined, postImperative: () => undefined } as never,
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
  );
  const capture = (): Captured => {
    const notices = events
      .filter((event) => (event as { kind?: string }).kind === 'NoticeShown') as { kind: string; notice: string }[];
    const commands = events
      .filter((event) => (event as { kind?: string }).kind === 'Command')
      .map((event) => {
        const e = event as { kind: string; cmd: { kind: string } & Record<string, unknown> };
        return { kind: e.kind, cmdKind: e.cmd.kind, cmd: e.cmd as Record<string, unknown> };
      });
    return { events, notices, commands };
  };
  return { router, capture };
}

async function send(router: import('../../../../src/host/core/message-router').MessageRouter, msg: WebviewToHostMessage): Promise<void> {
  await router.handle(msg);
}

// ─── groupPinnedTab ────────────────────────────────────────────────────────

test('groupPinnedTab dispatches the command for a valid payload', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'groupPinnedTab', sourcePath: '/a', targetPath: '/b' });
  const { notices, commands } = capture();
  assert.deepEqual(notices, []);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].cmdKind, 'GroupPinnedTab');
  assert.equal(commands[0].cmd.sourcePath, '/a');
  assert.equal(commands[0].cmd.targetPath, '/b');
});

test('groupPinnedTab rejects an empty sourcePath as a protocol defect', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'groupPinnedTab', sourcePath: '', targetPath: '/b' } as never);
  const { notices, commands } = capture();
  assert.equal(notices.length, 1);
  assert.match(notices[0].notice, /Protocol defect: groupPinnedTab/);
  assert.equal(commands.length, 0);
});

test('groupPinnedTab rejects a missing targetPath as a protocol defect', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'groupPinnedTab', sourcePath: '/a', targetPath: '' } as never);
  const { notices, commands } = capture();
  assert.equal(notices.length, 1);
  assert.equal(commands.length, 0);
});

// ─── mergePinnedGroups ─────────────────────────────────────────────────────

test('mergePinnedGroups dispatches the command for a valid payload', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'mergePinnedGroups', sourcePath: '/a', targetPath: '/c' });
  const { notices, commands } = capture();
  assert.deepEqual(notices, []);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].cmdKind, 'MergePinnedGroups');
});

test('mergePinnedGroups rejects an empty path as a protocol defect', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'mergePinnedGroups', sourcePath: '/a', targetPath: '' } as never);
  const { notices, commands } = capture();
  assert.equal(notices.length, 1);
  assert.match(notices[0].notice, /Protocol defect: mergePinnedGroups/);
  assert.equal(commands.length, 0);
});

// ─── ungroupPinnedTab (finite nonnegative integer toItemIndex) ─────────────

test('ungroupPinnedTab dispatches the command for a valid nonnegative integer index', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'ungroupPinnedTab', sourcePath: '/a', toItemIndex: 0 });
  const { notices, commands } = capture();
  assert.deepEqual(notices, []);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].cmdKind, 'UngroupPinnedTab');
  assert.equal(commands[0].cmd.toItemIndex, 0);
});

test('ungroupPinnedTab rejects an empty sourcePath as a protocol defect', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'ungroupPinnedTab', sourcePath: '', toItemIndex: 0 } as never);
  const { notices, commands } = capture();
  assert.equal(notices.length, 1);
  assert.equal(commands.length, 0);
});

for (const [label, toItemIndex] of [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['negative', -1],
  ['fractional', 1.5],
] as const) {
  test(`ungroupPinnedTab rejects a non-finite/nonnegative/integer toItemIndex (${label})`, async () => {
    const { router, capture } = newRouter();
    await send(router, { type: 'ungroupPinnedTab', sourcePath: '/a', toItemIndex } as never);
    const { notices, commands } = capture();
    assert.equal(notices.length, 1);
    assert.match(notices[0].notice, /Protocol defect: ungroupPinnedTab/);
    assert.equal(commands.length, 0);
  });
}

// ─── movePinnedItem (finite nonnegative integer toItemIndex) ────────────────

test('movePinnedItem dispatches the command for a valid nonnegative integer index', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'movePinnedItem', sourcePath: '/a', toItemIndex: 2 });
  const { notices, commands } = capture();
  assert.deepEqual(notices, []);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].cmdKind, 'MovePinnedItem');
  assert.equal(commands[0].cmd.toItemIndex, 2);
});

for (const [label, toItemIndex] of [
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['negative', -1],
  ['fractional', 0.5],
] as const) {
  test(`movePinnedItem rejects a non-finite/nonnegative/integer toItemIndex (${label})`, async () => {
    const { router, capture } = newRouter();
    await send(router, { type: 'movePinnedItem', sourcePath: '/a', toItemIndex } as never);
    const { notices, commands } = capture();
    assert.equal(notices.length, 1);
    assert.match(notices[0].notice, /Protocol defect: movePinnedItem/);
    assert.equal(commands.length, 0);
  });
}

test('movePinnedItem rejects an empty sourcePath as a protocol defect', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'movePinnedItem', sourcePath: '', toItemIndex: 0 } as never);
  const { notices, commands } = capture();
  assert.equal(notices.length, 1);
  assert.equal(commands.length, 0);
});

// ─── whole-group commands ──────────────────────────────────────────────────

test('dissolvePinnedGroup dispatches the atomic host command', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'dissolvePinnedGroup', sourcePath: '/a' });
  const { notices, commands } = capture();
  assert.deepEqual(notices, []);
  assert.equal(commands[0]?.cmdKind, 'DissolvePinnedGroup');
  assert.equal(commands[0]?.cmd.sourcePath, '/a');
});

test('dissolvePinnedGroup rejects an empty sourcePath', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'dissolvePinnedGroup', sourcePath: '' } as never);
  const { notices, commands } = capture();
  assert.equal(notices.length, 1);
  assert.match(notices[0].notice, /Protocol defect: dissolvePinnedGroup/);
  assert.equal(commands.length, 0);
});

test('unpinPinnedGroup dispatches the atomic host command', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'unpinPinnedGroup', sourcePath: '/a' });
  const { notices, commands } = capture();
  assert.deepEqual(notices, []);
  assert.equal(commands[0]?.cmdKind, 'UnpinPinnedGroup');
  assert.equal(commands[0]?.cmd.sourcePath, '/a');
});

test('unpinPinnedGroup rejects an empty sourcePath', async () => {
  const { router, capture } = newRouter();
  await send(router, { type: 'unpinPinnedGroup', sourcePath: '' } as never);
  const { notices, commands } = capture();
  assert.equal(notices.length, 1);
  assert.match(notices[0].notice, /Protocol defect: unpinPinnedGroup/);
  assert.equal(commands.length, 0);
});
