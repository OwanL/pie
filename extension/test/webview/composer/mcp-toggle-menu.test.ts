import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from '../../_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { McpServerList } from '../../../src/webview/panel/composer/mcp-server-list';
import { McpSection } from '../../../src/webview/panel/composer/settings-menu-mcp';
import { McpToggleMenu } from '../../../src/webview/panel/composer/mcp-toggle-menu';
import { DEFAULT_CHAT_PREFS } from '../../../src/shared/protocol';
import type { McpServerInfo } from '../../../src/shared/protocol';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

function click(el: Element | null): void {
  assert.ok(el, 'target element not found');
  el!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

const SERVERS: McpServerInfo[] = [
  { name: 'jira', disabled: false },
  { name: 'echo', disabled: true },
];

test('McpServerList renders one row per server with the effective state', () => {
  act(() => {
    render(h(McpServerList, {
      servers: SERVERS,
      pendingApply: false,
      onToggle: () => undefined,
      onRefresh: () => undefined,
    }), container);
  });
  const html = container.innerHTML;
  assert.match(html, /jira/);
  assert.match(html, /echo/);
  const rows = container.querySelectorAll('[role="checkbox"]');
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.getAttribute('aria-checked'), 'true', 'enabled server is checked');
  assert.equal(rows[1]?.getAttribute('aria-checked'), 'false', 'disabled server is unchecked');
});

test('McpServerList toggles emit (name, enabled) — clicking a disabled server enables it', () => {
  const calls: Array<{ name: string; enabled: boolean }> = [];
  act(() => {
    render(h(McpServerList, {
      servers: SERVERS,
      pendingApply: false,
      onToggle: (name, enabled) => calls.push({ name, enabled }),
      onRefresh: () => undefined,
    }), container);
  });
  click(container.querySelectorAll('[role="checkbox"]')[1] as Element);
  assert.deepEqual(calls, [{ name: 'echo', enabled: true }]);
  click(container.querySelectorAll('[role="checkbox"]')[0] as Element);
  assert.deepEqual(calls[1], { name: 'jira', enabled: false });
});

test('McpServerList shows the pending-apply hint and an empty state', () => {
  act(() => {
    render(h(McpServerList, {
      servers: SERVERS,
      pendingApply: true,
      onToggle: () => undefined,
      onRefresh: () => undefined,
    }), container);
  });
  assert.match(container.innerHTML, /applies on the next session reload/);

  render(null, container);
  act(() => {
    render(h(McpServerList, {
      servers: [],
      pendingApply: false,
      onToggle: () => undefined,
      onRefresh: () => undefined,
    }), container);
  });
  assert.match(container.innerHTML, /No MCP servers configured/);
});

test('McpServerList shows a loading state instead of the empty state while discovery is in flight', () => {
  act(() => {
    render(h(McpServerList, {
      servers: [],
      loading: true,
      pendingApply: false,
      onToggle: () => undefined,
      onRefresh: () => undefined,
    }), container);
  });
  assert.match(container.innerHTML, /Loading servers/);
  assert.doesNotMatch(container.innerHTML, /No MCP servers configured/);
});

