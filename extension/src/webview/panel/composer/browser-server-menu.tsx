/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import type { BrowserServerViewState } from '../../../shared/protocol';
import { useAnchoredOverlay } from '../components/anchored-overlay';
import { Tooltip } from '../components/tooltip';
import { cx } from '../utils/cx';

interface BrowserServerMenuProps {
  browserServer?: BrowserServerViewState;
  commandsAvailable: boolean;
  onSetLanEnabled: (enabled: boolean) => void;
  /** VS Code only: start/stop the shared localhost listener. Absent (or a
   *  host reporting `serverToggleAvailable: false`, e.g. standalone) hides
   *  the switch entirely so the sole UI can never be stopped. */
  onSetServerEnabled?: (enabled: boolean) => void;
}

const STOPPED_SERVER: BrowserServerViewState = {
  running: false,
  localUrl: null,
  port: null,
  clientCount: 0,
  lanEnabled: false,
  configuredLanEnabled: false,
  lanUrls: [],
  changePending: false,
  pendingLanEnabled: null,
  changeError: null,
};

/** Static renderer-surface fact read once from the host-stamped transport
 *  metadata. Browser renderers attached to a VS Code host would disconnect
 *  themselves by stopping the listener and must confirm first; DOM access is
 *  guarded so non-DOM test renders (renderToString) stay safe. */
function isBrowserRendererSurface(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('meta[name="pie-transport"]')?.getAttribute('content') === 'browser';
}

async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) throw new Error('Clipboard access is unavailable.');
}

