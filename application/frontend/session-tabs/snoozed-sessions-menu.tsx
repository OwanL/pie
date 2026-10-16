/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useMenuListeners } from '../lib/components/useMenuListeners';
import { useMenuViewportClamp } from '../lib/components/useMenuViewportClamp';
import { useMenuTriggerAria, getContextMenuTrigger } from '../lib/components/useMenuTriggerAria';
import type { SnoozedSession } from './snooze';

/** Entry menu state is a point-in-time overlay; membership stays host-owned. */
interface SnoozedEntryMenuState {
  path: string;
  name: string;
  x: number;
  y: number;
  triggerEl: HTMLElement;
}

function SnoozedEntryMenu({ session, x, y, triggerEl, onRestore, onCloseSession, onClose, onNode }: {
  session: { path: string; name: string };
  x: number;
  y: number;
  triggerEl: HTMLElement;
  onRestore: (path: string) => void;
  onCloseSession?: (path: string) => void;
  onClose: () => void;
  onNode?: (node: HTMLDivElement | null) => void;
}) {
  const { ref, pos } = useMenuViewportClamp({
    x, y, triggerEl, restoreFocusOnClose: true,
  });
  useMenuListeners(ref, onClose);
  return (
    <div ref={(node) => { ref.current = node; onNode?.(node); }} class="block-context-menu snoozed-entry-context-menu"
      role="menu" aria-label={`${session.name} snoozed session actions`}
      style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}>
      <div class="session-tab-context-title" title={session.name}>{session.name}</div>
      <button class="context-menu-item" role="menuitem" type="button"
        onClick={() => { onRestore(session.path); onClose(); }}>
        Restore early
      </button>
      {onCloseSession && (
        <button class="context-menu-item" role="menuitem" type="button"
          title="Close the session and remove it from the snoozed list"
          onClick={() => { onCloseSession(session.path); onClose(); }}>
          Close
        </button>
      )}
    </div>
  );
}

function SnoozedMenu({ sessions, trigger, onRestore, onCloseSession, onClose, available }: {
  sessions: SnoozedSession[];
  trigger: HTMLElement;
  onRestore: (path: string) => void;
  onCloseSession?: (path: string) => void;
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
  useMenuListeners(ref, onClose, {
    onOutsideClick: (event) => {
      // The entry menu is a nested overlay: keep the manager open while the
      // pointer interacts inside it and let only the entry menu dismiss.
      if (ref.current?.contains(event.target as Node) || entryNode.current?.contains(event.target as Node)) return;
      onClose();
    },
  });
  // Per-entry Restore/Close overlay anchored to a right-clicked row. The node
  // ref is only used for outside-click containment; the entry menu owns its
  // own dismissal and focus lifecycle.
  const entryNode = useRef<HTMLDivElement | null>(null);
  const [entry, setEntry] = useState<SnoozedEntryMenuState | null>(null);
  const closeEntry = useCallback(() => setEntry(null), []);
  useMenuTriggerAria(entry?.triggerEl, !!entry);
  useEffect(() => () => { entryNode.current = null; }, []);
  useLayoutEffect(() => {
    if (entry && (!available || !sessions.some((session) => session.path === entry.path))) closeEntry();
  }, [sessions, available, entry, closeEntry]);
  const openEntry = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const triggerEl = getContextMenuTrigger(event);
    if (!triggerEl) return;
    if (!available) return;
    // Keyboard-triggered context menus (Menu key / Shift+F10) carry no pointer
    // coordinates; anchor to the row like the manager trigger.
    const keyboard = event.clientX === 0 && event.clientY === 0;
    const rowRect = triggerEl.getBoundingClientRect();
    focusedPath.current = triggerEl.dataset.sessionPath ?? null;
    setEntry({
      path: (triggerEl as HTMLButtonElement).dataset.sessionPath ?? '',
      name: sessions.find((session) => session.path === (triggerEl as HTMLButtonElement).dataset.sessionPath)?.name ?? '',
      x: keyboard ? rowRect.right : event.clientX,
      y: keyboard ? rowRect.bottom : event.clientY,
      triggerEl,
    });
  };
  return (
    <div ref={ref} class="block-context-menu snoozed-sessions-menu" role="menu"
      aria-label="Snoozed sessions" style={`position:fixed;top:${pos.top}px;left:${pos.left}px`}>
      <div class="session-tab-context-title">Snoozed sessions · select to restore early</div>
      {sessions.map((session) => (
        <button key={session.path} class="context-menu-item snoozed-session-item" role="menuitem" type="button"
          disabled={!available} title={session.name} data-session-path={session.path}
          onFocus={() => { focusedPath.current = session.path; }}
          aria-label={`Restore early: ${session.name}`}
          onClick={() => onRestore(session.path)}
          onContextMenu={openEntry}
          onKeyDown={(event) => {
            if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
          }}>
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
      {entry && available && sessions.some((session) => session.path === entry.path) &&
        <SnoozedEntryMenu key={`entry:${entry.path}`} session={entry} x={entry.x} y={entry.y}
        triggerEl={entry.triggerEl} onRestore={onRestore}
        onCloseSession={onCloseSession} onClose={closeEntry} onNode={(node) => { entryNode.current = node; }} />}
    </div>
  );
}

/** Only the overlay is local; wake/restore membership always comes from the host. */
export function SnoozedSessionsAction({ sessions, onRestore, onCloseSession, available, fallbackFocusRef }: {
  sessions: SnoozedSession[];
  onRestore: (path: string) => void;
  onCloseSession?: (path: string) => void;
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
      onCloseSession={onCloseSession} onClose={close} available={available} />}
  </>;
}