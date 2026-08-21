/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { ChatPrefs, McpServerInfo } from '../../../shared/protocol';
import { useAnchoredOverlay } from '../components/anchored-overlay';
import { Tooltip } from '../components/tooltip';
import { cx } from '../utils/cx';
import { McpServerList } from './mcp-server-list';
import type { OnSetPrefs } from './settings-menu-types';

/** Toolbar dropdown for MCP control: the global on/off switch plus per-server
 *  toggles. The backend guard enforces the global pref on every tool-set
 *  update (immediate); per-server toggles persist `disabled` overrides into
 *  `.pi/mcp.json` (the adapter's own mechanism) and apply on the next session
 *  reload / backend restart. The server list refreshes whenever the menu
 *  opens. */
export function McpToggleMenu({ prefs, mcpServers, mcpServersStatus, mcpPendingApply, onSetPrefs, onMcpListRequested, onMcpSetServerEnabled }: {
  prefs: ChatPrefs;
  mcpServers: McpServerInfo[];
  mcpServersStatus?: 'loading' | 'error' | 'ok';
  mcpPendingApply: boolean;
  onSetPrefs: OnSetPrefs;
  onMcpListRequested: () => void;
  onMcpSetServerEnabled: (name: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Refresh the server list every time the menu opens so the effective state
  // (including external config edits) is current. Cached entries render
  // immediately; the fetch replaces them when it lands.
  useEffect(() => {
    if (!open) return;
    onMcpListRequested();
  }, [open, onMcpListRequested]);

  useAnchoredOverlay({
    open,
    triggerRef,
    overlayRef: menuRef,
    preferredDirection: 'up',
    preferredWidth: 300,
    minHeight: 60,
    maxHeight: 220,
  });

  // Outside-click + Escape handling, wired only while the dropdown is open.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      const insideMenu = menuRef.current?.contains(target);
      const insideTrigger = triggerRef.current?.contains(target);
      if (!insideMenu && !insideTrigger) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div class="system-prompt-toggle-menu">
      <Tooltip content={open ? null : (prefs.mcpEnabled ? 'MCP on — click to toggle' : 'MCP off — click to toggle')} placement="top">
        <button
          ref={triggerRef}
          type="button"
          class={cx('system-prompt-toggle-trigger', 'mcp-toggle-trigger', open && 'open', prefs.mcpEnabled && 'active')}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="MCP"
          title={prefs.mcpEnabled ? 'MCP enabled' : 'MCP disabled'}
          onClick={() => setOpen((o) => !o)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M6.5 2v3M9.5 2v3" />
            <path d="M4.5 5h7v2.2a3.5 3.5 0 0 1-7 0V5Z" />
            <path d="M8 10.7V14" />
          </svg>
        </button>
      </Tooltip>

      {open && (
        <div ref={menuRef} class="system-prompt-toggle-dropdown" role="dialog" aria-label="MCP">
          <div class="system-prompt-toggle-header">
            <span class="system-prompt-toggle-title">MCP</span>
          </div>
          <div class="system-prompt-toggle-body">
            <button
              type="button"
              class={cx('toolbar-settings-item', prefs.mcpEnabled && 'checked')}
              role="checkbox"
              aria-checked={prefs.mcpEnabled}
              onClick={() => onSetPrefs({ mcpEnabled: !prefs.mcpEnabled })}
            >
              <span class="toolbar-settings-item-check" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={prefs.mcpEnabled ? '' : 'opacity:0'}>
                  <polyline points="2.5,6.5 5,9 10.5,3.5" />
                </svg>
              </span>
              <span class="toolbar-settings-item-label">
                <span class="system-prompt-toggle-entry-title">MCP enabled</span>
                <span class="system-prompt-toggle-entry-summary">
                  {prefs.mcpEnabled ? 'MCP servers exposed to the model' : 'MCP tools hidden — servers stay configured'}
                </span>
              </span>
            </button>
            {!prefs.mcpEnabled && (
              <div class="system-prompt-toggle-entry-summary mcp-global-off-hint">
                MCP is off — the servers below are hidden from the model until you re-enable it.
              </div>
            )}
            <McpServerList
              servers={mcpServers}
              loading={mcpServersStatus === 'loading'}
              error={mcpServersStatus === 'error'}
              pendingApply={mcpPendingApply}
              showRefresh
              onToggle={onMcpSetServerEnabled}
              onRefresh={onMcpListRequested}
            />
          </div>
        </div>
      )}
    </div>
  );
}
