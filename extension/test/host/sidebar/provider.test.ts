import test from 'node:test';
import assert from 'node:assert/strict';
import { Module } from 'node:module';

import type { ViewState, WebviewToHostMessage } from '../../../src/shared/protocol';
import type { StateDeliveryClock } from '../../../src/host/sidebar/state-delivery-controller';

const NodeModule = Module as unknown as { _load(request: string, ...rest: unknown[]): unknown };
const originalLoad = NodeModule._load.bind(NodeModule);

const watcher = {
  onDidChange: () => ({ dispose() {} }),
  onDidCreate: () => ({ dispose() {} }),
  onDidDelete: () => ({ dispose() {} }),
  dispose() {},
};
const vscodeMock = {
  workspace: { createFileSystemWatcher: () => watcher },
  RelativePattern: class { constructor(..._args: unknown[]) {} },
  Uri: {
    file: (fsPath: string) => ({ fsPath, path: fsPath, toString: () => fsPath }),
    joinPath: (_base: unknown, ...parts: string[]) => ({ fsPath: parts.join('/'), toString: () => parts.join('/') }),
  },
  commands: { executeCommand: async () => undefined },
  window: { createOutputChannel: () => undefined },
};

let SidebarViewProvider: typeof import('../../../src/host/sidebar/provider').SidebarViewProvider;

test.before(async () => {
  NodeModule._load = (request: string, ...rest: unknown[]) => {
    if (request === 'vscode') return vscodeMock;
    return originalLoad(request, ...rest);
  };
  try {
    ({ SidebarViewProvider } = await import('../../../src/host/sidebar/provider'));
  } finally {
    NodeModule._load = originalLoad;
  }
});

test.after(() => { NodeModule._load = originalLoad; });

class FakeClock implements StateDeliveryClock {
  private nowValue = 0;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.nowValue; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowValue + delayMs, callback });
    return id;
  }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advance(ms: number): void {
    this.nowValue += ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.nowValue);
      if (due.length === 0) return;
      for (const [id, timer] of due) {
        if (this.timers.delete(id)) timer.callback();
      }
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function state(): ViewState {
  return {
    activeSession: null,
    busy: false,
    prepassPhase: 'idle',
    retryStatus: null,
    transcript: [],
  } as unknown as ViewState;
}

type StateMessage = Extract<import('../../../src/shared/protocol').HostToWebviewMessage, { type: 'state' }>;

class FakeView {
  visible = true;
  private receive?: (message: WebviewToHostMessage) => void;
  private visibility?: () => void;
  private disposeHandler?: () => void;
  readonly posted: import('../../../src/shared/protocol').HostToWebviewMessage[] = [];
  readonly stateOutcomes: Array<boolean | Promise<boolean>> = [];
  readonly imperativeOutcomes: Array<boolean | Promise<boolean>> = [];
  showCalls = 0;
  webview = {
    options: {},
    html: '',
    cspSource: 'test',
    asWebviewUri: (uri: unknown) => uri,
    postMessage: (message: import('../../../src/shared/protocol').HostToWebviewMessage) => {
      this.posted.push(message);
      if (message.type === 'state') return this.stateOutcomes.shift() ?? true;
      return this.imperativeOutcomes.shift() ?? true;
    },
    onDidReceiveMessage: (handler: (message: WebviewToHostMessage) => void) => {
      this.receive = handler;
      return { dispose: () => { if (this.receive === handler) this.receive = undefined; } };
    },
  };
  onDidChangeVisibility(handler: () => void) {
    this.visibility = handler;
    return { dispose: () => { if (this.visibility === handler) this.visibility = undefined; } };
  }
  onDidDispose(handler: () => void) {
    this.disposeHandler = handler;
    return { dispose: () => { if (this.disposeHandler === handler) this.disposeHandler = undefined; } };
  }
  show() { this.showCalls += 1; }
  send(message: WebviewToHostMessage) { this.receive?.(message); }
  setVisible(value: boolean) { this.visible = value; this.visibility?.(); }
  disposeView() { this.disposeHandler?.(); }
}

