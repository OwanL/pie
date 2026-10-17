import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import test from 'node:test';

import type { RendererCommandContext, WebviewToHostMessage } from '../../../lib/protocol/index.js';

let uninstallVscodeMock: (() => void) | undefined;
let MessageRouterCtor: typeof import('../../conversation-state/message-router').MessageRouter;

function installVscodeMock(): () => void {
  const moduleWithLoad = Module as typeof Module & { _load: (...args: any[]) => unknown };
  const originalLoad = moduleWithLoad._load;
  moduleWithLoad._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === 'vscode') {
      return {
        EventEmitter: class<TValue> {
          private readonly emitter = new EventEmitter();
          readonly event = (listener: (value: TValue) => void) => {
            this.emitter.on('event', listener);
            return { dispose: () => this.emitter.off('event', listener) };
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => { moduleWithLoad._load = originalLoad; };
}

test.before(async () => {
  uninstallVscodeMock = installVscodeMock();
  ({ MessageRouter: MessageRouterCtor } = await import('../../conversation-state/message-router'));
});

test.after(() => uninstallVscodeMock?.());

function createRouter(options: {
  prepare?: (request: unknown) => Promise<{ url: string }>;
  ownerCurrent?: boolean;
} = {}) {
  const state = {
    sessions: {
      activeSessionPath: '/session-a.jsonl',
      openTabPaths: ['/session-a.jsonl'],
    },
    settings: {},
    transcript: { windowBySession: {} },
  };
  const targeted: Array<{ rendererId: string; message: unknown }> = [];
  const broadcast: unknown[] = [];
  const notices: unknown[] = [];
  const router = new MessageRouterCtor(
    (event) => notices.push(event),
    () => state as never,
    {} as never,
    {
      postImperative: (message: unknown) => broadcast.push(message),
      postImperativeToRenderer: (rendererId: string, message: unknown) => targeted.push({ rendererId, message }),
      isRendererOwnerCurrent: () => options.ownerCurrent ?? true,
      getViewGeneration: () => 4,
    } as never,
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
    { prepareLocalFileOpen: options.prepare } as never,
  );
  return { router, state, targeted, broadcast, notices };
}

const command: Extract<WebviewToHostMessage, { type: 'prepareLocalFileOpen' }> = {
  type: 'prepareLocalFileOpen',
  requestId: 'local-file-open:1',
  path: '/workspace/page.html',
  reference: 'page.html',
  workingDirectory: '/workspace',
};

const browserContext: RendererCommandContext = {
  rendererId: 'renderer-a',
  rendererGeneration: 7,
  kind: 'browser',
  hostLoopbackBrowser: true,
};

test('browser renderers receive a verified popup URL targeted to them only', async () => {
  let requested: unknown;
  const { router, targeted, broadcast, notices } = createRouter({
    prepare: async (request) => {
      requested = request;
      return { url: 'http://127.0.0.1:41575/' };
    },
  });
  await router.handle(command, browserContext);
  assert.deepEqual(requested, { path: command.path, reference: 'page.html', workingDirectory: '/workspace', openIn: 'popup' });
  assert.deepEqual(targeted, [{
    rendererId: browserContext.rendererId,
    message: { type: 'localFileOpenResult', requestId: command.requestId, status: 'ready', url: 'http://127.0.0.1:41575/', openIn: 'popup' },
  }]);
  assert.deepEqual([...broadcast, ...notices], [], 'local file open never broadcasts or notices');
});

test('vscode renderers open externally through the host adapter', async () => {
  let requested: { openIn?: string } | undefined;
  const { router, targeted } = createRouter({
    prepare: async (request) => {
      requested = request as { openIn?: string };
      return { url: 'http://127.0.0.1:41576/' };
    },
  });
  await router.handle(command, { ...browserContext, kind: 'vscode', hostLoopbackBrowser: undefined });
  assert.equal(requested?.openIn, 'external');
  assert.deepEqual(targeted[0]?.message, {
    type: 'localFileOpenResult', requestId: command.requestId, status: 'ready', url: 'http://127.0.0.1:41576/', openIn: 'external',
  });
});

test('a non-loopback browser renderer is refused without preparing any listener', async () => {
  let calls = 0;
  const { router, targeted } = createRouter({
    prepare: async () => { calls++; return { url: 'http://127.0.0.1:41577/' }; },
  });
  await router.handle(command, { ...browserContext, hostLoopbackBrowser: false });
  assert.equal(calls, 0, 'no listener is ever started for a remote browser');
  assert.deepEqual(targeted, [{
    rendererId: browserContext.rendererId,
    message: {
      type: 'localFileOpenResult', requestId: command.requestId, status: 'unavailable',
      error: 'Local files can be prepared only for a browser connected to this machine.',
    },
  }]);
});

test('failures answer the initiating renderer as unavailable, owners are fenced twice', async () => {
  const failing = createRouter({ prepare: async () => { throw new Error('Could not find file "page.html".'); } });
  await failing.router.handle(command, browserContext);
  assert.deepEqual(failing.targeted, [{
    rendererId: browserContext.rendererId,
    message: {
      type: 'localFileOpenResult', requestId: command.requestId, status: 'unavailable',
      error: 'Could not find file "page.html".',
    },
  }]);

  const missingSeam = createRouter();
  await missingSeam.router.handle(command, browserContext);
  assert.equal((missingSeam.targeted[0]?.message as { status: string }).status, 'unavailable');

  const stale = createRouter({ ownerCurrent: false, prepare: async () => { throw new Error('never called'); } });
  await stale.router.handle(command, browserContext);
  assert.deepEqual(stale.targeted, [], 'replaced owners receive nothing');

  let replaced = false;
  const options = { ownerCurrent: true, prepare: async () => { options.ownerCurrent = false; replaced = true; return { url: 'http://127.0.0.1:1/' }; } };
  const replacedRouter = createRouter(options);
  await replacedRouter.router.handle(command, browserContext);
  assert.equal(replaced, true);
  assert.deepEqual(replacedRouter.targeted, [], 'completion after replacement is discarded');
});