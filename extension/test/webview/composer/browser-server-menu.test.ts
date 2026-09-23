import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { BrowserServerMenu } from '../../../src/webview/panel/composer/browser-server-menu';
import type { BrowserServerViewState } from '../../../src/shared/protocol';

let container: HTMLElement;
let copied: string[];
let clipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  copied = [];
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => { copied.push(text); } },
  });
});

afterEach(() => {
  render(null, container);
  container.remove();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

const RUNNING_LAN_STATE: BrowserServerViewState = {
  running: true,
  localUrl: 'http://127.0.0.1:1997/',
  port: 1997,
  clientCount: 2,
  lanEnabled: true,
  configuredLanEnabled: true,
  lanUrls: ['http://192.168.1.24:1997/'],
  changePending: false,
  pendingLanEnabled: null,
  changeError: null,
};

function click(element: Element | null): void {
  assert.ok(element, 'target element not found');
  act(() => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

function openMenu(): void {
  click(container.querySelector('[aria-label="Browser network access"]'));
}

function popover(): HTMLElement {
  const menu = document.body.querySelector<HTMLElement>('.browser-server-popover');
  assert.ok(menu, 'network popover not found');
  return menu;
}

test('browser-server menu exposes actual status, local/LAN URLs, warning, and live LAN toggle', () => {
  const requested: boolean[] = [];
  act(() => {
    render(h(BrowserServerMenu, {
      browserServer: RUNNING_LAN_STATE,
      commandsAvailable: true,
      onSetLanEnabled: (enabled) => requested.push(enabled),
    }), container);
  });
  openMenu();

  const menu = popover();
  assert.match(menu.textContent ?? '', /Running/);
  assert.match(menu.textContent ?? '', /2 browsers connected/);
  assert.match(menu.textContent ?? '', /LAN access is active/);
  assert.match(menu.textContent ?? '', /http:\/\/127\.0\.0\.1:1997\//);
  assert.match(menu.textContent ?? '', /http:\/\/192\.168\.1\.24:1997\//);
  assert.match(menu.textContent ?? '', /no authentication or TLS/i);

  const toggle = menu.querySelector('[role="switch"]');
  assert.equal(toggle?.getAttribute('aria-checked'), 'true');
  click(toggle);
  assert.deepEqual(requested, [false]);
});

test('browser-server menu omits the listener switch when the host lacks the capability', () => {
  // Legacy hosts omit the field entirely; standalone hosts report false.
  for (const state of [
    RUNNING_LAN_STATE,
    { ...RUNNING_LAN_STATE, serverToggleAvailable: false },
  ] as BrowserServerViewState[]) {
    act(() => {
      render(null, container);
    });
    act(() => {
      render(h(BrowserServerMenu, {
        browserServer: state,
        commandsAvailable: true,
        onSetLanEnabled: () => undefined,
        onSetServerEnabled: () => undefined,
      }), container);
    });
    openMenu();
    const switches = popover().querySelectorAll('[role="switch"]');
    assert.equal(switches.length, 1, 'only the LAN toggle is rendered');
    assert.equal(switches[0].getAttribute('aria-label'), 'Allow trusted LAN access');
    assert.doesNotMatch(popover().textContent ?? '', /Run browser server/);
  }
});

test('browser-server menu renders the listener switch from the persisted global preference', () => {
  const requested: boolean[] = [];
  const state: BrowserServerViewState = {
    ...RUNNING_LAN_STATE,
    lanEnabled: false,
    configuredLanEnabled: false,
    configuredEnabled: true,
    serverToggleAvailable: true,
  };
  act(() => {
    render(h(BrowserServerMenu, {
      browserServer: state,
      commandsAvailable: true,
      onSetLanEnabled: () => undefined,
      onSetServerEnabled: (enabled) => requested.push(enabled),
    }), container);
  });
  openMenu();

  const menu = popover();
  assert.match(menu.textContent ?? '', /Run browser server/);
  const serverSwitch = menu.querySelector('[aria-label="Run browser server"]');
  assert.ok(serverSwitch, 'the listener switch is rendered');
  assert.equal(serverSwitch.getAttribute('aria-checked'), 'true');
  click(serverSwitch);
  assert.deepEqual(requested, [false], 'the VS Code sidebar stops the listener without a confirm (not a browser surface)');
});

test('browser-server menu warns before a browser renderer disconnects itself by stopping the listener', () => {
  const requested: boolean[] = [];
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'pie-transport');
  meta.setAttribute('content', 'browser');
  document.head.appendChild(meta);
  try {
    const state: BrowserServerViewState = {
      ...RUNNING_LAN_STATE,
      lanEnabled: false,
      configuredLanEnabled: false,
      configuredEnabled: true,
      serverToggleAvailable: true,
    };
    act(() => {
      render(h(BrowserServerMenu, {
        browserServer: state,
        commandsAvailable: true,
        onSetLanEnabled: () => undefined,
        onSetServerEnabled: (enabled) => requested.push(enabled),
      }), container);
    });
    openMenu();

    const menu = popover();
    click(menu.querySelector('[aria-label="Run browser server"]'));
    assert.deepEqual(requested, [], 'the first click only arms the self-disconnect confirmation');
    assert.match(menu.textContent ?? '', /disconnects this Pie tab/);

    click(menu.querySelector('.browser-server-disconnect-confirm-button'));
    assert.deepEqual(requested, [false], 'the explicit confirm stops the listener');
  } finally {
    meta.remove();
  }
});

test('browser-server menu keeps a browser renderer connected when the confirm is declined', () => {
  const requested: boolean[] = [];
  const meta = document.createElement('meta');
  meta.setAttribute('name', 'pie-transport');
  meta.setAttribute('content', 'browser');
  document.head.appendChild(meta);
  try {
    const state: BrowserServerViewState = {
      ...RUNNING_LAN_STATE,
      lanEnabled: false,
      configuredLanEnabled: false,
      configuredEnabled: true,
      serverToggleAvailable: true,
    };
    act(() => {
      render(h(BrowserServerMenu, {
        browserServer: state,
        commandsAvailable: true,
        onSetLanEnabled: () => undefined,
        onSetServerEnabled: (enabled) => requested.push(enabled),
      }), container);
    });
    openMenu();

    const menu = popover();
    click(menu.querySelector('[aria-label="Run browser server"]'));
    click(popover().querySelectorAll('.browser-server-disconnect-actions button')[1]);
    assert.deepEqual(requested, [], 'declining keeps the listener running');
    assert.doesNotMatch(popover().textContent ?? '', /disconnects this Pie tab/);
  } finally {
    meta.remove();
  }
});

test('browser-server menu reflects a pending listener change and blocks toggling while pending', () => {
  const state: BrowserServerViewState = {
    ...RUNNING_LAN_STATE,
    running: false,
    localUrl: null,
    lanEnabled: false,
    configuredLanEnabled: false,
    lanUrls: [],
    configuredEnabled: false,
    serverToggleAvailable: true,
    changePending: true,
    pendingEnabled: true,
  };
  act(() => {
    render(h(BrowserServerMenu, {
      browserServer: state,
      commandsAvailable: true,
      onSetLanEnabled: () => undefined,
      onSetServerEnabled: () => undefined,
    }), container);
  });
  openMenu();
  const menu = popover();
  const serverSwitch = menu.querySelector<HTMLButtonElement>('[aria-label="Run browser server"]');
  assert.equal(serverSwitch?.getAttribute('aria-checked'), 'true', 'the requested value is reflected immediately');
  assert.equal(serverSwitch?.disabled, true);
  assert.match(menu.textContent ?? '', /Starting browser server/);
  assert.doesNotMatch(menu.textContent ?? '', /Restarting browser server/);
});

test('browser-server menu shows listener errors without claiming a running listener', () => {
  const state: BrowserServerViewState = {
    ...RUNNING_LAN_STATE,
    running: false,
    localUrl: null,
    lanEnabled: false,
    configuredLanEnabled: false,
    lanUrls: [],
    configuredEnabled: true,
    serverToggleAvailable: true,
    changeError: 'Could not apply the browser server setting. Check the Pie log for details.',
  };
  act(() => {
    render(h(BrowserServerMenu, {
      browserServer: state,
      commandsAvailable: true,
      onSetLanEnabled: () => undefined,
      onSetServerEnabled: () => undefined,
    }), container);
  });
  openMenu();
  const menu = popover();
  assert.match(menu.textContent ?? '', /Stopped/);
  assert.match(menu.textContent ?? '', /Could not apply the browser server setting/);
  assert.match(menu.innerHTML, /role="alert"/);
});

test('browser-server menu copies the selected URL and announces the result accessibly', async () => {
  act(() => {
    render(h(BrowserServerMenu, {
      browserServer: RUNNING_LAN_STATE,
      commandsAvailable: true,
      onSetLanEnabled: () => undefined,
    }), container);
  });
  openMenu();
  click(popover().querySelector('[aria-label="Copy LAN URL http://192.168.1.24:1997/"]'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(copied, ['http://192.168.1.24:1997/']);
  assert.match(popover().textContent ?? '', /LAN URL copied/);
});

test('browser-server menu shows restart/error feedback and locks toggling while pending', () => {
  const state: BrowserServerViewState = {
    ...RUNNING_LAN_STATE,
    changePending: true,
    pendingLanEnabled: false,
  };
  act(() => {
    render(h(BrowserServerMenu, {
      browserServer: state,
      commandsAvailable: true,
      onSetLanEnabled: () => undefined,
    }), container);
  });
  openMenu();
  const toggle = popover().querySelector<HTMLButtonElement>('[role="switch"]');
  assert.equal(toggle?.getAttribute('aria-checked'), 'false', 'pending requested value is reflected immediately');
  assert.equal(toggle?.disabled, true);
  assert.match(popover().textContent ?? '', /Restarting browser server/);

  act(() => {
    render(h(BrowserServerMenu, {
      browserServer: { ...state, changePending: false, pendingLanEnabled: null, changeError: 'Could not apply the network setting.' },
      commandsAvailable: true,
      onSetLanEnabled: () => undefined,
    }), container);
  });
  assert.match(popover().textContent ?? '', /Could not apply the network setting/);
  assert.match(popover().innerHTML, /role="alert"/);
});