function createProvider(
  clock: FakeClock,
  routed: WebviewToHostMessage[],
  assetResolutions?: Array<string | Promise<string>>,
) {
  let assetCount = 0;
  const provider = new SidebarViewProvider(
    { extensionPath: '/extension', extensionUri: {} } as never,
    () => state(),
    (message) => routed.push(message),
    () => 0,
    {
      clock,
      getRoots: () => [],
      resolveAssets: async () => {
        const resolution = assetResolutions?.[assetCount] ?? `<html>${assetCount}</html>`;
        assetCount += 1;
        const html = typeof resolution === 'string' ? resolution : await resolution;
        return { html, assetVersion: 'v1' };
      },
      settlementTimeoutMs: 10,
      commitTimeoutMs: 100,
      retryDelayMs: 5,
      maxRetryAttempts: 2,
      acceptedLedgerCapacity: 8,
    },
  );
  return { provider, getAssetCount: () => assetCount };
}

async function resolveReady(provider: InstanceType<typeof SidebarViewProvider>, view: FakeView): Promise<void> {
  await provider.resolveWebviewView(view as never, {} as never, {} as never);
  view.send({
    type: 'ready',
    assetVersion: 'v1',
    viewGeneration: provider.getDebugState().viewGeneration,
  });
  await settle();
}

function stateMessages(view: FakeView): StateMessage[] {
  return view.posted.filter((message): message is StateMessage => message.type === 'state');
}

test('provider delegates state posts to one serialized lazy controller operation', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { provider } = createProvider(clock, routed);
  const view = new FakeView();
  const first = deferred<boolean>();
  view.stateOutcomes.push(first.promise, true);
  await resolveReady(provider, view);

  provider.postState();
  provider.postState();
  provider.postState();
  assert.equal(stateMessages(view).length, 1);
  first.resolve(true);
  await settle();
  const firstMessage = stateMessages(view)[0]!;
  view.send({
    type: 'transcriptCommitted',
    payload: {
      revision: firstMessage.revision,
      viewGeneration: firstMessage.viewGeneration,
      identity: firstMessage.expectedTranscriptIdentity,
      mountGeneration: 1,
      evidence: 'displayed',
    },
  });
  await settle();

  const messages = stateMessages(view);
  assert.equal(messages.length, 2);
  assert.ok(messages[1].revision > messages[0].revision);
  assert.equal(messages[0].viewGeneration, messages[1].viewGeneration);
  assert.ok(messages.every((message) => message.expectedTranscriptIdentity.length > 0));
  provider.dispose();
});

test('replacement view invalidates a late old settlement and posts a fresh generation', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { provider } = createProvider(clock, routed);
  const oldView = new FakeView();
  const oldPost = deferred<boolean>();
  oldView.stateOutcomes.push(oldPost.promise);
  await resolveReady(provider, oldView);
  provider.postState();
  const oldMessage = stateMessages(oldView)[0];

  const replacement = new FakeView();
  replacement.stateOutcomes.push(true);
  await resolveReady(provider, replacement);
  provider.postState();
  await settle();
  oldPost.resolve(true);
  await settle();

  const replacementMessage = stateMessages(replacement).at(-1)!;
  assert.ok(replacementMessage.viewGeneration > oldMessage.viewGeneration);
  assert.equal(provider.getDebugState().globalRevision, replacementMessage.revision);
  provider.dispose();
});

test('provider consumes receipt/app/transcript/paint evidence and advances commit only on matching identity', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { provider } = createProvider(clock, routed);
  const view = new FakeView();
  view.stateOutcomes.push(true);
  await resolveReady(provider, view);
  provider.postState();
  await settle();
  const message = stateMessages(view).at(-1)!;

  view.send({ type: 'stateReceived', payload: { revision: message.revision, viewGeneration: message.viewGeneration, snapshotBytes: 20 } });
  view.send({ type: 'appCommitted', payload: { revision: message.revision, viewGeneration: message.viewGeneration, surface: 'transcript' } });
  view.send({ type: 'transcriptCommitted', payload: { revision: message.revision, viewGeneration: message.viewGeneration, identity: 'mismatch', mountGeneration: 1, evidence: 'displayed' } });
  assert.equal(provider.getDebugState().lastStateAppliedRevision, 0);
  view.send({ type: 'transcriptCommitted', payload: { revision: message.revision, viewGeneration: message.viewGeneration, identity: message.expectedTranscriptIdentity, mountGeneration: 1, evidence: 'displayed' } });
  view.send({ type: 'paintObserved', payload: { revision: message.revision, viewGeneration: message.viewGeneration, identity: message.expectedTranscriptIdentity, mountGeneration: 1, evidence: 'displayed', latencyMs: 1 } });

  assert.equal(provider.getDebugState().lastStateAppliedRevision, message.revision);
  assert.deepEqual(routed.map((entry) => entry.type), ['ready'], 'render evidence is provider-owned, not dual-routed');
  provider.dispose();
});

