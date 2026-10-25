import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { cancelHeightMotion } from '../../../lib/components/height-motion';
import { handleTranscriptClick } from '../../../transcript/transcript-click-handler';

test('code-block toggle updates truthful state while animating the uncapped block envelope', () => {
  const dom = new JSDOM('<!doctype html><body><div class="code-block code-block-collapsible code-block-collapsed"><div class="code-block-header"></div><pre><code>many lines</code></pre><button class="code-block-toggle" aria-expanded="false">Show all 20 lines<span></span></button></div></body>');
  const originalEvent = Object.getOwnPropertyDescriptor(globalThis, 'Event');
  const { document } = dom.window;
  const block = document.querySelector<HTMLElement>('.code-block')!;
  const button = block.querySelector<HTMLButtonElement>('.code-block-toggle')!;
  const nestedTarget = button.querySelector('span')!;
  let renderedHeight = 360;
  Object.defineProperty(block, 'getBoundingClientRect', {
    value: () => ({
      height: block.hasAttribute('data-height-moving')
        ? renderedHeight
        : block.classList.contains('code-block-collapsed') ? 360 : 1200,
    }) as DOMRect,
  });
  const animations: { frames: Keyframe[]; cancel: () => void }[] = [];
  block.animate = ((frames: Keyframe[]) => {
    const animation = { frames, cancel() {} };
    animations.push(animation);
    return { ...animation, finished: new Promise<void>(() => {}) } as unknown as Animation;
  }) as typeof block.animate;
  try {
    Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
    handleTranscriptClick({ target: nestedTarget } as unknown as MouseEvent);
    assert.equal(block.classList.contains('code-block-collapsed'), false);
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.textContent, 'Show less');
    assert.equal(block.hasAttribute('data-height-moving'), true);
    assert.equal(animations[0]?.frames[1]?.height, '1200px');

    // Reverse at an intermediate rendered height: the retarget starts there,
    // not at either the collapsed or expanded endpoint.
    renderedHeight = 650;
    handleTranscriptClick({ target: button } as unknown as MouseEvent);
    assert.equal(block.classList.contains('code-block-collapsed'), true);
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.textContent, 'Show all 20 lines');
    assert.equal(block.hasAttribute('data-height-moving'), true);
    assert.equal(animations[1]?.frames[0]?.height, '650px');
    assert.equal(animations[1]?.frames[1]?.height, '360px');
    cancelHeightMotion(block);
    assert.equal(block.hasAttribute('data-height-moving'), false);
  } finally {
    cancelHeightMotion(block);
    if (originalEvent) Object.defineProperty(globalThis, 'Event', originalEvent);
    else Reflect.deleteProperty(globalThis, 'Event');
    dom.window.close();
  }
});

test('code copy feedback, retries and detached controls preserve copied content', async () => {
  const originals = ['window', 'document', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const writes: string[] = [];
  let write: ((text: string) => Promise<void>) | undefined;
  const code = { textContent: 'const value = "<unchanged>";\n' };
  const classes = new Set<string>();
  const status = { textContent: '', isConnected: true };
  const button = {
    isConnected: true,
    textContent: 'Copy',
    getAttribute: (name: string) => name === 'aria-label' ? 'Copy code' : null,
    classList: {
      toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name); },
      remove: (name: string) => { classes.delete(name); },
    },
    parentElement: { querySelector: () => status },
    closest: (selector: string): unknown => selector === '.code-block-copy' ? button : selector === '.code-block' ? { querySelector: () => code } : null,
  };
  const click = () => handleTranscriptClick({ target: button } as unknown as MouseEvent);
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const runTimers = (delay: number) => {
    for (const timer of timers.splice(0)) {
      if (timer.delay === delay) timer.callback(); else timers.push(timer);
    }
  };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }),
    } });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      get clipboard() { return write ? { writeText: (text: string) => { writes.push(text); return write!(text); } } : undefined; },
    } });

    write = async () => {};
    click(); await settle(); runTimers(0);
    assert.equal(button.textContent, 'Copied');
    assert.equal(status.textContent, 'Copied to clipboard');
    assert.equal(classes.has('copied'), true);
    const oldReset = timers.splice(0);

    write = async () => { throw new Error('Denied'); };
    click(); await settle(); runTimers(0);
    assert.equal(button.textContent, 'Copy failed');
    assert.equal(status.textContent, 'Copy failed');
    assert.equal(classes.has('copied'), false);
    oldReset.forEach(timer => timer.callback());
    assert.equal(button.textContent, 'Copy failed');
    runTimers(1200);
    assert.equal(button.textContent, 'Copy');

    write = undefined;
    click(); await settle(); runTimers(0);
    assert.equal(button.textContent, 'Copy failed');
    assert.equal(status.textContent, 'Copy failed');
    runTimers(1200);
    assert.equal(button.textContent, 'Copy');

    let finishOld!: () => void;
    write = () => new Promise(resolve => { finishOld = resolve; });
    click();
    write = async () => { throw new Error('Retry denied'); };
    click(); await settle(); runTimers(0);
    finishOld(); await settle();
    assert.equal(button.textContent, 'Copy failed');
    assert.equal(status.textContent, 'Copy failed');

    write = async () => {};
    click(); await settle();
    button.isConnected = false;
    const priorStatus = status.textContent;
    runTimers(0); runTimers(1200);
    assert.equal(status.textContent, priorStatus);
    assert.equal(button.textContent, 'Copied');

    button.isConnected = true;
    write = () => new Promise(resolve => { finishOld = resolve; });
    click();
    button.isConnected = false;
    finishOld(); await settle();
    assert.equal(button.textContent, 'Copied');
    assert.equal(status.textContent, priorStatus);
    assert.equal(button.getAttribute('aria-label'), 'Copy code');
    assert.equal(code.textContent, 'const value = "<unchanged>";\n');
    assert.ok(writes.length >= 5);
    assert.ok(writes.every(text => text === code.textContent));
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
