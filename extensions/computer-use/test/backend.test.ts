import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pngjs from 'pngjs';

import { ComputerBackend } from '../src/backend.mjs';
import { pngDimensions } from '../src/image.mjs';

const { PNG } = pngjs;

async function writePng(filePath: string, width: number, height: number) {
  const image = new PNG({ width, height }); image.data.fill(255);
  await writeFile(filePath, PNG.sync.write(image));
}

function tool(payload: unknown) { return { isError: false, structuredJson: JSON.stringify(payload), rawJson: '{}', images: [] }; }
function backendFixture(elements = [{ role: 'button', label: 'Go', frame: { x: 300, y: 200, w: 20, h: 10 }, element_token: 'tok', element_index: 7 }], tree = 'tree', cursor = { x: 0, y: 0 }) {
  const calls: Array<{ name: string; args: any }> = [];
  const driver = {
    async callTool(name: string, json: string) {
      const args = JSON.parse(json); calls.push({ name, args });
      if (name === 'list_windows') return tool({ _legacy_windows: [{ pid: 10, window_id: 99, title: 'Editor', app_name: 'editor.exe', z_index: 0, bounds: { x: 175, y: 87.5, width: 700, height: 350 }, minimized: false, is_on_screen: true }] });
      if (name === 'get_window_state') return tool({ screenshot_width: 400, screenshot_height: 200, element_count: elements.length, elements, tree_markdown: tree });
      if (name === 'get_screen_size') return tool({ width: 1920, height: 1080 });
      return tool({ active: true });
    },
    async shutdown() {}, uniffiDestroy() {},
  };
  const positions: Array<{ x: number; y: number }> = [];
  const nut = {
    Key: { W: 1, LeftControl: 2, A: 3 }, Button: { LEFT: 1, MIDDLE: 2, RIGHT: 3 },
    Region: class { left: number; top: number; width: number; height: number; constructor(left: number, top: number, width: number, height: number) { this.left = left; this.top = top; this.width = width; this.height = height; } },
    FileType: { PNG: '.png' },
    keyboard: { config: {}, async pressKey() {}, async releaseKey() {}, async type() {} },
    mouse: {
      config: {}, async setPosition(point: { x: number; y: number }) { positions.push(point); }, async getPosition() { return cursor; },
      async pressButton() {}, async releaseButton() {}, async click() {}, async doubleClick() {}, async scrollDown() {}, async scrollUp() {}, async scrollLeft() {}, async scrollRight() {},
    },
    screen: {
      async width() { return 1000; }, async height() { return 600; },
      async captureRegion(fileName: string, region: { width: number; height: number }, fileFormat: string, filePath: string) {
        const out = path.join(filePath, `${path.parse(fileName).name}${fileFormat || '.png'}`);
        await writePng(out, region.width, region.height); return out;
      },
    },
    async getWindows() { return [{ windowHandle: 99, async getRegion() { return { left: 100, top: 50, width: 400, height: 200 }; } }]; },
    async getActiveWindow() { return { windowHandle: 99 }; },
  };
  return { backend: new ComputerBackend({ driver, nut }), calls, positions };
}

async function opened(fixture: ReturnType<typeof backendFixture>, artifactDir: string) {
  return await fixture.backend.open({ sessionId: 's', selector: { kind: 'foreground' }, artifactDir });
}

function launchFixture(launchPayload: unknown, listedWindows: unknown[] | unknown[][]) {
  const calls: Array<{ name: string; args: any }> = []; let listIndex = 0; let now = 0;
  const listed = () => Array.isArray(listedWindows[0]) ? (listedWindows[Math.min(listIndex++, listedWindows.length - 1)] as unknown[]) : listedWindows as unknown[];
  const driver = {
    async callTool(name: string, json: string) {
      const args = JSON.parse(json); calls.push({ name, args });
      if (name === 'launch_app') return tool(launchPayload);
      if (name === 'list_windows') return tool({ _legacy_windows: listed() });
      if (name === 'get_screen_size') return tool({ width: 1000, height: 600 });
      return tool({ active: true });
    },
    async shutdown() {}, uniffiDestroy() {},
  };
  const nut = {
    Key: {}, Button: {}, keyboard: { config: {} }, mouse: { config: {} },
    screen: { async width() { return 1000; }, async height() { return 600; } },
    async getWindows() {
      const records = Array.isArray(listedWindows[0]) ? listedWindows.flat() : listedWindows;
      return [...new Map(records.map((window: any) => [window.window_id, window])).values()]
        .map((window: any) => ({ windowHandle: window.window_id, async getRegion() { return { left: 10, top: 20, width: 300, height: 200 }; } }));
    },
  };
  return { backend: new ComputerBackend({ driver, nut, now: () => now, sleep: async (ms: number) => { now += ms; } }), calls, get now() { return now; } };
}

