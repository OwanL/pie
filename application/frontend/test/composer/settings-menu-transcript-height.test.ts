import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { ComposerSettingsMenu } from '../../settings/settings-menu';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index.js';

let container: HTMLElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrameId: number;
const originalRequestAnimationFrame = window.requestAnimationFrame;
const originalCancelAnimationFrame = window.cancelAnimationFrame;
const originalInnerHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight');

function setViewportHeight(height: number): void {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function flushAnimationFrames(): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  frames = new Map();
  nextFrameId = 1;
  window.requestAnimationFrame = (callback) => {
    const id = nextFrameId++;
    frames.set(id, callback);
    return id;
  };
  window.cancelAnimationFrame = (id) => { frames.delete(id); };
  setViewportHeight(800);
});

afterEach(() => {
  render(null, container);
  container.remove();
  // The settings menu portals to document.body; remove any stray portaled
  // instance so tests cannot observe a previous test's menu.
  document.querySelectorAll('.toolbar-settings-menu').forEach((el) => el.remove());
  document.querySelectorAll('.model-picker-dropdown').forEach((el) => el.remove());
  window.requestAnimationFrame = originalRequestAnimationFrame;
  window.cancelAnimationFrame = originalCancelAnimationFrame;
  if (originalInnerHeight) Object.defineProperty(window, 'innerHeight', originalInnerHeight);
});

function click(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function renderMenu(): void {
  act(() => {
    render(
      h(ComposerSettingsMenu, {
        prefs: DEFAULT_CHAT_PREFS,
        pruningSettings: DEFAULT_PRUNING_SETTINGS,
        pruningCatalog: { skills: [], tools: [] },
        pruningResult: null,
        toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
        availableExtensions: [],
        availableModels: [],
        providerGateStats: EMPTY_PROVIDER_GATE_STATS,
        onSetPrefs: () => undefined,
        mcpServers: [],
        mcpPendingApply: false,
        onMcpListRequested: () => undefined,
        onMcpSetServerEnabled: () => undefined,
        onSetPruningSettings: () => undefined,
        onSetToolResultPruningSettings: () => undefined,
      }),
      container,
    );
  });
}

function openWithTriggerRect(top: number, bottom: number): HTMLElement {
  const trigger = container.querySelector('.toolbar-settings-trigger') as HTMLElement;
  trigger.getBoundingClientRect = () => ({
    bottom, right: 300, top, left: 0, width: 300, height: bottom - top,
    x: 0, y: top, toJSON() {},
  }) as DOMRect;
  act(() => { click(trigger); });
  const menu = document.body.querySelector('.toolbar-settings-menu') as HTMLElement;
  assert.ok(menu, 'settings menu should be open');
  return menu;
}

// The trigger geometry, not the menu's own rect, determines the stable popup
// height and the available viewport cap.
test('settings menu keeps its stable height when space allows and tabs change', () => {
  renderMenu();
  const menu = openWithTriggerRect(700, 720);

  assert.equal(menu.style.height, '500px', 'menu uses the compact stable design height when space allows');
  assert.equal(menu.style.maxHeight, '686px', 'above-trigger space includes viewport padding and trigger gap');
  assert.equal(menu.style.top, '194px');

  const fixedHeight = menu.style.height;
  for (const tab of ['appearance', 'chat']) {
    act(() => { click(menu.querySelector(`.toolbar-settings-tab[data-tab="${tab}"]`)); });
    assert.equal(menu.style.height, fixedHeight, `height should not change when switching to the ${tab} tab`);
  }
});

test('resize and scroll recompute capped geometry when the trigger is offscreen', () => {
  renderMenu();
  const menu = openWithTriggerRect(-100, -80);
  assert.equal(menu.style.height, '500px');

  // Scrolling the trigger above the viewport clamps the menu to the lower
  // viewport edge; resizing then applies the smaller available space.
  act(() => {
    window.dispatchEvent(new Event('scroll'));
    flushAnimationFrames();
  });
  assert.equal(menu.style.top, '8px');
  assert.equal(menu.style.maxHeight, '784px');

  setViewportHeight(300);
  act(() => {
    window.dispatchEvent(new Event('resize'));
    flushAnimationFrames();
  });
  assert.equal(menu.style.height, '284px');
  assert.equal(menu.style.maxHeight, '284px');
  assert.equal(menu.style.top, '8px');
});