test('repeated transcript-commit timeouts resnapshot then escalate through provider recovery', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { provider, getAssetCount } = createProvider(clock, routed, ['initial', 'commit-timeout-reload']);
  const view = new FakeView();
  await resolveReady(provider, view);
  const initialPosts = stateMessages(view).length;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    clock.advance(100);
    await settle();
  }

  assert.ok(stateMessages(view).length >= initialPosts + 4, 'provisional commit retries resnapshot current state');
  assert.equal(getAssetCount(), 2, 'the bounded retry episode escalates to one reload');
  assert.equal(provider.getDebugState().webviewReady, false);
  provider.dispose();
});

test('throttled commit-timeout reload still rotates delivery generation for bounded in-process recovery', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { provider, getAssetCount } = createProvider(clock, routed, ['initial', 'reload-1', 'reload-2']);
  const view = new FakeView();
  await resolveReady(provider, view);

  for (let episode = 0; episode < 2; episode += 1) {
    for (let timeout = 0; timeout < 5; timeout += 1) {
      clock.advance(100);
      await settle();
    }
    view.send({
      type: 'ready', assetVersion: 'v1',
      viewGeneration: provider.getDebugState().viewGeneration,
    });
    await settle();
  }

  const beforeThrottle = provider.getDebugState().viewGeneration;
  for (let timeout = 0; timeout < 5; timeout += 1) {
    clock.advance(100);
    await settle();
  }

  assert.equal(getAssetCount(), 3, 'third recovery is throttled instead of reloading assets');
  assert.ok(provider.getDebugState().viewGeneration > beforeThrottle, 'throttled recovery invalidates stale settlements');
  const circuitGeneration = provider.getDebugState().viewGeneration;
  for (let timeout = 0; timeout < 20; timeout += 1) {
    clock.advance(100);
    await settle();
  }
  assert.equal(getAssetCount(), 3, 'open circuit prevents periodic starting-page reloads');
  assert.equal(provider.getDebugState().viewGeneration, circuitGeneration, 'open circuit stops generation churn');
  provider.dispose();
});

test('typed current render failure immediately reloads once and rotates generation', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { provider, getAssetCount } = createProvider(clock, routed, ['initial', 'reloaded']);
  const view = new FakeView();
  view.stateOutcomes.push(true);
  await resolveReady(provider, view);
  provider.postState();
  await settle();
  const message = stateMessages(view).at(-1)!;
  const generationBefore = provider.getDebugState().viewGeneration;

  view.send({
    type: 'renderFailure',
    payload: {
      viewGeneration: message.viewGeneration,
      revision: message.revision,
      surface: 'transcript',
      classification: 'component_error',
    },
  });
  await settle();

  assert.equal(getAssetCount(), 2);
  assert.match(view.webview.html, /pie-view-generation" content="3" \/>reloaded/);
  assert.ok(provider.getDebugState().viewGeneration > generationBefore);
  assert.equal(provider.getDebugState().webviewReady, false);
  provider.dispose();
});