// Simulates successful or accessibility-failed Cua window state independently
// from NutJS foreground visible-region capture. `captureRegion` controls the NutJS outcome.
function timeoutFixture(options: {
  captureRegion?: 'png' | 'throw'; uiaPayload?: any;
  nutRegion?: { left: number; top: number; width: number; height: number };
  nutRegionAfterCapture?: { left: number; top: number; width: number; height: number };
  activeAfterCapture?: number; activeAfterDesktopCapture?: number; mainDisplay?: { width: number; height: number };
  errorCode?: string; errorMessage?: string; minimized?: boolean; onScreen?: boolean;
} = {}) {
  const calls: Array<{ name: string; args: any }> = []; let activeWindow = 99; let windowAvailable = true; let invalidDesktopPng = false;
  let nutRegion = options.nutRegion ?? { left: 100, top: 50, width: 400, height: 200 };
  const mainDisplay = options.mainDisplay ?? { width: 1000, height: 600 };
  const driver = {
    async callTool(name: string, json: string) {
      const args = JSON.parse(json); calls.push({ name, args });
      if (name === 'list_windows') return tool({ _legacy_windows: windowAvailable ? [{ pid: 10, window_id: 99, title: 'Editor', app_name: 'editor.exe', z_index: 0, bounds: { x: 175, y: 87.5, width: 700, height: 350 }, minimized: options.minimized ?? false, is_on_screen: options.onScreen ?? true }] : [] });
      if (name === 'get_screen_size') return tool({ width: 1920, height: 1080 });
      if (name === 'get_window_state') {
        if (options.uiaPayload !== undefined) return tool(options.uiaPayload);
        const error = new Error(options.errorMessage ?? 'get_window_state timed out'); (error as any).code = options.errorCode ?? 'CUA_TIMEOUT'; throw error;
      }
      if (name === 'get_desktop_state') {
        if (args.screenshot_out_file) {
          if (invalidDesktopPng) await writeFile(args.screenshot_out_file, 'not-a-png');
          else await writePng(args.screenshot_out_file, 1000, 600);
        }
        if (options.activeAfterDesktopCapture !== undefined) activeWindow = options.activeAfterDesktopCapture;
        return tool({ screenshot_width: invalidDesktopPng ? 0 : 1000, screenshot_height: invalidDesktopPng ? 0 : 600, elements: [], tree_markdown: '' });
      }
      return tool({ active: true });
    },
    async shutdown() {}, uniffiDestroy() {},
  };
  const positions: Array<{ x: number; y: number }> = [];
  const nut = {
    Key: { W: 1, LeftControl: 2, A: 3 }, Button: { LEFT: 1, MIDDLE: 2, RIGHT: 3 },
    Region: class { left: number; top: number; width: number; height: number; constructor(left: number, top: number, width: number, height: number) { this.left = left; this.top = top; this.width = width; this.height = height; } },
    FileType: { PNG: '.png', JPG: '.jpg' },
    keyboard: { config: {}, async pressKey() {}, async releaseKey() {}, async type() {} },
    mouse: {
      config: {}, async setPosition(point: { x: number; y: number }) { positions.push(point); }, async getPosition() { return { x: 0, y: 0 }; },
      async pressButton() {}, async releaseButton() {}, async click() {}, async doubleClick() {}, async scrollDown() {}, async scrollUp() {}, async scrollLeft() {}, async scrollRight() {},
    },
    screen: {
      async width() { return mainDisplay.width; }, async height() { return mainDisplay.height; },
      async captureRegion(fileName: string, region: { width: number; height: number }, fileFormat: string, filePath: string) {
        calls.push({ name: 'captureRegion', args: { fileName, region, fileFormat, filePath } });
        if (options.captureRegion === 'throw') throw new Error('captureRegion failed');
        const out = path.join(filePath, `${path.parse(fileName).name}${fileFormat || '.png'}`);
        await writePng(out, region.width, region.height);
        if (options.activeAfterCapture !== undefined) activeWindow = options.activeAfterCapture;
        if (options.nutRegionAfterCapture) nutRegion = options.nutRegionAfterCapture;
        return out;
      },
    },
    async getWindows() { return [{ windowHandle: 99, async getRegion() { return nutRegion; } }]; },
    async getActiveWindow() { return { windowHandle: activeWindow }; },
  };
  return {
    backend: new ComputerBackend({ driver, nut }), calls, positions,
    setActive(windowId: number) { activeWindow = windowId; }, setWindowAvailable(value: boolean) { windowAvailable = value; }, setInvalidDesktopPng(value: boolean) { invalidDesktopPng = value; },
    setRegion(region: { left: number; top: number; width: number; height: number }) { nutRegion = region; },
  };
}

function controlledFixture() {
  const calls: Array<{ name: string; args: any }> = []; const inputs: string[] = [];
  const failedKeyReleases = new Set<number>(); const failedButtonReleases = new Set<number>();
  let activeWindow = 99; let windowAvailable = true; let bringActivates = true; let bringThrows = false; let bringHangs = false; let nutFocusWindow = 99; let nativeFocusWindow = 99; let now = 0; let onType: (() => void) | undefined;
  let nutRegion = { left: 100, top: 50, width: 400, height: 200 };
  const record = { pid: 10, window_id: 99, title: 'Editor', app_name: 'editor.exe', bounds: { x: 100, y: 50, width: 400, height: 200 }, minimized: false, is_on_screen: true };
  const driver = {
    async callTool(name: string, json: string) {
      const args = JSON.parse(json); calls.push({ name, args });
      if (name === 'list_windows') return tool({ _legacy_windows: windowAvailable ? [record] : [] });
      if (name === 'bring_to_front') { if (bringHangs) return await new Promise(() => {}); if (bringThrows) throw new Error('bring_to_front failed'); if (bringActivates) activeWindow = 99; return tool({ active: true }); }
      if (name === 'get_screen_size') return tool({ width: 1000, height: 600 });
      if (name === 'get_window_state') return tool({ screenshot_width: 400, screenshot_height: 200, elements: [{ role: 'button', label: 'Go', frame: { x: 10, y: 10, w: 20, h: 10 } }] });
      return tool({ active: true });
    },
    async shutdown() { calls.push({ name: 'driver_shutdown', args: {} }); }, uniffiDestroy() {},
  };
  const nut = {
    Key: { W: 1, A: 2 }, Button: { LEFT: 1, MIDDLE: 2, RIGHT: 3 },
    keyboard: {
      config: {}, async pressKey(key: number) { inputs.push(`key_down:${key}`); }, async releaseKey(key: number) { inputs.push(`key_up:${key}`); if (failedKeyReleases.has(key)) throw new Error(`key release ${key} failed`); },
      async type(text: string) { inputs.push(`text:${text}`); onType?.(); },
    },
    mouse: {
      config: {}, async setPosition() { inputs.push('move'); }, async getPosition() { return { x: 0, y: 0 }; },
      async pressButton(button: number) { inputs.push(`button_down:${button}`); }, async releaseButton(button: number) { inputs.push(`button_up:${button}`); if (failedButtonReleases.has(button)) throw new Error(`button release ${button} failed`); },
      async click() { inputs.push('click'); }, async doubleClick() { inputs.push('double_click'); }, async scrollDown() { inputs.push('scroll'); }, async scrollUp() { inputs.push('scroll'); }, async scrollLeft() { inputs.push('scroll'); }, async scrollRight() { inputs.push('scroll'); },
    },
    screen: { async width() { return 1000; }, async height() { return 600; } },
    async getWindows() { return [{ windowHandle: 99, async restore() { calls.push({ name: 'nut_restore', args: { windowHandle: 99 } }); }, async focus() { calls.push({ name: 'nut_focus', args: { windowHandle: 99 } }); activeWindow = nutFocusWindow; }, async getRegion() { return nutRegion; } }]; },
    async getActiveWindow() { return { windowHandle: activeWindow }; },
  };
  return {
    backend: new ComputerBackend({
      driver, nut, now: () => now, sleep: async (ms: number) => { now += ms; }, focusCuaCallTimeoutMs: 5,
      nativeFocus: async () => { calls.push({ name: 'native_focus', args: { windowHandle: 99 } }); activeWindow = nativeFocusWindow; return activeWindow === 99; },
    }), calls, inputs,
    setActive(value: number) { activeWindow = value; }, setAvailable(value: boolean) { windowAvailable = value; },
    setBringActivates(value: boolean) { bringActivates = value; }, setBringThrows(value: boolean) { bringThrows = value; }, setBringHangs(value: boolean) { bringHangs = value; }, setNutFocusWindow(value: number) { nutFocusWindow = value; }, setNativeFocusWindow(value: number) { nativeFocusWindow = value; }, setOnType(value: (() => void) | undefined) { onType = value; },
    setRegion(value: { left: number; top: number; width: number; height: number }) { nutRegion = value; },
    failKeyReleases(...keys: number[]) { failedKeyReleases.clear(); for (const key of keys) failedKeyReleases.add(key); },
    failButtonReleases(...buttons: number[]) { failedButtonReleases.clear(); for (const button of buttons) failedButtonReleases.add(button); },
  };
}