export function BrowserServerMenu({
  browserServer = STOPPED_SERVER,
  commandsAvailable,
  onSetLanEnabled,
  onSetServerEnabled,
}: BrowserServerMenuProps) {
  const [open, setOpen] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  /** Armed one-shot confirmation for browser renderers attached to a VS Code
   *  host: stopping the listener would disconnect THIS tab. Transient local
   *  UI state (the moral equivalent of the open-menu transient). */
  const [confirmingStop, setConfirmingStop] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const configuredLanEnabled = browserServer.changePending && browserServer.pendingLanEnabled !== null
    ? browserServer.pendingLanEnabled
    : browserServer.configuredLanEnabled;
  const serverToggleAvailable = browserServer.serverToggleAvailable === true && onSetServerEnabled !== undefined;
  const serverChangePending = browserServer.changePending && browserServer.pendingEnabled != null;
  const configuredServerEnabled = serverChangePending
    ? browserServer.pendingEnabled === true
    : (browserServer.configuredEnabled ?? false);
  const toggleDisabled = !commandsAvailable || browserServer.changePending;
  const browserSurface = isBrowserRendererSurface();

  // A host-driven change (or closing the popover) retires the armed confirm.
  useEffect(() => {
    if (!open || !serverChangePending) setConfirmingStop(false);
  }, [open, serverChangePending]);

  useAnchoredOverlay({
    open,
    triggerRef,
    overlayRef: menuRef,
    preferredDirection: 'up',
    preferredWidth: 320,
    minHeight: 150,
    maxHeight: 390,
  });

  useEffect(() => {
    if (!open) return;
    const focusFrame = window.requestAnimationFrame(() => menuRef.current?.focus());
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
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
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  const handleServerSwitchClick = (): void => {
    if (!configuredServerEnabled) {
      // Starting the listener can never orphan a renderer.
      setConfirmingStop(false);
      onSetServerEnabled?.(true);
      return;
    }
    // A browser renderer attached to a VS Code host would disconnect THIS tab
    // by stopping the listener: arm an explicit confirmation first.
    if (browserSurface && !confirmingStop) {
      setConfirmingStop(true);
      return;
    }
    setConfirmingStop(false);
    onSetServerEnabled?.(false);
  };

  const confirmServerStop = (): void => {
    setConfirmingStop(false);
    onSetServerEnabled?.(false);
  };

  const copyUrl = async (label: string, url: string) => {
    try {
      await copyToClipboard(url);
      setCopyStatus(`${label} URL copied.`);
    } catch {
      setCopyStatus('Could not copy the URL.');
    }
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyStatus(''), 1800);
  };

  const handleTriggerKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    setOpen(true);
  };

  return (
    <div class="browser-server-menu">
      <Tooltip content={open ? null : 'Browser network access'} placement="top">
        <button
          ref={triggerRef}
          type="button"
          class={cx('system-prompt-toggle-trigger', 'browser-server-trigger', open && 'open', browserServer.configuredLanEnabled && 'active')}
          aria-label="Browser network access"
          aria-haspopup="dialog"
          aria-expanded={open}
          title="Browser network access"
          onClick={() => setOpen((previous) => !previous)}
          onKeyDown={handleTriggerKeyDown}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
            <path d="M2.2 6.3a8.5 8.5 0 0 1 11.6 0" />
            <path d="M4.7 8.8a4.9 4.9 0 0 1 6.6 0" />
            <path d="M7 11.2a1.5 1.5 0 0 1 2 0" />
            <circle cx="8" cy="13.2" r=".7" fill="currentColor" stroke="none" />
          </svg>
        </button>
      </Tooltip>

      {open && createPortal(
        <div ref={menuRef} class="browser-server-popover" role="dialog" aria-label="Browser network access" tabIndex={-1}>
          <div class="browser-server-popover-header">
            <span class="browser-server-popover-title">Browser server</span>
            <span class={cx('browser-server-status', browserServer.running ? 'is-running' : 'is-stopped')}>
              <span aria-hidden="true" class="browser-server-status-dot" />
              {browserServer.running ? 'Running' : 'Stopped'}
            </span>
          </div>

          <p class="browser-server-connection-count" aria-live="polite">
            {browserServer.running
              ? `${browserServer.clientCount} browser${browserServer.clientCount === 1 ? '' : 's'} connected`
              : 'The browser server is not running.'}
          </p>

          <div class="browser-server-access-state" role="status" aria-live="polite">
            {browserServer.lanEnabled ? 'LAN access is active.' : 'LAN access is not active.'}
          </div>

          {browserServer.localUrl && (
            <div class="browser-server-url-row">
              <span class="browser-server-url-label">Localhost</span>
              <code title={browserServer.localUrl}>{browserServer.localUrl}</code>
              <button type="button" class="browser-server-copy" aria-label="Copy localhost URL" onClick={() => void copyUrl('Localhost', browserServer.localUrl!)}>
                Copy
              </button>
            </div>
          )}

          {serverToggleAvailable && (
            <div class="browser-server-lan-control browser-server-enabled-control">
              <div class="browser-server-lan-copy">
                <span class="browser-server-lan-title">Run browser server</span>
                <span class="browser-server-lan-description">
                  Serves the Pie UI at the localhost URL. VS Code keeps working when it is off.
                </span>
              </div>
              <button
                type="button"
                class="browser-server-lan-switch"
                role="switch"
                aria-label="Run browser server"
                aria-checked={configuredServerEnabled}
                disabled={toggleDisabled}
                onClick={handleServerSwitchClick}
              >
                <span aria-hidden="true" />
              </button>
            </div>
          )}

          {confirmingStop && (
            <div class="browser-server-disconnect-confirm" role="alert">
              <p class="browser-server-disconnect-text">
                Stopping the browser server disconnects this Pie tab from the host.
              </p>
              <div class="browser-server-disconnect-actions">
                <button
                  type="button"
                  class="browser-server-disconnect-confirm-button"
                  onClick={confirmServerStop}
                >
                  Stop anyway
                </button>
                <button type="button" class="browser-server-copy" onClick={() => setConfirmingStop(false)}>
                  Keep running
                </button>
              </div>
            </div>
          )}

          {browserServer.lanEnabled && browserServer.lanUrls.map((url) => (
            <div key={url} class="browser-server-url-row">
              <span class="browser-server-url-label">LAN</span>
              <code title={url}>{url}</code>
              <button type="button" class="browser-server-copy" aria-label={`Copy LAN URL ${url}`} onClick={() => void copyUrl('LAN', url)}>
                Copy
              </button>
            </div>
          ))}

          {browserServer.lanEnabled && browserServer.lanUrls.length === 0 && (
            <p class="browser-server-no-lan-url">No private IPv4 network address is available.</p>
          )}

          <div class="browser-server-lan-control">
            <div class="browser-server-lan-copy">
              <span class="browser-server-lan-title">Allow trusted LAN access</span>
              <span class="browser-server-lan-description">Rebinds the browser server when changed.</span>
            </div>
            <button
              type="button"
              class="browser-server-lan-switch"
              role="switch"
              aria-label="Allow trusted LAN access"
              aria-checked={configuredLanEnabled}
              disabled={toggleDisabled}
              onClick={() => onSetLanEnabled(!configuredLanEnabled)}
            >
              <span aria-hidden="true" />
            </button>
          </div>

          {serverChangePending && (
            <div class="browser-server-feedback" role="status" aria-live="polite">
              <span class="browser-server-spinner" aria-hidden="true" />
              {browserServer.pendingEnabled ? 'Starting browser server…' : 'Stopping browser server…'}
            </div>
          )}

          {browserServer.changePending && !serverChangePending && (
            <div class="browser-server-feedback" role="status" aria-live="polite">
              <span class="browser-server-spinner" aria-hidden="true" />
              Restarting browser server…
            </div>
          )}

          {browserServer.changeError && (
            <div class="browser-server-error" role="alert">{browserServer.changeError}</div>
          )}

          {(browserServer.lanEnabled || browserServer.configuredLanEnabled) && (
            <p class="browser-server-disable-hint">
              Turning LAN access off disconnects LAN browser tabs. Reopen the localhost URL on this host.
            </p>
          )}

          <p class="browser-server-warning" role="note">
            LAN access has no authentication or TLS. Anyone on the trusted network can control Pie and access workspace files.
          </p>
          {copyStatus && <div class="browser-server-copy-status" role="status" aria-live="polite">{copyStatus}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