test('McpServerList shows an error state with Refresh when discovery failed and no rows are cached', () => {
  const refreshes: string[] = [];
  act(() => {
    render(h(McpServerList, {
      servers: [],
      error: true,
      pendingApply: false,
      onToggle: () => undefined,
      onRefresh: () => refreshes.push('refresh'),
    }), container);
  });
  assert.match(container.innerHTML, /Couldn't load MCP servers/);
  assert.doesNotMatch(container.innerHTML, /No MCP servers configured/);
  click(container.querySelector('.mcp-server-refresh') as Element);
  assert.deepEqual(refreshes, ['refresh'], 'the error state must offer a Refresh action');
});

test('McpServerList keeps cached rows visible on error and offers Refresh', () => {
  const refreshes: string[] = [];
  act(() => {
    render(h(McpServerList, {
      servers: SERVERS,
      error: true,
      pendingApply: false,
      onToggle: () => undefined,
      onRefresh: () => refreshes.push('refresh'),
    }), container);
  });
  assert.match(container.innerHTML, /jira/);
  assert.match(container.innerHTML, /echo/);
  assert.match(container.innerHTML, /Couldn't refresh/);
  const rows = container.querySelectorAll('[role="checkbox"]');
  assert.equal(rows.length, 2, 'cached rows must remain toggleable on error');
  click(container.querySelector('.mcp-server-error .mcp-server-refresh') as Element);
  assert.deepEqual(refreshes, ['refresh']);
});

test('McpServerList offers an inline Refresh in the non-empty state only when showRefresh is set', () => {
  act(() => {
    render(h(McpServerList, {
      servers: SERVERS,
      pendingApply: false,
      showRefresh: true,
      onToggle: () => undefined,
      onRefresh: () => undefined,
    }), container);
  });
  const refresh = container.querySelector('.mcp-server-list-head .mcp-server-refresh');
  assert.ok(refresh, 'non-empty toolbar list must offer Refresh');
  assert.match(container.innerHTML, /Configured servers/);

  render(null, container);
  act(() => {
    render(h(McpServerList, {
      servers: SERVERS,
      pendingApply: false,
      onToggle: () => undefined,
      onRefresh: () => undefined,
    }), container);
  });
  assert.equal(container.querySelector('.mcp-server-list-head .mcp-server-refresh'), null,
    'the Settings tab keeps its own header Refresh and must not double up');
});

test('McpSection lists servers under the global toggle and refreshes on mount', () => {
  const refreshCalls: string[] = [];
  act(() => {
    render(h(McpSection, {
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: SERVERS,
      mcpPendingApply: false,
      onSetPrefs: () => undefined,
      onMcpListRequested: () => refreshCalls.push('refresh'),
      onMcpSetServerEnabled: () => undefined,
    }), container);
  });
  // Mount effect fired a refresh.
  assert.equal(refreshCalls.length, 1);
  assert.match(container.innerHTML, /MCP enabled/);
  assert.match(container.innerHTML, /jira/);
  assert.match(container.innerHTML, /echo/);
});

test('McpSection keeps server rows visible and manageable while the global switch is off', () => {
  const toggles: Array<{ name: string; enabled: boolean }> = [];
  act(() => {
    render(h(McpSection, {
      prefs: { ...DEFAULT_CHAT_PREFS, mcpEnabled: false },
      mcpServers: SERVERS,
      mcpPendingApply: false,
      onSetPrefs: () => undefined,
      onMcpListRequested: () => undefined,
      onMcpSetServerEnabled: (name, enabled) => toggles.push({ name, enabled }),
    }), container);
  });
  // Rows stay visible and toggleable even though the global switch is off.
  assert.match(container.innerHTML, /jira/);
  assert.match(container.innerHTML, /echo/);
  assert.match(container.innerHTML, /hidden from the model until you re-enable it/);
  const rows = container.querySelectorAll('.toolbar-settings-ui-control [role="checkbox"]');
  assert.equal(rows.length, 2, 'per-server rows must remain rendered');
  click(rows[1] as Element);
  assert.deepEqual(toggles, [{ name: 'echo', enabled: true }]);
});

test('McpSection surfaces the discovery error state while keeping cached rows visible', () => {
  act(() => {
    render(h(McpSection, {
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: SERVERS,
      mcpServersStatus: 'error',
      mcpPendingApply: false,
      onSetPrefs: () => undefined,
      onMcpListRequested: () => undefined,
      onMcpSetServerEnabled: () => undefined,
    }), container);
  });
  assert.match(container.innerHTML, /jira/);
  assert.match(container.innerHTML, /Couldn't refresh/);
});

test('McpSection shows the loading state before the first fetch lands', () => {
  act(() => {
    render(h(McpSection, {
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: [],
      mcpServersStatus: 'loading',
      mcpPendingApply: false,
      onSetPrefs: () => undefined,
      onMcpListRequested: () => undefined,
      onMcpSetServerEnabled: () => undefined,
    }), container);
  });
  assert.match(container.innerHTML, /Loading servers/);
  assert.doesNotMatch(container.innerHTML, /No MCP servers configured/);
});

test('McpToggleMenu renders per-session server rows and requests a fresh list on open', () => {
  const refreshCalls: string[] = [];
  act(() => {
    render(h(McpToggleMenu, {
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: SERVERS,
      mcpPendingApply: false,
      onMcpListRequested: () => refreshCalls.push('refresh'),
      onMcpSetServerEnabledForSession: () => undefined,
    }), container);
  });
  // Closed: trigger only, no rows, no refresh yet.
  assert.equal(refreshCalls.length, 0);
  assert.doesNotMatch(container.innerHTML, /jira/);

  // Open the dropdown.
  act(() => {
    click(container.querySelector('.mcp-toggle-trigger') as Element);
  });
  assert.equal(refreshCalls.length, 1, 'opening the menu requests a fresh list');
  assert.match(container.innerHTML, /jira/);
  assert.match(container.innerHTML, /echo/);
  assert.match(container.innerHTML, /This session only/, 'the dropdown is explicitly session-scoped');
  assert.ok(container.querySelector('.mcp-server-list-head .mcp-server-refresh'),
    'the toolbar list offers Refresh even when non-empty');
});

test('McpToggleMenu toggles are session-scoped and the dropdown has no global switch', () => {
  const toggles: Array<{ name: string; enabled: boolean }> = [];
  act(() => {
    render(h(McpToggleMenu, {
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: SERVERS,
      mcpPendingApply: false,
      onMcpListRequested: () => undefined,
      onMcpSetServerEnabledForSession: (name: string, enabled: boolean) => toggles.push({ name, enabled }),
    }), container);
  });
  act(() => {
    click(container.querySelector('.mcp-toggle-trigger') as Element);
  });
  assert.doesNotMatch(container.innerHTML, /entry-title">MCP enabled</,
    'the global on/off switch lives in Settings → MCP, not in the toolbar dropdown');
  const rows = container.querySelectorAll('.system-prompt-toggle-dropdown [role="checkbox"]');
  assert.equal(rows.length, 2, 'two per-server rows, no global switch row');
  click(rows[1] as Element);
  assert.deepEqual(toggles, [{ name: 'echo', enabled: true }]);
});

test('McpToggleMenu shows the session pending-apply hint after a refused recycle', () => {
  act(() => {
    render(h(McpToggleMenu, {
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: SERVERS,
      mcpPendingApply: true,
      onMcpListRequested: () => undefined,
      onMcpSetServerEnabledForSession: () => undefined,
    }), container);
  });
  act(() => {
    click(container.querySelector('.mcp-toggle-trigger') as Element);
  });
  assert.match(container.innerHTML, /waiting/);
  assert.match(container.innerHTML, /session reloads/);
});

test('McpToggleMenu defers to the global switch while MCP is globally off', () => {
  const toggles: Array<{ name: string; enabled: boolean }> = [];
  act(() => {
    render(h(McpToggleMenu, {
      prefs: { ...DEFAULT_CHAT_PREFS, mcpEnabled: false },
      mcpServers: SERVERS,
      mcpPendingApply: false,
      onMcpListRequested: () => undefined,
      onMcpSetServerEnabledForSession: (name: string, enabled: boolean) => toggles.push({ name, enabled }),
    }), container);
  });
  act(() => {
    click(container.querySelector('.mcp-toggle-trigger') as Element);
  });
  assert.match(container.innerHTML, /MCP is turned off globally/);
  assert.doesNotMatch(container.innerHTML, /jira/, 'no server rows while MCP is globally off');
  assert.equal(container.querySelectorAll('.system-prompt-toggle-dropdown [role="checkbox"]').length, 0);
});

test('McpToggleMenu shows the loading state instead of the empty state while discovery is in flight', () => {
  act(() => {
    render(h(McpToggleMenu, {
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: [],
      mcpServersStatus: 'loading',
      mcpPendingApply: false,
      onMcpListRequested: () => undefined,
      onMcpSetServerEnabledForSession: () => undefined,
    }), container);
  });
  act(() => {
    click(container.querySelector('.mcp-toggle-trigger') as Element);
  });
  assert.match(container.innerHTML, /Loading servers/);
  assert.doesNotMatch(container.innerHTML, /No MCP servers configured/);
});

test('McpToggleMenu shows the error state with Refresh when discovery failed', () => {
  const refreshes: string[] = [];
  act(() => {
    render(h(McpToggleMenu, {
      prefs: DEFAULT_CHAT_PREFS,
      mcpServers: [],
      mcpServersStatus: 'error',
      mcpPendingApply: false,
      onMcpListRequested: () => refreshes.push('refresh'),
      onMcpSetServerEnabledForSession: () => undefined,
    }), container);
  });
  act(() => {
    click(container.querySelector('.mcp-toggle-trigger') as Element);
  });
  assert.match(container.innerHTML, /Couldn't load MCP servers/);
  assert.doesNotMatch(container.innerHTML, /No MCP servers configured/);
  const before = refreshes.length;
  click(container.querySelector('.mcp-server-refresh') as Element);
  assert.equal(refreshes.length, before + 1, 'the error state must offer a Refresh action');
});