async function openControlled(fixture: ReturnType<typeof controlledFixture>, artifactDir: string, sessionId = 's') {
  return await fixture.backend.open({ sessionId, selector: { kind: 'window_id', windowId: 99, pid: 10 }, artifactDir });
}

test('screenshot coordinates map per axis into NutJS logical desktop coordinates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-backend-'));
  try {
    const fixture = backendFixture(); const openedResult = await opened(fixture, dir);
    await fixture.backend.observe({ sessionId: 's', targetId: openedResult.targetId, screenshot: true, tree: true, state: false });
    await fixture.backend.act({ sessionId: 's', targetId: openedResult.targetId, revision: 1, input: { kind: 'move', target: { x: 200, y: 100 } } });
    assert.deepEqual(fixture.positions.at(-1), { x: 300, y: 150 });
    await fixture.backend.act({ sessionId: 's', targetId: openedResult.targetId, input: { kind: 'move', target: { x: -30, y: 20, scope: 'desktop' } } });
    assert.deepEqual(fixture.positions.at(-1), { x: -30, y: 20 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('semantic refs resolve to observed logical element centers and become stale on revision change', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-ref-'));
  try {
    const fixture = backendFixture(); const target = await opened(fixture, dir);
    const first = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: true, state: false });
    assert.equal(first.revision, 1); assert.match(first.elements[0].ref, /^e:[0-9a-f-]{36}:1:1:0$/);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'move', target: { ref: first.elements[0].ref } } });
    assert.deepEqual(fixture.positions.at(-1), { x: 310, y: 205 });
    await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: true, state: false });
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'move', target: { ref: first.elements[0].ref } } }), (error: any) => error.code === 'STALE_REFERENCE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('screenshot coordinates are revision-scoped while desktop coordinates remain valid', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-revision-'));
  try {
    const fixture = backendFixture(); const target = await opened(fixture, dir);
    const first = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: false });
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: first.revision, input: { kind: 'move', target: { x: 200, y: 100 } } });
    const second = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: false });
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: first.revision, input: { kind: 'move', target: { x: 200, y: 100 } } }), (error: any) => error.code === 'STALE_GEOMETRY');
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: second.revision, input: { kind: 'move', target: { x: 200, y: 100 } } });
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'move', target: { x: -30, y: 20, scope: 'desktop' } } });
    assert.deepEqual(fixture.positions.at(-1), { x: -30, y: 20 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('observations include a bounded NutJS desktop cursor', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-cursor-'));
  try {
    const fixture = backendFixture(undefined, 'tree', { x: 1200.4, y: -10 }); const target = await opened(fixture, dir);
    const result = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: false, state: false });
    assert.deepEqual(result.cursor, { x: 999, y: 0 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('observations are bounded to 250 elements and 32KiB across elements and tree', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-bound-'));
  try {
    const elements = Array.from({ length: 400 }, (_, i) => ({ role: 'item', label: `${i}-${'x'.repeat(500)}`, frame: { x: i, y: i, w: 1, h: 1 }, element_token: `t${i}`, element_index: i }));
    const fixture = backendFixture(elements, 'z'.repeat(40000)); const target = await opened(fixture, dir);
    const result = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: true, state: false });
    assert.ok(result.elements.length <= 250); assert.equal(result.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result.elements)) + Buffer.byteLength(result.tree) <= 32 * 1024 + 256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('path launch ignores incomplete launch window records and registers only the exact canonical PID/HWND', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-launch-correlation-'));
  try {
    const fixture = launchFixture(
      { pid: 42, windows: [{ window_id: 777, title: 'Unsafe incomplete launch record' }] },
      [{ pid: 42, window_id: 99, title: 'Launched editor', app_name: 'editor.exe', bounds: { x: 10, y: 20, width: 300, height: 200 } }, { pid: 7, window_id: 70, title: 'Other app', app_name: 'other.exe' }],
    );
    const result = await fixture.backend.open({ sessionId: 's', selector: { kind: 'path', path: 'editor.exe' }, artifactDir: dir });
    assert.equal(result.targetId, 'window:42:99');
    assert.equal(result.target.pid, 42); assert.equal(result.target.windowId, 99);
    assert.ok(fixture.calls.filter(({ name }) => name === 'list_windows').every(({ args }) => !('pid' in args)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('path launch refuses a missing launch PID rather than targeting an unrelated window', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-launch-no-pid-'));
  try {
    const fixture = launchFixture({ windows: [{ window_id: 777, title: 'Incomplete' }] }, [{ pid: 7, window_id: 70, title: 'Other app', app_name: 'other.exe' }]);
    await assert.rejects(
      () => fixture.backend.open({ sessionId: 's', selector: { kind: 'path', path: 'editor.exe' }, artifactDir: dir }),
      (error: any) => error.code === 'LAUNCH_UNCORRELATED',
    );
    assert.equal(fixture.calls.some(({ name }) => name === 'start_session'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('open refuses a matched window without an exact positive PID and HWND', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-target-correlation-'));
  try {
    const fixture = launchFixture({ pid: 42 }, [{ pid: 42, title: 'Missing HWND', app_name: 'editor.exe' }]);
    await assert.rejects(
      () => fixture.backend.open({ sessionId: 's', selector: { kind: 'path', path: 'editor.exe' }, artifactDir: dir }),
      (error: any) => error.code === 'TARGET_UNCORRELATED',
    );
    assert.equal(fixture.calls.some(({ name }) => name === 'start_session'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('open uses Cua for discovery/session and focus uses Cua bring_to_front', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-focus-'));
  try {
    const fixture = backendFixture(); const target = await opened(fixture, dir);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'focus' } });
    assert.ok(fixture.calls.some((call) => call.name === 'list_windows'));
    assert.ok(fixture.calls.some((call) => call.name === 'start_session'));
    assert.ok(fixture.calls.some((call) => call.name === 'bring_to_front'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('close releases runtime ownership without closing the user application unless explicit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-close-'));
  try {
    const fixture = backendFixture(); const first = await opened(fixture, dir);
    const ordinary = await fixture.backend.close({ sessionId: 's', targetId: first.targetId, closeApplication: false });
    assert.equal(ordinary.closedApplication, false); assert.equal(fixture.calls.some((call) => call.name === 'kill_app'), false);
    const second = await opened(fixture, dir);
    const explicit = await fixture.backend.close({ sessionId: 's', targetId: second.targetId, closeApplication: true });
    assert.equal(explicit.closedApplication, true); assert.equal(fixture.calls.filter((call) => call.name === 'kill_app').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('partial pid/title/process selectors reject ambiguous matches', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-ambiguous-selector-'));
  try {
    const windows = [
      { pid: 10, window_id: 99, title: 'Editor one', app_name: 'editor.exe' },
      { pid: 10, window_id: 100, title: 'Editor two', app_name: 'editor-helper.exe' },
    ];
    for (const selector of [{ kind: 'pid', pid: 10 }, { kind: 'title', title: 'Editor' }, { kind: 'process', process: 'editor' }]) {
      const fixture = launchFixture({}, windows);
      await assert.rejects(() => fixture.backend.open({ sessionId: selector.kind, selector, artifactDir: dir }), (error: any) => error.code === 'AMBIGUOUS_TARGET' && error.retryable === true);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('launched targets require a unique PID/HWND stable for at least 500ms', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-launch-stable-'));
  try {
    const oldWindow = { pid: 42, window_id: 98, title: 'Splash', app_name: 'editor.exe' };
    const finalWindow = { pid: 42, window_id: 99, title: 'Editor', app_name: 'editor.exe' };
    const fixture = launchFixture({ pid: 42 }, [[], ...Array(4).fill([oldWindow]), ...Array(8).fill([finalWindow])]);
    const result = await fixture.backend.open({ sessionId: 'stable', selector: { kind: 'path', path: 'editor.exe' }, artifactDir: dir });
    assert.equal(result.targetId, 'window:42:99');
    assert.ok(fixture.now >= 900, `stability polling stopped too early at ${fixture.now}ms`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('launched targets reject multiple persistent canonical windows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-launch-ambiguous-'));
  try {
    const multiple = [{ pid: 42, window_id: 98, title: 'One' }, { pid: 42, window_id: 99, title: 'Two' }];
    const fixture = launchFixture({ pid: 42 }, [[], multiple]);
    await assert.rejects(() => fixture.backend.open({ sessionId: 's', selector: { kind: 'path', path: 'editor.exe' }, artifactDir: dir }), (error: any) => error.code === 'AMBIGUOUS_TARGET');
    assert.ok(fixture.now >= 600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('window move or resize raises retryable STALE_GEOMETRY before physical delivery, and observe refreshes geometry', async () => {
  for (const changedRegion of [
    { left: 120, top: 70, width: 400, height: 200 },
    { left: 100, top: 50, width: 450, height: 240 },
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'computer-stale-geometry-'));
    try {
      const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
      fixture.setRegion(changedRegion);
      await assert.rejects(
        () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'blocked' } }),
        (error: any) => error.code === 'STALE_GEOMETRY' && error.retryable === true,
      );
      assert.deepEqual(fixture.inputs, [], 'no physical input is delivered with stale geometry');
      await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: false, state: false });
      await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'after-observe' } });
      assert.deepEqual(fixture.inputs, ['text:after-observe']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('window delivery uses a deterministic one-pixel geometry tolerance', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-geometry-tolerance-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setRegion({ left: 101, top: 49, width: 401, height: 199 });
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'within-tolerance' } });
    fixture.setRegion({ left: 101.01, top: 50, width: 400, height: 200 });
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'outside-tolerance' } }),
      (error: any) => error.code === 'STALE_GEOMETRY' && error.retryable === true,
    );
    assert.deepEqual(fixture.inputs, ['text:within-tolerance']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('screenshot-relative coordinates use exclusive upper bounds', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-coordinate-edges-'));
  try {
    const fixture = backendFixture(); const target = await opened(fixture, dir);
    const observation = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: false });
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: observation.revision, input: { kind: 'move', target: { x: 399.999, y: 199.999 } } });
    const delivered = fixture.positions.length;
    for (const point of [{ x: 400, y: 100 }, { x: 200, y: 200 }]) {
      await assert.rejects(
        () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: observation.revision, input: { kind: 'move', target: point } }),
        (error: any) => error.code === 'COORDINATE_OUT_OF_BOUNDS',
      );
    }
    assert.equal(fixture.positions.length, delivered, 'upper-edge coordinates cause no physical delivery');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('physical input safely reacquires the exact target when another window stole foreground', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-input-refocus-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setActive(100);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'safe' } });
    assert.deepEqual(fixture.inputs, ['text:safe']);
    assert.equal(fixture.calls.some(({ name }) => name === 'bring_to_front'), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('physical input refuses delivery when exact refocus fails or the target is stale', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-input-proof-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setActive(100); fixture.setBringActivates(false); fixture.setNutFocusWindow(101); fixture.setNativeFocusWindow(101);
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'unsafe' } }), (error: any) => error.code === 'TARGET_NOT_FOREGROUND' && error.retryable === true);
    assert.deepEqual(fixture.inputs, []);
    fixture.setActive(99); fixture.setAvailable(false);
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'stale' } }), (error: any) => error.code === 'STALE_TARGET' && error.retryable === true);
    assert.deepEqual(fixture.inputs, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('key/button releases and release_all remain allowed after focus and target loss', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-release-safety-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'key_down', key: 'W' } });
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'mouse_down', button: 'left' } });
    fixture.setActive(100); fixture.setAvailable(false);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'key_up', key: 'W' } });
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'mouse_up', button: 'left' } });
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'release_all' } });
    assert.deepEqual(fixture.inputs, ['key_down:1', 'button_down:1', 'key_up:1', 'button_up:1']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('releaseValues attempts every unique key and button and returns only failures', async () => {
  const fixture = controlledFixture(); fixture.failKeyReleases(1); fixture.failButtonReleases(1);
  const remaining = await fixture.backend.releaseValues({ keys: ['W', 'W', 'A'], buttons: ['left', 'right', 'left'] });
  assert.deepEqual(remaining, { keys: ['W'], buttons: ['left'] });
  assert.deepEqual(fixture.inputs, ['key_up:2', 'key_up:1', 'button_up:3', 'button_up:1']);
});

test('failed session cleanup retains only failed values and release_all can retry them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-release-ledger-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    for (const input of [
      { kind: 'key_down', key: 'W' }, { kind: 'key_down', key: 'A' },
      { kind: 'mouse_down', button: 'left' }, { kind: 'mouse_down', button: 'right' },
    ]) await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input });
    fixture.failKeyReleases(1); fixture.failButtonReleases(3); fixture.setActive(100);
    fixture.setBringActivates(false); fixture.setNutFocusWindow(101); fixture.setNativeFocusWindow(101);
    const beforeCleanup = fixture.inputs.length;
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'blocked' } }),
      (error: any) => error.code === 'RELEASE_FAILED' && error.retryable === true
        && JSON.stringify(error.held) === JSON.stringify({ keys: ['W'], buttons: ['right'] }),
    );
    assert.deepEqual(fixture.inputs.slice(beforeCleanup), ['key_up:2', 'key_up:1', 'button_up:3', 'button_up:1']);
    fixture.failKeyReleases(); fixture.failButtonReleases();
    const released = await fixture.backend.releaseAll({ sessionId: 's', held: { keys: [], buttons: [] } });
    assert.deepEqual(released.held, { keys: [], buttons: [] });
    assert.deepEqual(released.heldBySession, [{ sessionId: 's', held: { keys: [], buttons: [] } }]);
    assert.deepEqual(fixture.inputs.slice(-2), ['key_up:1', 'button_up:3']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('user release_all and close fail safely without ending or killing a session while release remains', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-release-close-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'key_down', key: 'W' } });
    fixture.failKeyReleases(1);
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'release_all' } }),
      (error: any) => error.code === 'RELEASE_FAILED' && error.held.keys[0] === 'W',
    );
    await assert.rejects(
      () => fixture.backend.close({ sessionId: 's', targetId: target.targetId, closeApplication: true }),
      (error: any) => error.code === 'RELEASE_FAILED' && error.held.keys[0] === 'W',
    );
    assert.equal(fixture.calls.some(({ name }) => name === 'kill_app' || name === 'end_session'), false);
    fixture.failKeyReleases();
    const closed = await fixture.backend.close({ sessionId: 's', targetId: target.targetId, closeApplication: true });
    assert.deepEqual(closed.held, { keys: [], buttons: [] });
    assert.equal(fixture.calls.some(({ name }) => name === 'kill_app'), true);
    assert.equal(fixture.calls.some(({ name }) => name === 'end_session'), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('backend shutdown retains failed session ledgers and does not destroy the driver before a successful retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-release-shutdown-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'key_down', key: 'W' } });
    fixture.failKeyReleases(1);
    await assert.rejects(
      () => fixture.backend.shutdown(),
      (error: any) => error.code === 'RELEASE_FAILED' && error.heldBySession[0].held.keys[0] === 'W',
    );
    assert.equal(fixture.calls.some(({ name }) => name === 'driver_shutdown'), false);
    fixture.failKeyReleases(); await fixture.backend.shutdown();
    assert.equal(fixture.calls.filter(({ name }) => name === 'driver_shutdown').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('balanced press, hotkey, drag, and preserveHeld=false retain failed releases and attempt all members', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-balanced-release-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.failKeyReleases(1);
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'press', key: 'W' } }), (error: any) => error.code === 'RELEASE_FAILED' && error.held.keys.includes('W'));
    fixture.failKeyReleases(); await fixture.backend.releaseAll({ sessionId: 's', held: { keys: [], buttons: [] } });

    fixture.failKeyReleases(1, 2); const hotkeyStart = fixture.inputs.length;
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'hotkey', keys: ['W', 'A', 'W'] } }), (error: any) => error.code === 'RELEASE_FAILED' && new Set(error.held.keys).size === 2);
    assert.deepEqual(fixture.inputs.slice(hotkeyStart), ['key_down:1', 'key_down:2', 'key_up:2', 'key_up:1', 'key_up:2', 'key_up:1']);
    fixture.failKeyReleases(); await fixture.backend.releaseAll({ sessionId: 's', held: { keys: [], buttons: [] } });

    fixture.failButtonReleases(1);
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'drag', from: { x: 1, y: 1, scope: 'desktop' }, to: { x: 2, y: 2, scope: 'desktop' } } }), (error: any) => error.code === 'RELEASE_FAILED' && error.held.buttons.includes('left'));
    fixture.failButtonReleases(); await fixture.backend.releaseAll({ sessionId: 's', held: { keys: [], buttons: [] } });

    fixture.failKeyReleases(1, 2); fixture.failButtonReleases(1);
    const sequence = { version: 1, actions: [
      { atMs: 0, action: { kind: 'key_down', key: 'W' } },
      { atMs: 0, action: { kind: 'key_down', key: 'A' } },
      { atMs: 0, action: { kind: 'mouse_down', button: 'left' } },
    ] };
    await assert.rejects(
      () => fixture.backend.runSequence({ sessionId: 's', targetId: target.targetId, sequence, preserveHeld: false }),
      (error: any) => error.code === 'RELEASE_FAILED' && new Set(error.held.keys).size === 2 && error.held.buttons[0] === 'left',
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('emergency_release reports aggregate and per-session remaining held values truthfully', async () => {
  const fixture = controlledFixture(); fixture.failKeyReleases(1); fixture.failButtonReleases(3);
  const result = await fixture.backend.emergencyRelease({ heldBySession: [
    { sessionId: 'a', held: { keys: ['W', 'A'], buttons: ['left'] } },
    { sessionId: 'b', held: { keys: ['W'], buttons: ['right'] } },
  ] });
  assert.deepEqual(result.held, { keys: ['W'], buttons: ['right'] });
  assert.deepEqual(result.heldBySession, [
    { sessionId: 'a', held: { keys: ['W'], buttons: [] } },
    { sessionId: 'b', held: { keys: ['W'], buttons: ['right'] } },
  ]);
  assert.deepEqual(fixture.inputs, ['key_up:2', 'key_up:1', 'button_up:3', 'button_up:1']);
});

test('run_sequence revalidates and safely reacquires the exact target after prior actions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-sequence-target-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'key_down', key: 'W' } });
    fixture.setOnType(() => { fixture.setActive(100); fixture.setOnType(undefined); });
    const sequence = { version: 1, actions: [
      { atMs: 0, action: { kind: 'wait', durationMs: 0 } },
      { atMs: 0, action: { kind: 'text', text: 'first' } },
      { atMs: 0, action: { kind: 'key_up', key: 'W' } },
      { atMs: 0, action: { kind: 'text', text: 'second' } },
    ] };
    await fixture.backend.runSequence({ sessionId: 's', targetId: target.targetId, sequence });
    assert.deepEqual(fixture.inputs, ['key_down:1', 'text:first', 'key_up:1', 'text:second']);
    assert.equal(fixture.calls.some(({ name }) => name === 'bring_to_front'), true);

    fixture.setActive(100); fixture.setBringActivates(true);
    const focused = { version: 1, actions: [
      { atMs: 0, action: { kind: 'focus' } },
      { atMs: 0, action: { kind: 'text', text: 'after-focus' } },
    ] };
    await fixture.backend.runSequence({ sessionId: 's', targetId: target.targetId, sequence: focused });
    assert.equal(fixture.inputs.at(-1), 'text:after-focus');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('focus keeps Cua as the primary focus owner when it activates the exact HWND', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-focus-cua-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setActive(100);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'focus' } });
    assert.equal(fixture.calls.filter(({ name }) => name === 'bring_to_front').length, 1);
    assert.equal(fixture.calls.filter(({ name }) => name === 'nut_focus').length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('focus restores before the exact NutJS Window fallback when Cua does not activate it', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-focus-nut-fallback-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setActive(100); fixture.setBringActivates(false); fixture.setNativeFocusWindow(101);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'focus' } });
    assert.equal(fixture.calls.filter(({ name }) => name === 'bring_to_front').length, 1);
    assert.equal(fixture.calls.filter(({ name }) => name === 'nut_restore').length, 1);
    assert.equal(fixture.calls.filter(({ name }) => name === 'nut_focus').length, 1);
    assert.ok(fixture.calls.findIndex(({ name }) => name === 'nut_restore') < fixture.calls.findIndex(({ name }) => name === 'nut_focus'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('focus falls back to the exact NutJS Window when Cua throws', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-focus-cua-error-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setActive(100); fixture.setBringThrows(true); fixture.setNativeFocusWindow(101);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'focus' } });
    assert.equal(fixture.calls.filter(({ name }) => name === 'bring_to_front').length, 1);
    assert.equal(fixture.calls.filter(({ name }) => name === 'nut_focus').length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('focus bounds a hung Cua call and still reaches the exact Win32 fallback', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-focus-cua-hung-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setActive(100); fixture.setBringHangs(true); fixture.setNativeFocusWindow(99);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'focus' } });
    assert.equal(fixture.calls.filter(({ name }) => name === 'bring_to_front').length, 1);
    assert.equal(fixture.calls.filter(({ name }) => name === 'native_focus').length, 1);
    assert.equal(fixture.calls.filter(({ name }) => name === 'nut_focus').length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('focus uses bounded PID/HWND-validated Win32 fallback immediately after Cua cannot activate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-focus-native-fallback-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setActive(100); fixture.setBringActivates(false); fixture.setNutFocusWindow(101); fixture.setNativeFocusWindow(99);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'focus' } });
    assert.equal(fixture.calls.filter(({ name }) => name === 'native_focus').length, 1);
    assert.equal(fixture.calls.filter(({ name }) => name === 'nut_focus').length, 0);
    const nativeIndex = fixture.calls.findIndex(({ name }) => name === 'native_focus');
    assert.equal(fixture.calls.slice(nativeIndex + 1).some(({ name }) => name === 'list_windows'), false, 'foreground proof after native focus is immediate rather than delayed by Cua discovery');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('focus refuses success when all exact-HWND focus strategies fail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-focus-wrong-hwnd-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setActive(100); fixture.setBringActivates(false); fixture.setNutFocusWindow(101); fixture.setNativeFocusWindow(101);
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'focus' } }), (error: any) => error.code === 'TARGET_NOT_FOREGROUND' && error.retryable === true);
    assert.equal(fixture.calls.filter(({ name }) => name === 'nut_focus').length, 1);
    assert.deepEqual(fixture.inputs, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('focus refuses a stale target before Cua or NutJS focus', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-focus-stale-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setAvailable(false);
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'focus' } }), (error: any) => error.code === 'STALE_TARGET');
    assert.equal(fixture.calls.filter(({ name }) => name === 'bring_to_front').length, 0);
    assert.equal(fixture.calls.filter(({ name }) => name === 'nut_focus').length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('application close revalidates PID/HWND while session-only close remains safe', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-close-proof-'));
  try {
    const fixture = controlledFixture(); const target = await openControlled(fixture, dir);
    fixture.setAvailable(false);
    await assert.rejects(() => fixture.backend.close({ sessionId: 's', targetId: target.targetId, closeApplication: true }), (error: any) => error.code === 'STALE_TARGET');
    assert.equal(fixture.calls.some(({ name }) => name === 'kill_app'), false);
    const result = await fixture.backend.close({ sessionId: 's', targetId: target.targetId, closeApplication: false });
    assert.equal(result.closedApplication, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('semantic refs carry a backend epoch and monotonic target generation across reopen and backend restarts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-ref-generation-'));
  try {
    const firstBackend = controlledFixture(); const firstTarget = await openControlled(firstBackend, dir);
    const first = await firstBackend.backend.observe({ sessionId: 's', targetId: firstTarget.targetId, screenshot: false, state: false });
    const reopenedTarget = await openControlled(firstBackend, dir);
    const reopened = await firstBackend.backend.observe({ sessionId: 's', targetId: reopenedTarget.targetId, screenshot: false, state: false });
    assert.notEqual(first.elements[0].ref, reopened.elements[0].ref);
    await assert.rejects(() => firstBackend.backend.act({ sessionId: 's', targetId: reopenedTarget.targetId, input: { kind: 'move', target: { ref: first.elements[0].ref } } }), (error: any) => error.code === 'STALE_REFERENCE');

    const restartedBackend = controlledFixture(); const restartedTarget = await openControlled(restartedBackend, dir);
    const restarted = await restartedBackend.backend.observe({ sessionId: 's', targetId: restartedTarget.targetId, screenshot: false, state: false });
    assert.notEqual(first.elements[0].ref, restarted.elements[0].ref, 'restart-unique epochs prevent ref collision');
    await assert.rejects(() => restartedBackend.backend.act({ sessionId: 's', targetId: restartedTarget.targetId, input: { kind: 'move', target: { ref: first.elements[0].ref } } }), (error: any) => error.code === 'STALE_REFERENCE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('observe falls back to a NutJS foreground visible-region screenshot when Cua window state times out', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-'));
  try {
    const fixture = timeoutFixture({ captureRegion: 'png' }); const openedResult = await opened(fixture, dir);
    const result = await fixture.backend.observe({ sessionId: 's', targetId: openedResult.targetId, screenshot: true, tree: true, state: true });
    assert.equal(result.accessibilityAvailable, false);
    assert.equal(result.degraded.fallback, 'pixel');
    assert.ok(typeof result.degraded.reason === 'string' && result.degraded.reason.length > 0);
    assert.deepEqual(result.elements, []);
    assert.equal(result.tree, '');
    assert.equal(result.revision, 1);
    assert.ok(result.fullImagePath); assert.ok(result.displayImagePath);
    assert.equal(result.imageWidth, 400); assert.equal(result.imageHeight, 200);
    assert.equal(result.fullImageWidth, 400); assert.equal(result.fullImageHeight, 200);
    assert.equal(result.state.foreground, true); assert.equal(result.state.minimized, false); assert.equal(result.state.onScreen, true);
    const entries = await readdir(dir);
    assert.equal(entries.filter((entry) => entry.endsWith('.tmp')).length, 0, 'no .tmp artifacts remain');
    assert.ok(entries.some((entry) => entry.endsWith('-full.png')), 'final full PNG produced by the fallback');
    assert.ok(entries.some((entry) => entry.endsWith('-display.png')), 'display PNG produced');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('accessibility fallback observations expose no semantic references', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-refs-'));
  try {
    const fixture = timeoutFixture({ captureRegion: 'png' }); const target = await opened(fixture, dir);
    const result = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: true, state: false });
    assert.deepEqual(result.elements, []);
    await assert.rejects(() => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'move', target: { ref: 'e:1:0' } } }), (error: any) => error.code === 'STALE_REFERENCE');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('visible-region fallback increments revision and converts target-relative coordinates using fallback dimensions', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-coords-'));
  try {
    const fixture = timeoutFixture({ captureRegion: 'png' }); const target = await opened(fixture, dir);
    const first = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: false });
    assert.equal(first.revision, 1);
    assert.equal(first.imageWidth, 400); assert.equal(first.imageHeight, 200);
    assert.equal(first.fullImageWidth, 400); assert.equal(first.fullImageHeight, 200);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: first.revision, input: { kind: 'move', target: { x: 200, y: 100 } } });
    assert.deepEqual(fixture.positions.at(-1), { x: 300, y: 150 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a normal screenshot:false observation clears prior image geometry and blocks target-relative coordinates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-normal-clear-shot-'));
  try {
    const fixture = backendFixture(); const target = await opened(fixture, dir);
    const first = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: false });
    assert.deepEqual(first.target.geometry.screenshot, { width: 400, height: 200 });
    const second = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: false, state: false });
    assert.equal(second.target.geometry.screenshot, undefined);
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: second.revision, input: { kind: 'move', target: { x: 10, y: 10 } } }),
      (error: any) => error.code === 'OBSERVATION_REQUIRED',
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a degraded screenshot:false observation clears prior image geometry and blocks target-relative coordinates', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-degraded-clear-shot-'));
  try {
    const fixture = timeoutFixture({ captureRegion: 'png' }); const target = await opened(fixture, dir);
    const first = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: false });
    assert.deepEqual(first.target.geometry.screenshot, { width: 400, height: 200 });
    const second = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: true, state: false });
    assert.equal(second.target.geometry.screenshot, undefined);
    assert.equal(second.degraded.fallback, 'none');
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: second.revision, input: { kind: 'move', target: { x: 10, y: 10 } } }),
      (error: any) => error.code === 'OBSERVATION_REQUIRED',
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('screenshot:false fallback returns a background accessibility-unavailable observation without an image', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-noshot-'));
  try {
    const fixture = timeoutFixture({ captureRegion: 'png' }); const target = await opened(fixture, dir); fixture.setActive(100);
    const result = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: true, state: true });
    assert.equal(result.accessibilityAvailable, false);
    assert.equal(result.degraded.fallback, 'none');
    assert.match(result.degraded.reason, /accessibility unavailable/i);
    assert.match(result.degraded.reason, /no image captured/i);
    assert.doesNotMatch(result.degraded.reason, /captured pixels only/i);
    assert.equal(result.fullImagePath, undefined);
    assert.equal(result.displayImagePath, undefined);
    assert.equal(result.imageWidth, undefined);
    assert.equal(result.imageHeight, undefined);
    assert.equal(result.fullImageWidth, undefined);
    assert.equal(result.fullImageHeight, undefined);
    assert.equal(result.target.geometry.screenshot, undefined);
    assert.equal(result.revision, 1); assert.equal(result.state.foreground, false);
    assert.deepEqual(result.elements, []);
    assert.equal(fixture.calls.some(({ name }) => name === 'captureRegion'), false);
    assert.deepEqual(await readdir(dir), [], 'no artifacts are produced without a screenshot');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('accessibility-failed visible-region capture refuses a background target before capture', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-background-'));
  try {
    const fixture = timeoutFixture({ captureRegion: 'png' }); const target = await opened(fixture, dir);
    fixture.setActive(100);
    await assert.rejects(() => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true }), (error: any) => error.code === 'TARGET_NOT_FOREGROUND' && error.retryable === true);
    assert.equal(fixture.calls.some(({ name }) => name === 'captureRegion'), false);
    assert.deepEqual(await readdir(dir), [], 'no observation artifacts are produced for a background target');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('visible-region fallback refuses minimized and off-screen targets', async () => {
  for (const visibility of [{ minimized: true }, { onScreen: false }]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-hidden-'));
    try {
      const fixture = timeoutFixture({ captureRegion: 'png', ...visibility }); const target = await opened(fixture, dir);
      await assert.rejects(() => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true }), (error: any) => error.code === 'TARGET_NOT_VISIBLE' && error.retryable === true);
      assert.equal(fixture.calls.some(({ name }) => name === 'captureRegion'), false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('visible-region capture fails and deletes the image if foreground or geometry changes after capture', async () => {
  for (const race of [
    { activeAfterCapture: 100, expectedCode: 'TARGET_NOT_FOREGROUND' },
    { nutRegionAfterCapture: { left: 120, top: 50, width: 400, height: 200 }, expectedCode: 'STALE_GEOMETRY' },
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'computer-capture-race-'));
    try {
      const fixture = timeoutFixture({ uiaPayload: { element_count: 0, elements: [] }, captureRegion: 'png', ...race });
      const target = await opened(fixture, dir);
      await assert.rejects(
        () => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true }),
        (error: any) => error.code === race.expectedCode && error.retryable === true,
      );
      assert.equal(fixture.calls.filter(({ name }) => name === 'captureRegion').length, 1);
      assert.equal((await readdir(dir)).some((entry) => entry.endsWith('.png')), false, 'raced capture image is deleted');
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('visible-region capture refuses windows not entirely on the NutJS main display', async () => {
  for (const nutRegion of [
    { left: -1, top: 50, width: 400, height: 200 },
    { left: 700, top: 50, width: 400, height: 200 },
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'computer-capture-off-main-'));
    try {
      const fixture = timeoutFixture({ uiaPayload: { element_count: 0, elements: [] }, nutRegion, captureRegion: 'png' });
      const target = await opened(fixture, dir);
      await assert.rejects(
        () => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true }),
        (error: any) => error.code === 'TARGET_NOT_VISIBLE' && error.retryable === true && /main display/i.test(error.message),
      );
      assert.equal(fixture.calls.some(({ name }) => name === 'captureRegion'), false);
      assert.deepEqual(await readdir(dir), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('successful Cua UIA maps coordinates from the display PNG derived from the NutJS foreground visible-region capture (DPI/crop regression)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-window-crop-regression-'));
  try {
    const fixture = timeoutFixture({
      uiaPayload: {
        screenshot_width: 1477, screenshot_height: 789, element_count: 1,
        elements: [{ role: 'title bar', label: 'Godot', frame: { x: 0, y: 0, w: 1477, h: 32 } }], tree_markdown: 'Godot title bar',
      },
      nutRegion: { left: 100, top: 50, width: 2560, height: 1368 }, mainDisplay: { width: 3000, height: 1600 }, captureRegion: 'png',
    });
    const target = await opened(fixture, dir);
    const result = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: true, state: true });
    assert.equal(result.accessibilityAvailable, true);
    assert.equal(result.tree, 'Godot title bar');
    assert.equal(result.imageWidth, 1600); assert.equal(result.imageHeight, 855);
    assert.equal(result.fullImageWidth, 2560); assert.equal(result.fullImageHeight, 1368);
    assert.deepEqual(result.target.geometry.screenshot, { width: 1600, height: 855 });
    assert.deepEqual(await pngDimensions(result.displayImagePath), { width: 1600, height: 855 });
    assert.deepEqual(await pngDimensions(result.fullImagePath), { width: 2560, height: 1368 });
    const windowStateCall = fixture.calls.find(({ name }) => name === 'get_window_state');
    assert.equal(windowStateCall?.args.include_screenshot, false);
    assert.equal(Object.hasOwn(windowStateCall?.args ?? {}, 'screenshot_out_file'), false);
    assert.equal(fixture.calls.filter(({ name }) => name === 'captureRegion').length, 1);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: result.revision, input: { kind: 'move', target: { x: 1000, y: 500 } } });
    assert.deepEqual(fixture.positions.at(-1), { x: 1700, y: 850 });
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: result.revision, input: { kind: 'move', target: { x: 2000, y: 500 } } }),
      (error: any) => error.code === 'COORDINATE_OUT_OF_BOUNDS',
    );
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('successful Cua UIA window screenshot refuses background capture, while screenshot:false succeeds', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-window-background-'));
  try {
    const fixture = timeoutFixture({ uiaPayload: { element_count: 1, elements: [{ role: 'title bar', label: 'Godot' }], tree_markdown: 'tree' }, captureRegion: 'png' });
    const target = await opened(fixture, dir); fixture.setActive(100);
    await assert.rejects(() => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true }), (error: any) => error.code === 'TARGET_NOT_FOREGROUND');
    assert.equal(fixture.calls.some(({ name }) => name === 'captureRegion'), false);
    const result = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: true, state: true });
    assert.equal(result.accessibilityAvailable, true); assert.equal(result.tree, 'tree');
    assert.equal(result.fullImagePath, undefined); assert.equal(result.state.foreground, false);
    const windowCalls = fixture.calls.filter(({ name }) => name === 'get_window_state');
    assert.equal(windowCalls.length, 2);
    for (const call of windowCalls) {
      assert.equal(call.args.include_screenshot, false);
      assert.equal(Object.hasOwn(call.args, 'screenshot_out_file'), false);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('desktop input requires a fresh revision and unchanged observed foreground', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-desktop-action-'));
  try {
    const fixture = controlledFixture();
    const target = await fixture.backend.open({ sessionId: 's', selector: { kind: 'desktop' }, artifactDir: dir });
    fixture.setActive(100); fixture.setAvailable(false); fixture.setRegion({ left: 500, top: 500, width: 1, height: 1 });
    const observed = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false, tree: false, state: true });
    assert.deepEqual(observed.state, { desktop: true, foreground: { windowId: 100 } });
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, input: { kind: 'text', text: 'missing-revision' } }),
      (error: any) => error.code === 'INVALID_ARGUMENTS',
    );
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: observed.revision, input: { kind: 'text', text: 'bound-desktop' } });
    fixture.setActive(101);
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: observed.revision, input: { kind: 'text', text: 'wrong-window' } }),
      (error: any) => error.code === 'DESKTOP_FOREGROUND_CHANGED' && error.retryable === true,
    );
    assert.deepEqual(fixture.inputs, ['text:bound-desktop']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('desktop observation rejects and cleans a capture when foreground changes mid-observation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-desktop-race-'));
  try {
    const fixture = timeoutFixture({ activeAfterDesktopCapture: 100 });
    const target = await fixture.backend.open({ sessionId: 's', selector: { kind: 'desktop' }, artifactDir: dir });
    await assert.rejects(
      () => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: true, state: true }),
      (error: any) => error.code === 'DESKTOP_FOREGROUND_CHANGED' && error.retryable === true,
    );
    assert.deepEqual(await readdir(dir), [], 'raced desktop observation artifacts are deleted');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('failed desktop observation does not rebind the prior revision to new foreground', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-desktop-atomic-binding-'));
  try {
    const fixture = timeoutFixture();
    const target = await fixture.backend.open({ sessionId: 's', selector: { kind: 'desktop' }, artifactDir: dir });
    const first = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: true });
    assert.equal(first.revision, 1); assert.equal(first.state.foreground.windowId, 99);

    fixture.setActive(100); fixture.setInvalidDesktopPng(true);
    await assert.rejects(() => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: true }));
    fixture.setInvalidDesktopPng(false); fixture.setActive(99);
    await fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: first.revision, input: { kind: 'press', key: 'W' } });
    fixture.setActive(100);
    await assert.rejects(
      () => fixture.backend.act({ sessionId: 's', targetId: target.targetId, revision: first.revision, input: { kind: 'press', key: 'W' } }),
      (error: any) => error.code === 'DESKTOP_FOREGROUND_CHANGED',
    );
    assert.equal((await readdir(dir)).some((name) => name.endsWith('.tmp') || name.includes('not-a-png')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('desktop screenshots remain owned by Cua', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-desktop-screenshot-'));
  try {
    const fixture = timeoutFixture({ captureRegion: 'throw' });
    const target = await fixture.backend.open({ sessionId: 's', selector: { kind: 'desktop' }, artifactDir: dir });
    const result = await fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: false, state: false });
    assert.equal(result.imageWidth, 1000); assert.equal(result.imageHeight, 600);
    assert.equal(result.fullImageWidth, 1000); assert.equal(result.fullImageHeight, 600);
    const desktopCall = fixture.calls.find(({ name }) => name === 'get_desktop_state');
    assert.equal(typeof desktopCall?.args.screenshot_out_file, 'string');
    assert.equal(fixture.calls.some(({ name }) => name === 'get_window_state'), false);
    assert.equal(fixture.calls.some(({ name }) => name === 'captureRegion'), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fallback proves the exact PID/HWND still exists before degraded observation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-stale-'));
  try {
    const fixture = timeoutFixture(); const target = await opened(fixture, dir);
    fixture.setWindowAvailable(false);
    await assert.rejects(() => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: false }), (error: any) => error.code === 'STALE_TARGET');
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fallback rethrows cancellation and unrelated provider failures without capturing', async () => {
  for (const failure of [
    { code: 'CANCELLED', message: 'Computer request was cancelled.' },
    { code: 'CUA_ERROR', message: 'provider returned malformed state' },
  ]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-rethrow-'));
    try {
      const fixture = timeoutFixture({ errorCode: failure.code, errorMessage: failure.message }); const target = await opened(fixture, dir);
      await assert.rejects(() => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true }), (error: any) => error.code === failure.code);
      assert.equal(fixture.calls.some(({ name }) => name === 'captureRegion'), false);
      assert.deepEqual(await readdir(dir), []);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
});

test('observe returns a combined error and leaves no artifacts when both Cua window state and the NutJS screenshot fallback fail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'computer-fallback-fail-'));
  try {
    const fixture = timeoutFixture({ captureRegion: 'throw' }); const target = await opened(fixture, dir);
    await assert.rejects(() => fixture.backend.observe({ sessionId: 's', targetId: target.targetId, screenshot: true, tree: true, state: false }), (error: any) => {
      assert.equal(error.code, 'OBSERVE_UNAVAILABLE');
      assert.equal(error.retryable, true);
      assert.match(error.message, /accessibility state unavailable/i);
      assert.match(error.message, /foreground visible-region screenshot fallback failed/i);
      return true;
    });
    const entries = await readdir(dir);
    assert.equal(entries.filter((entry) => entry.endsWith('.tmp')).length, 0, 'no .tmp artifacts remain');
    assert.equal(entries.filter((entry) => entry.endsWith('.png')).length, 0, 'no PNG artifacts remain');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
