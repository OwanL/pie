/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useMenuListeners } from '../lib/components/useMenuListeners';
import { useMenuViewportClamp } from '../lib/components/useMenuViewportClamp';
import { useMenuTriggerAria } from '../lib/components/useMenuTriggerAria';
import type { SnoozedSession } from './snooze';

function SnoozedMenu({ sessions, trigger, onRestore, onClose, available }: {
  sessions: SnoozedSession[];
  trigger: HTMLElement;
  onRestore: (path: string) => void;
  onClose: () => void;
  available: boolean;
}) {
  const rect = trigger.getBoundingClientRect();
  const { ref, pos } = useMenuViewportClamp({ x: rect.right, y: rect.bottom,
    triggerEl: trigger, restoreFocusOnClose: true, refocusKey: sessions.map((s) => s.path).join(',') });
  // Remember the focused row before the host publishes membership changes.
  // Prefer its successor, or predecessor when the final row disappears.
  const previousPaths = useRef(sessions.map((session) => session.path));
  const focusedPath = useRef<string | null>(null);
  useLayoutEffect(() => {
    const paths = sessions.map((session) => session.path);
    const removedIndex = previousPaths.current.indexOf(focusedPath.current ?? '');
    if (removedIndex >= 0 && !paths.includes(focusedPath.current!)) {
      const neighbor = paths[Math.min(removedIndex, paths.length - 1)];
      const row = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[data-session-path]') ?? [])
        .find((item) => item.dataset.sessionPath === neighbor);
      row?.focus();
    }
    previousPaths.current = paths;
  }, [sessions]);
  useMenuTriggerAria(trigger);
  useMenuListeners(ref, onClose);
  return (
    <div ref={ref} class="block-context-menu snoozed-sessions-menu" role="menu"
      aria-label="Snoozed sessions" style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}>
      <div class="session-tab-context-title">Snoozed sessions · select to restore early</div>
      {sessions.map((session) => (
        <button key={session.path} class="context-menu-item snoozed-session-item" role="menuitem" type="button"
          disabled={!available} title={session.name} data-session-path={session.path}
          onFocus={() => { focusedPath.current = session.path; }}
          aria-label={`Restore early: ${session.name}`}
          onClick={() => onRestore(session.path)}>
          <span class="snoozed-session-details">
            <span class="snoozed-session-name">{session.name}</span>
            <time dateTime={new Date(session.wakeAt).toISOString()}>
              Wakes {new Date(session.wakeAt).toLocaleString(undefined, {
                weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
              })}
            </time>
          </span>
        </button>
      ))}
    </div>
  );
}

/** Only the overlay is local; wake/restore membership always comes from the host. */
export function SnoozedSessionsAction({ sessions, onRestore, available, fallbackFocusRef }: {
  sessions: SnoozedSession[];
  onRestore: (path: string) => void;
  available: boolean;
  fallbackFocusRef: { current: HTMLButtonElement | null };
}) {
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setTrigger(null), []);
  useEffect(() => {
    if (sessions.length !== 0) return;
    if (trigger) fallbackFocusRef.current?.focus({ preventScroll: true });
    close();
  }, [sessions.length, trigger, fallbackFocusRef, close]);
  if (sessions.length === 0) return null;
  return <>
    <button class="session-tabs-new" type="button" title="Manage snoozed sessions"
      aria-label="Manage snoozed sessions" aria-haspopup="menu" aria-expanded={!!trigger}
      onClick={(event) => setTrigger(trigger ? null : event.currentTarget)}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
        <circle cx="8" cy="8" r="6" /><path d="M8 4v4h3" />
      </svg>
    </button>
    {trigger && <SnoozedMenu sessions={sessions} trigger={trigger} onRestore={onRestore}
      onClose={close} available={available} />}
  </>;
}
