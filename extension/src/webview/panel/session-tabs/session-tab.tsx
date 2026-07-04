/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';

import type { ActiveRunSummary, SessionSummary } from '../../../shared/protocol';
import { getSessionTabRunBadge } from './run-state';
import { getTabAvatarColor, getTabAvatarLabel } from './tab-avatar';

export interface SessionTabProps {
  tabPath: string;
  index: number;
  sessionByPath: Map<string, SessionSummary>;
  openIndexByPath: Map<string, number>;
  runningPathSet: Set<string>;
  unreadFinishedPathSet: Set<string>;
  /** Effective active path (host `activeSession.path`, or an optimistic
   *  override while a tab click is awaiting the host round-trip). Replaces the
   *  `activeSession` object so this prop is a stable string (the host
   *  re-serialises `activeSession` every snapshot, which previously defeated
   *  this component's `memo()` and re-rendered every tab each snapshot). */
  activePath: string | null;
  hasPendingExtensionUIRequest: boolean;
  activeRunSummary: ActiveRunSummary | null;
  isPinned: boolean;
  onContextMenu: (event: MouseEvent, tabPath: string) => void;
  onPointerDown: (event: PointerEvent, sourceIndex: number, sourcePath: string) => void;
  onClick: (tabPath: string) => void;
  onClose: (tabPath: string) => void;
  onMarkComplete: () => void;
}

// Memoized so non-source tabs skip re-render during a drag (the parent
// re-renders on every pointermove). Effectiveness depends on stable prop
// identities: the derived Maps/Sets are memoized in SessionTabs and the drag
// callbacks are useCallback-stabilized in the hook.
export const SessionTab = memo(function SessionTab({
  tabPath,
  index,
  sessionByPath,
  openIndexByPath,
  runningPathSet,
  unreadFinishedPathSet,
  activePath,
  hasPendingExtensionUIRequest,
  activeRunSummary,
  isPinned,
  onContextMenu,
  onPointerDown,
  onClick,
  onClose,
  onMarkComplete,
}: SessionTabProps) {
  const session = sessionByPath.get(tabPath);
  const label = session?.name ?? 'New Session';
  const isActive = activePath === tabPath;
  const isAttention = !!hasPendingExtensionUIRequest;
  const isRunning = runningPathSet.has(tabPath);
  const isUnreadFinished = unreadFinishedPathSet.has(tabPath);
  const originalIndex = openIndexByPath.get(tabPath) ?? index;
  const title = hasPendingExtensionUIRequest
    ? `${label} (waiting for your answer)`
    : isUnreadFinished
      ? `${label} (finished, unread)`
      : label;

  const classBits = ['session-tab'];
  if (isActive) classBits.push('active');
  if (isAttention) classBits.push('attention');
  if (isUnreadFinished) classBits.push('unread-finished');
  if (isPinned) classBits.push('pinned');
  if (isRunning) classBits.push('running');

  return (
    <div
      key={tabPath}
      class={classBits.join(' ')}
      data-drop-target-tab="true"
      data-tab-path={tabPath}
      onContextMenu={(event) => onContextMenu(event as MouseEvent, tabPath)}
    >
      <span class="session-tab-shell" aria-hidden="true" />
      <button
        class="session-tab-main"
        type="button"
        role="tab"
        aria-selected={isActive}
        tabIndex={isActive ? 0 : -1}
        title={title}
        onPointerDown={(event) => onPointerDown(event as PointerEvent, originalIndex, tabPath)}
        onClick={() => onClick(tabPath)}
      >
        {isPinned ? (
          <span
            class="session-tab-avatar"
            style={{ background: getTabAvatarColor(tabPath) }}
            aria-hidden="true"
          >
            {getTabAvatarLabel(label)}
          </span>
        ) : (
          <>
            {isRunning
              ? <span class="session-tab-running" aria-hidden="true" />
              : isUnreadFinished
                ? <span class="session-tab-finished" aria-hidden="true" />
                : null}
            <span class="session-tab-label">{label}</span>
          </>
        )}
      </button>
      {isActive && !isPinned && (
        (() => {
          const badge = getSessionTabRunBadge(activeRunSummary);
          if (!badge) return null;
          return (
            <button
              class={`session-tab-run-badge ${badge.tone}`}
              type="button"
              title={badge.title}
              aria-label={badge.title}
              onClick={onMarkComplete}
            >
              {badge.text}
            </button>
          );
        })()
      )}
      {!isPinned && (
        <button
          class="session-tab-close"
          type="button"
          aria-label={`Close ${label}`}
          title={`Close ${label}`}
          onClick={() => onClose(tabPath)}
        >
          ×
        </button>
      )}
    </div>
  );
});
