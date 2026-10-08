/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect } from 'preact/hooks';

import type { ChatPrefs, McpServerInfo } from '../../lib/protocol/index.js';
import { McpServerList } from '../composer/mcp-server-list';
import { SettingCheckbox } from './setting-checkbox';
import { SettingsHelp } from './settings-help';
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
          hint="Exposes configured MCP servers through the mcp tool in every session. Turning it off hides tools immediately; servers stay configured and return when re-enabled."
          onChange={() => onSetPrefs({ mcpEnabled: !prefs.mcpEnabled })}
        />

        {/* Per-server toggles */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Servers<SettingsHelp label="Servers">Toggling a server writes a disabled override to .pi/mcp.json. It applies on the next session reload or backend restart; the server stays configured.</SettingsHelp></span>
            <button type="button" class="mcp-server-refresh" onClick={onMcpListRequested}>Refresh</button>
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
            <span class="toolbar-settings-ui-control-label">Server config<SettingsHelp label="Server config">Servers are defined in ~/.config/mcp/mcp.json (all projects), .mcp.json (project), or .pi/mcp.json (project overrides). See docs/operations/MCP.md for the full reference.</SettingsHelp></span>
          </div>
        </div>
      </div>
    </div>
  );
}
