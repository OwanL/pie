/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect } from 'preact/hooks';

import type { ChatPrefs, McpServerInfo } from '../../../shared/protocol';
import { McpServerList } from './mcp-server-list';
import type { OnSetPrefs } from './settings-menu-types';

/** Settings section for MCP (Model Context Protocol) servers.
 *
 *  The pi-mcp-adapter package (loaded via `packages`) exposes configured MCP
 *  servers to the model through the `mcp` proxy tool. The global toggle below
 *  is enforced by a backend guard that strips the adapter's tools from every
 *  active tool set, so servers stay configured in their mcp.json files but the
 *  model never sees the tools while MCP is off.
 *
 *  Per-server rows persist `disabled` overrides into `.pi/mcp.json` (the
 *  adapter's own mechanism — never touches credentials) and take effect on
 *  the next session reload / backend restart. */
export function McpSection({ prefs, mcpServers, mcpServersStatus, mcpPendingApply, onSetPrefs, onMcpListRequested, onMcpSetServerEnabled }: {
  prefs: ChatPrefs;
  mcpServers: McpServerInfo[];
  mcpServersStatus?: 'loading' | 'error' | 'ok';
  mcpPendingApply: boolean;
  onSetPrefs: OnSetPrefs;
  onMcpListRequested: () => void;
  onMcpSetServerEnabled: (name: string, enabled: boolean) => void;
}) {
  // Refresh the effective server list whenever the MCP tab is opened so
  // external config edits are reflected.
  useEffect(() => {
    onMcpListRequested();
  }, [onMcpListRequested]);

  return (
    <div class="toolbar-settings-ext-settings">
      <div class="toolbar-settings-list">
        {/* Global on/off */}
        <button
          class={`toolbar-settings-item${prefs.mcpEnabled ? ' checked' : ''}`}
          type="button"
          role="checkbox"
          aria-checked={prefs.mcpEnabled}
          onClick={() => onSetPrefs({ mcpEnabled: !prefs.mcpEnabled })}
        >
          <span class="toolbar-settings-item-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={prefs.mcpEnabled ? '' : 'opacity:0'}>
              <polyline points="2.5,6.5 5,9 10.5,3.5" />
            </svg>
          </span>
          <span class="toolbar-settings-item-label">MCP enabled</span>
        </button>
        <div class="toolbar-settings-item-hint">
          Exposes configured MCP servers to the model through the mcp tool. Turning it off hides the
          tools immediately — servers stay configured and are re-exposed when re-enabled.
        </div>

        {/* Per-server toggles */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Servers</span>
            <button type="button" class="mcp-server-refresh" onClick={onMcpListRequested}>Refresh</button>
          </div>
          <div class="toolbar-settings-item-hint">
            Toggling a server writes a <span class="toolbar-settings-mono">disabled</span> override to{' '}
            <span class="toolbar-settings-mono">.pi/mcp.json</span> and applies on the next session
            reload / backend restart. Servers stay configured in their mcp.json files.
          </div>
          {!prefs.mcpEnabled && (
            <div class="toolbar-settings-item-hint mcp-global-off-hint">
              MCP is off — the servers below are hidden from the model until you re-enable it.
            </div>
          )}
          <McpServerList
            servers={mcpServers}
            loading={mcpServersStatus === 'loading'}
            error={mcpServersStatus === 'error'}
            pendingApply={mcpPendingApply}
            onToggle={onMcpSetServerEnabled}
            onRefresh={onMcpListRequested}
          />
        </div>

        {/* Where servers are configured */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Server config</span>
          </div>
          <div class="toolbar-settings-item-hint">
            Servers are defined in <span class="toolbar-settings-mono">~/.config/mcp/mcp.json</span> (all
            projects), <span class="toolbar-settings-mono">.mcp.json</span> (project), or{' '}
            <span class="toolbar-settings-mono">.pi/mcp.json</span> (project overrides). See{' '}
            <span class="toolbar-settings-mono">docs/MCP.md</span> for the full reference.
          </div>
        </div>
      </div>
    </div>
  );
}
