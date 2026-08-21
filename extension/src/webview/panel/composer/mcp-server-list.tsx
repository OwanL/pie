/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { McpServerInfo } from '../../../shared/protocol';
import { cx } from '../utils/cx';

interface McpServerListProps {
  servers: McpServerInfo[];
  /** True while the list has not been fetched from the backend yet. */
  loading?: boolean;
  /** True after the last fetch/toggle failed. Cached rows (if any) stay
   *  visible; the error hint offers a Refresh so discovery is retryable. */
  error?: boolean;
  /** True after a toggle wrote an override that applies on the next session
   *  reload / backend restart. */
  pendingApply: boolean;
  /** Offer an inline Refresh action next to the non-empty list (the toolbar
   *  dropdown has no other refresh affordance; the Settings tab has one in
   *  its own section header). */
  showRefresh?: boolean;
  onToggle: (name: string, enabled: boolean) => void;
  onRefresh: () => void;
}

/** Per-server rows shared by the toolbar MCP dropdown and the Settings → MCP
 *  tab. Each row toggles the `disabled` override in `.pi/mcp.json` (the
 *  adapter's own mechanism); a toggle takes effect on the next session reload
 *  / backend restart, which the pending-apply hint communicates. */
export function McpServerList({ servers, loading = false, error = false, pendingApply, showRefresh = false, onToggle, onRefresh }: McpServerListProps) {
  if (loading && servers.length === 0) {
    return <div class="system-prompt-toggle-entry-summary">Loading servers…</div>;
  }
  if (error && servers.length === 0) {
    return (
      <div class="system-prompt-toggle-entry-summary">
        Couldn't load MCP servers.
        <button type="button" class="mcp-server-refresh" onClick={onRefresh}>Refresh</button>
      </div>
    );
  }
  if (servers.length === 0) {
    return (
      <div class="system-prompt-toggle-entry-summary">
        No MCP servers configured.
        <button type="button" class="mcp-server-refresh" onClick={onRefresh}>Refresh</button>
      </div>
    );
  }
  return (
    <div class="mcp-server-list">
      {showRefresh && (
        <div class="mcp-server-list-head">
          <span class="system-prompt-toggle-entry-summary">Configured servers</span>
          <button type="button" class="mcp-server-refresh" onClick={onRefresh}>Refresh</button>
        </div>
      )}
      {servers.map((server) => (
        <button
          key={server.name}
          type="button"
          class={cx('toolbar-settings-item', !server.disabled && 'checked')}
          role="checkbox"
          aria-checked={!server.disabled}
          onClick={() => onToggle(server.name, server.disabled)}
          title={server.disabled ? `${server.name} is disabled` : `${server.name} is enabled`}
        >
          <span class="toolbar-settings-item-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={server.disabled ? 'opacity:0' : ''}>
              <polyline points="2.5,6.5 5,9 10.5,3.5" />
            </svg>
          </span>
          <span class="toolbar-settings-item-label">
            <span class="system-prompt-toggle-entry-title">{server.name}</span>
            <span class="system-prompt-toggle-entry-summary">
              {server.disabled ? 'Disabled — hidden from the model' : 'Enabled — connects when used'}
            </span>
          </span>
        </button>
      ))}
      {error && (
        <div class="system-prompt-toggle-entry-summary mcp-server-error">
          Couldn't refresh — showing the last known list.
          <button type="button" class="mcp-server-refresh" onClick={onRefresh}>Refresh</button>
        </div>
      )}
      {pendingApply && (
        <div class="system-prompt-toggle-entry-summary mcp-pending-apply">
          Toggle applies on the next session reload / backend restart.
        </div>
      )}
    </div>
  );
}
