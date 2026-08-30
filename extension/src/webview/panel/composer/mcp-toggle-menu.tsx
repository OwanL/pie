/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { ChatPrefs, McpServerInfo } from '../../../shared/protocol';
import { useAnchoredOverlay } from '../components/anchored-overlay';
import { Tooltip } from '../components/tooltip';
import { cx } from '../utils/cx';
import { McpServerList } from './mcp-server-list';

/** Toolbar dropdown for MCP control: per-server toggles scoped to the CURRENT
 *  session only. The global on/off switch and the file-backed (`disabled`
 *  override in `.pi/mcp.json`) per-server controls live in Settings → MCP.
 *  A toggle here writes a session-scoped override and recycles this session's
 *  worker immediately when it is idle; when a run is active the host keeps a
 *  pending hint until the next idle recycle / session reload. The server list
 *  refreshes whenever the menu opens. */
export function McpToggleMenu({ prefs, mcpServers, mcpServersStatus, mcpPendingApply, onMcpListRequested, onMcpSetServerEnabledForSession }: {
  prefs: ChatPrefs;
  /** Effective per-session list: global state with the active session's own
   *  overrides already merged (a row can only be hidden further or un-hidden
   *  for this session). */
  mcpServers: McpServerInfo[];
  mcpServersStatus?: 'loading' | 'error' | 'ok';
  mcpPendingApply: boolean;
  onMcpListRequested: () => void;
  onMcpSetServerEnabledForSession: (name: string, enabled: boolean) => void;
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
      <Tooltip content={open ? null : (prefs.mcpEnabled ? 'MCP on — server toggles apply to this session' : 'MCP off (global) — change in Settings → MCP')} placement="top">
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
        <div ref={menuRef} class="system-prompt-toggle-dropdown" role="dialog" aria-label="MCP servers">
          <div class="system-prompt-toggle-header">
            <span class="system-prompt-toggle-title">MCP servers</span>
            <span class="system-prompt-toggle-entry-summary">This session only</span>
          </div>
          <div class="system-prompt-toggle-body">
            {prefs.mcpEnabled ? (
              <>
                <McpServerList
                  servers={mcpServers}
                  loading={mcpServersStatus === 'loading'}
                  error={mcpServersStatus === 'error'}
                  pendingApply={mcpPendingApply}
                  showRefresh
                  onToggle={onMcpSetServerEnabledForSession}
                  onRefresh={onMcpListRequested}
                />
                {mcpPendingApply && (
                  <div class="system-prompt-toggle-entry-summary mcp-global-off-hint">
                    A change is waiting — it applies after this session reloads (or when the current run ends).
                  </div>
                )}
              </>
            ) : (
              <div class="system-prompt-toggle-entry-summary mcp-global-off-hint">
                MCP is turned off globally. Enable it (and manage the global server list) in Settings → MCP.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}