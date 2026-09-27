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
  activeSessionPath?: string | null;
  openTabPaths?: string[];
  preview?: (request: { path: string; reference?: string; workingDirectory?: string }) => Promise<unknown>;
  ownerCurrent?: boolean;
} = {}) {
  const state = {
    sessions: {
      activeSessionPath: options.activeSessionPath ?? '/session-a.jsonl',
      openTabPaths: options.openTabPaths ?? ['/session-a.jsonl'],
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
    } as never,
    () => undefined,
    (text: string) => ({ name: text, isPlaceholder: false }),
    () => false,
    { previewImageFile: options.preview ?? (async () => undefined) } as never,
  );
  return { router, state, targeted, broadcast, notices };
}

const request = {
  type: 'requestImagePreview',
  requestId: 'image-preview:1',
  sessionPath: '/session-a.jsonl',
  path: '/tmp/agent-image.png',
  reference: '/tmp/agent-image.png',
  workingDirectory: '/workspace',
  viewGeneration: 4,
} as unknown as WebviewToHostMessage;

const context: RendererCommandContext = {
  rendererId: 'renderer-a',
  rendererGeneration: 7,
  kind: 'browser',
};

test('image preview replies only to the requesting current renderer', async () => {
  const reads: unknown[] = [];
  const { router, targeted, broadcast, notices } = createRouter({
    preview: async (options) => {
      reads.push(options);
      return { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    },
  });

  await router.handle(request, context);

  assert.deepEqual(reads, [{
    path: '/tmp/agent-image.png',
    reference: '/tmp/agent-image.png',
    workingDirectory: '/workspace',
  }]);
  assert.equal(targeted.length, 1);
  assert.equal(targeted[0].rendererId, 'renderer-a');
  assert.deepEqual(targeted[0].message, {
    type: 'imagePreviewResult',
    requestId: 'image-preview:1',
    sessionPath: '/session-a.jsonl',
    viewGeneration: 4,
    status: 'ready',
    data: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' },
  });
  assert.deepEqual(broadcast, []);
  assert.deepEqual(notices, []);
});

test('image preview requests without renderer ownership fail closed', async () => {
  let reads = 0;
  const harness = createRouter({
    preview: async () => {
      reads += 1;
      return undefined;
    },
  });

  await harness.router.handle(request);

  assert.equal(reads, 0);
  assert.deepEqual(harness.targeted, []);
  assert.deepEqual(harness.broadcast, []);
});

test('image preview reads are limited to two in-flight requests per renderer', async () => {
  const deferred: Array<(result: unknown) => void> = [];
  const { router, targeted } = createRouter({
    preview: () => new Promise((resolve) => deferred.push(resolve)),
  });
  const first = router.handle({ ...request, requestId: 'preview-1' }, context);
  const second = router.handle({ ...request, requestId: 'preview-2' }, context);
  const third = router.handle({ ...request, requestId: 'preview-3' }, context);
  await third;

  assert.equal(deferred.length, 2);
  assert.equal((targeted[0]?.message as { requestId: string; status: string })?.requestId, 'preview-3');
  assert.equal((targeted[0]?.message as { status: string })?.status, 'unavailable');
  deferred.forEach((resolve) => resolve(undefined));
  await Promise.all([first, second]);
});

test('a tab change while reading suppresses the late renderer result', async () => {
  let harness!: ReturnType<typeof createRouter>;
  harness = createRouter({
    preview: async () => {
      harness.state.sessions.activeSessionPath = '/session-b.jsonl';
      return { mimeType: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=' };
    },
  });

  await harness.router.handle(request, context);

  assert.deepEqual(harness.targeted, []);
  assert.deepEqual(harness.broadcast, []);
  assert.deepEqual(harness.notices, []);
});

test('inactive, stale-owner, and unavailable requests never notify or broadcast', async () => {
  const inactive = createRouter({ activeSessionPath: '/session-b.jsonl' });
  await inactive.router.handle(request, context);
  assert.deepEqual(inactive.targeted, []);
  assert.deepEqual(inactive.notices, []);

  const stale = createRouter({ ownerCurrent: false });
  await stale.router.handle(request, context);
  assert.deepEqual(stale.targeted, []);
  assert.deepEqual(stale.notices, []);

  const unavailable = createRouter();
  await unavailable.router.handle(request, context);
  assert.equal(unavailable.targeted.length, 1);
  assert.equal((unavailable.targeted[0].message as { status: string }).status, 'unavailable');
  assert.deepEqual(unavailable.broadcast, []);
  assert.deepEqual(unavailable.notices, []);

  const invalidPayload = createRouter({
    preview: async () => ({ mimeType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }),
  });
  await invalidPayload.router.handle(request, context);
  assert.equal((invalidPayload.targeted[0]?.message as { status: string })?.status, 'unavailable');
});
