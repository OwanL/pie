/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';

import type { SessionSummary } from '../../../shared/protocol';
import { isPendingTabPath } from '../../../shared/tab-behavior';
import { getTabAvatarColor, getTabAvatarLabel } from './tab-avatar';

export interface SessionTabProps {
  tabPath: string;
  index: number;
  sessionByPath: Map<string, SessionSummary>;
  openIndexByPath: Map<string, number>;
  runningPathSet: Set<string>;
  startingModelPathSet: Set<string>;
  unreadFinishedPathSet: Set<string>;
  /** Effective active path (host `activeSession.path`, or an optimistic
   *  override while a tab click is awaiting the host round-trip). Replaces the
   *  `activeSession` object so this prop is a stable string (the host
   *  re-serialises `activeSession` every snapshot, which previously defeated
   *  this component's `memo()` and re-rendered every tab each snapshot). */
  activePath: string | null;
  hasPendingExtensionUIRequest: boolean;
  isPinned: boolean;
  /** True when this session owns a pending deferred trigger — disables the
   *  close × with an explanatory tooltip (the trigger must be cancelled first,
   *  from the status strip). */
  hasDeferredTriggers: boolean;
  /** True when a pending deferred trigger includes a timer. */
  hasDeferredTimer: boolean;
  onContextMenu: (event: MouseEvent, tabPath: string) => void;
  onPointerDown: (event: PointerEvent, sourceIndex: number, sourcePath: string) => void;
  onClick: (tabPath: string) => void;
  onClose: (tabPath: string) => void;
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
  startingModelPathSet,
  unreadFinishedPathSet,
  activePath,
  hasPendingExtensionUIRequest,
  isPinned,
  hasDeferredTriggers,
  hasDeferredTimer,
  onContextMenu,
  onPointerDown,
  onClick,
  onClose,
}: SessionTabProps) {
  const session = sessionByPath.get(tabPath);
  const label = session?.name ?? 'New Session';
  const isActive = activePath === tabPath;
  const isAttention = !!hasPendingExtensionUIRequest;
  const isRunning = runningPathSet.has(tabPath);
  const isPreparing = isPendingTabPath(tabPath);
  const isStartingModel = isRunning && startingModelPathSet.has(tabPath);
  const isUnreadFinished = unreadFinishedPathSet.has(tabPath) && !hasDeferredTimer;
  const originalIndex = openIndexByPath.get(tabPath) ?? index;
  const title = hasPendingExtensionUIRequest
    ? `${label} (waiting for your answer)`
    : isPreparing
      ? `${label} (preparing in background — you can type or send now)`
      : hasDeferredTimer
        ? `${label} (waiting for deferred timer)`
        : isUnreadFinished
          ? `${label} (finished, unread)`
          : label;

  // A pending deferred trigger blocks closing the tab until it is cancelled
  // from the status strip, preventing the trigger from being orphaned.
  const deferredBlockTitle = 'Pending deferred trigger(s) — cancel from the status bar first.';

  const classBits = ['session-tab'];
  if (isActive) classBits.push('active');
  if (isAttention) classBits.push('attention');
  if (isUnreadFinished) classBits.push('unread-finished');
  if (hasDeferredTimer) classBits.push('deferred-timer');
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
            {isRunning || isPreparing
              ? <span class={isStartingModel ? 'session-tab-running starting-model' : 'session-tab-running'} aria-hidden="true" />
              : hasDeferredTimer
                ? <span class="session-tab-deferred-timer" aria-hidden="true">⌛</span>
                : isUnreadFinished
                  ? <span class="session-tab-finished" aria-hidden="true" />
                  : null}
            <span class="session-tab-label">{label}</span>
          </>
        )}
      </button>
      {!isPinned && (
        <button
          class="session-tab-close"
          type="button"
          aria-label={`Close ${label}`}
          title={hasDeferredTriggers ? deferredBlockTitle : `Close ${label}`}
          aria-disabled={hasDeferredTriggers ? 'true' : undefined}
          disabled={hasDeferredTriggers}
          onClick={() => onClose(tabPath)}
        >
          ×
        </button>
      )}
    </div>
  );
});
