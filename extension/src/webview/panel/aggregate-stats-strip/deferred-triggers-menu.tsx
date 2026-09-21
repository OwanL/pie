/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useState } from 'preact/hooks';

import { useMenuListeners } from '../components/useMenuListeners';
import { useMenuTriggerAria } from '../components/useMenuTriggerAria';
import { useMenuViewportClamp } from '../components/useMenuViewportClamp';

import type { DeferredTriggerView, SessionSummary, TriggerSpec } from '../../../shared/protocol';

/**
 * Popup listing every currently-active deferred trigger, opened from the
 * bottom status strip's waiting-trigger segment. Each item shows the target
 * session, creator when different, trigger condition, task message, elapsed
 * wait time, and a per-item cancel (×) button.
 *
 * Webview-local ephemeral UI (STATE_CONTRACT § Webview-Local State — the moral
 * equivalent of `contextMenu`): position + open state live in AppBody; this
 * component is a pure projection of the triggers it receives. Dismissed on
 * click-outside / Escape, mirroring the transcript context menu.
 *
 * The wait-time display ticks once per second while the menu is open
 * (allowlisted animation/telemetry state) so "waiting 2m" stays live without
 * depending on host snapshot frequency (the strip only re-renders ~7×/sec while
 * streaming, and not at all when idle).
 */

export interface DeferredTriggersMenuProps {
  triggers: DeferredTriggerView[];
  sessionByPath: Map<string, SessionSummary>;
  /** Click coordinates of the strip segment that opened the menu (viewport). */
  x: number;
  y: number;
  triggerEl?: HTMLElement | null;
  onCancel: (sessionPath: string, triggerId: string) => void;
  onClose: () => void;
}

export function DeferredTriggersMenu({
  triggers,
  sessionByPath,
  x,
  y,
  triggerEl,
  onCancel,
  onClose,
}: DeferredTriggersMenuProps) {
  const { ref, pos } = useMenuViewportClamp({
    x,
    y,
    triggerEl,
    restoreFocusOnClose: true,
    refocusKey: triggers.map((trigger) => trigger.id).join(','),
  });
  useMenuTriggerAria(triggerEl);
  // Tick once per second so the elapsed "waiting Nm" stays live while open.
  const [, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useMenuListeners(ref, onClose);

  return (
    <div
      ref={ref}
      class="block-context-menu deferred-triggers-menu"
      role="menu"
      aria-label="Pending deferred triggers"
      style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div class="deferred-triggers-menu-title">
        {triggers.length} pending deferred trigger{triggers.length === 1 ? '' : 's'}
      </div>
      <div class="deferred-triggers-menu-list">
        {triggers.map((t) => {
          const targetPath = t.targetSession ?? t.sessionPath;
          const target = sessionByPath.get(targetPath);
          const creator = sessionByPath.get(t.sessionPath);
          const name = target?.name ?? baseName(targetPath) ?? targetPath;
          const creatorName = creator?.name ?? baseName(t.sessionPath) ?? t.sessionPath;
          const message = t.message?.trim() || t.note.trim();
          return (
            <div class="deferred-triggers-menu-item" key={t.id}>
              <div class="deferred-triggers-menu-item-main">
                <div class="deferred-triggers-menu-item-head">
                  <span class="deferred-triggers-menu-item-name" title={targetPath}>{name}</span>
                  <span class="deferred-triggers-menu-item-kind">{formatTriggerSpecs(t.triggers, sessionByPath)}</span>
                </div>
                {message && (
                  <div class="deferred-triggers-menu-item-note" title={message}>{message}</div>
                )}
                {targetPath !== t.sessionPath && (
                  <div class="deferred-triggers-menu-item-wait" title={`Created by ${t.sessionPath}`}>
                    created by {creatorName}
                  </div>
                )}
                <div class="deferred-triggers-menu-item-wait">
                  {formatDeliveryState(t)} · waiting {formatElapsed(t.registeredAt)}
                </div>
              </div>
              <button
                class="context-menu-item deferred-triggers-menu-item-cancel"
                type="button"
                role="menuitem"
                aria-label={`Cancel deferred trigger for ${name}`}
                title="Cancel this deferred trigger"
                onClick={() => onCancel(t.sessionPath, t.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseName(p: string): string | null {
  if (!p) return null;
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function sessionLabel(sessionPath: string | undefined, sessionByPath: Map<string, SessionSummary>): string {
  if (!sessionPath) return 'any session';
  const s = sessionByPath.get(sessionPath);
  if (s?.name) return `“${s.name}”`;
  return baseName(sessionPath) ?? sessionPath;
}

/** Human-readable summary of a trigger's OR-specs (e.g. "timer 5m", "when “foo” finishes"). */
function formatTriggerSpecs(specs: TriggerSpec[], sessionByPath: Map<string, SessionSummary>): string {
  if (specs.length === 0) return 'unknown';
  return specs.map((s) => formatSpec(s, sessionByPath)).join(' or ');
}

function formatSpec(s: TriggerSpec, sessionByPath: Map<string, SessionSummary>): string {
  switch (s.kind) {
    case 'timer':
      return typeof s.ms === 'number' ? `timer ${formatMs(s.ms)}` : 'timer';
    case 'session_finished':
      return s.sessionPath
        ? `when ${sessionLabel(s.sessionPath, sessionByPath)} finishes`
        : 'when any session finishes';
    case 'user_input':
      return 'on user input';
    case 'command':
      return `when command returns true: ${formatCommand(s.command)} · cwd ${formatPath(s.cwd)} · every ${formatMs(s.intervalMs)} · timeout ${formatMs(s.timeoutMs)}`;
    default:
      return 'unknown';
  }
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const sec = ms / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.round(min)}m`;
  return `${(min / 60).toFixed(1)}h`;
}

function formatCommand(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (compact.length <= 140) return `“${compact}”`;
  return `“${compact.slice(0, 137)}…”`;
}

function formatPath(value: string): string {
  if (value.length <= 100) return value;
  return `…${value.slice(-97)}`;
}

function boundedDiagnostic(detail: string): string {
  const compact = detail.replace(/\s+/g, ' ').trim();
  if (compact.length <= 240) return compact;
  return `${compact.slice(0, 237)}…`;
}

function formatDeliveryState(trigger: DeferredTriggerView): string {
  if (trigger.deliveryState === 'pending' && trigger.deliveryDetail) {
    return boundedDiagnostic(trigger.deliveryDetail);
  }
  if (trigger.recoveryState === 'dead-owner-recovered') {
    return boundedDiagnostic(trigger.deliveryDetail ?? 'host exited before dispatch; delivery recovered and retryable');
  }
  if (trigger.recoveryState === 'acknowledgement-ambiguous') {
    return boundedDiagnostic(trigger.deliveryDetail ?? 'delivery acknowledgement pending; automatic retry blocked');
  }
  if (trigger.deliveryState === 'claimed') return boundedDiagnostic(trigger.deliveryDetail ?? 'delivery claimed');
  if (trigger.deliveryState === 'retryable') return boundedDiagnostic(trigger.deliveryDetail ?? 'delivery retryable');
  return 'pending';
}

function formatElapsed(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const elapsed = Date.now() - t;
  if (elapsed < 0) return '0s';
  const sec = elapsed / 1000;
  if (sec < 60) return `${Math.round(sec)}s`;
  const min = sec / 60;
  if (min < 60) return `${Math.floor(min)}m`;
  return `${Math.floor(min / 60)}h`;
}
