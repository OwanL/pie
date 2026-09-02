/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect } from 'preact/hooks';

import type { ChatPrefs, McpServerInfo } from '../../../shared/protocol';
import { McpServerList } from './mcp-server-list';
import { SettingCheckbox } from '../components/setting-checkbox';
import type { OnSetPrefs } from './settings-menu-types';

export const MCP_SETTING_LABELS = [
  'MCP enabled',
  'Servers',
  'Server config',
] as const;

/** Settings section for MCP (Model Context Protocol) servers — the GLOBAL
 *  controls. These apply to every session: the pi-mcp-adapter package's
 *  tools exposed through the `mcp` proxy tool are guarded host-wide by the
 *  `mcpEnabled` pref, and the per-server rows persist `disabled` overrides
 *  into `.pi/mcp.json` (the adapter's own mechanism — never touches
 *  credentials), applying on the next session reload / backend restart.
 *  Session-scoped server toggles live in the toolbar's MCP dropdown. */
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
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Global — applies to every session</span>
        </div>
        <SettingCheckbox
          label="MCP enabled"
          checked={prefs.mcpEnabled}
          onChange={() => onSetPrefs({ mcpEnabled: !prefs.mcpEnabled })}
        />
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