test('a delayed replacement ignores stale or missing readiness generations until its exact handshake', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const delayedReload = deferred<string>();
  const { provider } = createProvider(clock, routed, [
    '<html><head></head><body>initial</body></html>',
    delayedReload.promise,
  ]);
  const view = new FakeView();
  await resolveReady(provider, view);
  const oldMessage = stateMessages(view).at(-1)!;
  assert.match(view.webview.html, new RegExp(`pie-view-generation" content="${oldMessage.viewGeneration}"`));

  view.send({
    type: 'renderFailure',
    payload: {
      viewGeneration: oldMessage.viewGeneration,
      revision: oldMessage.revision,
      surface: 'transcript',
      classification: 'component_error',
    },
  });
  await settle();
  const replacementGeneration = provider.getDebugState().viewGeneration;
  assert.ok(replacementGeneration > oldMessage.viewGeneration);
  assert.equal(provider.getDebugState().webviewReady, false);

  view.send({ type: 'refreshState', assetVersion: 'v1', viewGeneration: oldMessage.viewGeneration });
  view.send({ type: 'ready', assetVersion: 'v1' });
  await settle();
  assert.equal(provider.getDebugState().webviewReady, false, 'old/missing handshakes cannot adopt a replacement');

  delayedReload.resolve('<html><head></head><body>replacement</body></html>');
  await settle();
  assert.match(view.webview.html, new RegExp(`pie-view-generation" content="${replacementGeneration}"`));

  view.send({ type: 'newSession', viewGeneration: oldMessage.viewGeneration });
  view.send({ type: 'newSession' });
  assert.equal(routed.filter((message) => message.type === 'newSession').length, 0, 'stale/unstamped controls remain suppressed during replacement');
  view.send({ type: 'newSession', viewGeneration: replacementGeneration });
  assert.equal(routed.filter((message) => message.type === 'newSession').length, 1, 'the replacement renderer remains interactive before its ready handshake');

  view.send({ type: 'ready', assetVersion: 'v1', viewGeneration: replacementGeneration });
  await settle();
  assert.equal(provider.getDebugState().webviewReady, true);
  provider.dispose();
});

test('hidden provider retains dirty state and posts a fresh full snapshot on reveal', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { provider } = createProvider(clock, routed);
  const view = new FakeView();
  await resolveReady(provider, view);
  const baselineMessage = stateMessages(view).at(-1)!;
  view.send({
    type: 'transcriptCommitted',
    payload: {
      revision: baselineMessage.revision,
      viewGeneration: baselineMessage.viewGeneration,
      identity: baselineMessage.expectedTranscriptIdentity,
      mountGeneration: 1,
      evidence: 'displayed',
    },
  });
  const baselinePosts = stateMessages(view).length;
  view.setVisible(false);
  provider.scheduleState();
  assert.equal(provider.getDebugState().globalDirty, true);
  assert.equal(stateMessages(view).length, baselinePosts);

  view.stateOutcomes.push(true);
  view.setVisible(true);
  await settle();
  assert.equal(stateMessages(view).length, baselinePosts + 1);
  provider.dispose();
});

test('an unaccepted sendRejected post enters readiness recovery and retries after a successful probe', async () => {
  const clock = new FakeClock();
  const routed: WebviewToHostMessage[] = [];
  const { provider } = createProvider(clock, routed);
  const view = new FakeView();
  await resolveReady(provider, view);
  const baselineMessage = stateMessages(view).at(-1)!;
  view.send({
    type: 'transcriptCommitted',
    payload: {
      revision: baselineMessage.revision,
      viewGeneration: baselineMessage.viewGeneration,
      identity: baselineMessage.expectedTranscriptIdentity,
      mountGeneration: 1,
      evidence: 'displayed',
    },
  });
  view.imperativeOutcomes.push(false, true);

  provider.postImperative({
    type: 'sendRejected',
    sessionPath: '/session/a',
    localId: 'local:rejected',
    text: 'restore me',
  });
  await settle();

  assert.equal(provider.getDebugState().webviewReady, false, 'a rejected imperative invalidates stale readiness');
  assert.equal(provider.getDebugState().globalDirty, true, 'recovery retains authoritative snapshot intent');

  // Exercise the same serialized probe path the autonomous readiness timer
  // invokes, without sleeping for its production interval.
  const accepted = await (provider as unknown as {
    delivery: { probe(): Promise<boolean> };
  }).delivery.probe();
  await settle();

  assert.equal(accepted, true);
  assert.equal(provider.getDebugState().webviewReady, true);
  assert.equal(
    view.posted.filter((message) => message.type === 'sendRejected').length,
    2,
    'the draft-restoration imperative is retried exactly once after readiness recovers',
  );
  provider.dispose();
});
