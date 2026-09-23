import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installDom } from '../../_helpers/dom';
installDom();

import { bindAppToVisualViewport } from '../../../src/webview/panel/visual-viewport';

class FakeVisualViewport {
  height = 800;
  offsetTop = 0;
  scale = 1;
  private readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (!listener) return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (listener) this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: string): void {
    const event = document.createEvent('Event');
    event.initEvent(type, false, false);
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);
      else listener.handleEvent(event);
    }
  }

  resize(): void {
    this.dispatch('resize');
  }

  scroll(): void {
    this.dispatch('scroll');
  }
}

interface StyleSnapshot {
  value: string;
  priority: string;
}

function snapshotStyle(element: HTMLElement, property: string): StyleSnapshot {
  return {
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  };
}

function restoreStyle(element: HTMLElement, property: string, previous: StyleSnapshot): void {
  if (previous.value) element.style.setProperty(property, previous.value, previous.priority);
  else element.style.removeProperty(property);
}

function mountAppRoot(): HTMLElement {
  const app = document.createElement('div');
  app.id = 'app';
  app.appendChild(document.createElement('main'));
  document.body.appendChild(app);
  return app;
}

test('mounted app tracks visual viewport resize and pan without window resize', () => {
  const viewport = new FakeVisualViewport();
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  const app = mountAppRoot();
  const root = document.documentElement;
  const previousHeight = snapshotStyle(root, '--panel-visible-viewport-height');
  const previousOffsetTop = snapshotStyle(root, '--panel-visible-viewport-offset-top');
  const innerHeight = window.innerHeight;
  let dispose: (() => void) | undefined;

  try {
    dispose = bindAppToVisualViewport(app);
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-height'), '800px');
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-offset-top'), '0px');

    viewport.height = 412;
    viewport.resize();
    assert.equal(window.innerHeight, innerHeight, 'regression requires layout viewport to stay unchanged');
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-height'), '412px');

    viewport.offsetTop = 37;
    viewport.scroll();
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-offset-top'), '37px');

    dispose?.();
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-height'), previousHeight.value);
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-offset-top'), previousOffsetTop.value);
    viewport.height = 300;
    viewport.offsetTop = 100;
    viewport.resize();
    viewport.scroll();
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-height'), previousHeight.value, 'disposed binding ignores later resize events');
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-offset-top'), previousOffsetTop.value, 'disposed binding ignores later scroll events');
  } finally {
    dispose?.();
    restoreStyle(root, '--panel-visible-viewport-height', previousHeight);
    restoreStyle(root, '--panel-visible-viewport-offset-top', previousOffsetTop);
    app.remove();
    if (previousDescriptor) Object.defineProperty(window, 'visualViewport', previousDescriptor);
    else Reflect.deleteProperty(window, 'visualViewport');
  }
});

test('missing visualViewport leaves CSS sizing alone and pinch zoom is ignored', () => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const app = mountAppRoot();
  const root = document.documentElement;
  const previousHeight = snapshotStyle(root, '--panel-visible-viewport-height');
  const previousOffsetTop = snapshotStyle(root, '--panel-visible-viewport-offset-top');
  let dispose: (() => void) | undefined;
  root.style.setProperty('--panel-visible-viewport-height', 'custom-height');
  root.style.setProperty('--panel-visible-viewport-offset-top', 'custom-offset');

  try {
    Reflect.deleteProperty(window, 'visualViewport');
    const noApiCleanup = bindAppToVisualViewport(app);
    noApiCleanup();
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-height'), 'custom-height');
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-offset-top'), 'custom-offset');

    const viewport = new FakeVisualViewport();
    viewport.scale = 2;
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    dispose = bindAppToVisualViewport(app);
    viewport.height = 380;
    viewport.offsetTop = 44;
    viewport.resize();
    viewport.scroll();
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-height'), 'custom-height', 'scaled visual dimensions must not resize the app');
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-offset-top'), 'custom-offset', 'scaled viewport pan must not reposition the app');

    viewport.scale = 1;
    viewport.height = 620;
    viewport.offsetTop = 19;
    viewport.resize();
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-height'), '620px', 'viewport sizing recovers when pinch zoom ends');
    assert.equal(root.style.getPropertyValue('--panel-visible-viewport-offset-top'), '19px', 'viewport positioning recovers when pinch zoom ends');
    dispose?.();
  } finally {
    dispose?.();
    restoreStyle(root, '--panel-visible-viewport-height', previousHeight);
    restoreStyle(root, '--panel-visible-viewport-offset-top', previousOffsetTop);
    app.remove();
    if (previousDescriptor) Object.defineProperty(window, 'visualViewport', previousDescriptor);
    else Reflect.deleteProperty(window, 'visualViewport');
  }
});

test('app uses visual viewport sizing while menu heights retain layout-viewport caps', async () => {
  const css = await readFile(new URL('../../../src/webview/panel/styles/index.css', import.meta.url), 'utf8');
  const composerCss = await readFile(new URL('../../../src/webview/panel/styles/composer.css', import.meta.url), 'utf8');
  const appRule = css.match(/#app\s*\{([^}]*)\}/)?.[1] ?? '';
  const settingsMenuRule = composerCss.match(/\.toolbar-settings-menu\s*\{([^}]*)\}/)?.[1] ?? '';
  const sessionMenuRule = composerCss.match(/\.session-tab-context-menu\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.match(appRule, /height:\s*var\(--panel-visible-viewport-height,\s*100vh\)/);
  assert.match(appRule, /height:\s*var\(--panel-visible-viewport-height,\s*100dvh\)/);
  assert.match(settingsMenuRule, /max-height:\s*calc\(100vh - 16px\)/);
  assert.match(sessionMenuRule, /max-height:\s*calc\(100vh - 8px\)/);
});

test('only the outer body app mount follows the visual viewport offset', async () => {
  const css = await readFile(new URL('../../../src/webview/panel/styles/index.css', import.meta.url), 'utf8');
  const sharedAppRule = css.match(/#app\s*\{([^}]*)\}/)?.[1] ?? '';
  const outerAppRule = css.match(/body\s*>\s*#app\s*\{([^}]*)\}/)?.[1] ?? '';

  assert.ok(outerAppRule, 'expected a direct body > #app rule for the static outer mount');
  assert.doesNotMatch(sharedAppRule, /position:\s*relative/);
  assert.doesNotMatch(sharedAppRule, /top:\s*var\(--panel-visible-viewport-offset-top/);
  assert.match(outerAppRule, /position:\s*relative/);
  assert.match(outerAppRule, /top:\s*var\(--panel-visible-viewport-offset-top,\s*0px\)/);
});
