/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';

import type { SessionSummary } from '../../lib/protocol/index.js';
import { isPendingTabPath } from '../../lib/session-tabs/tab-behavior.js';
import { handleContextMenuKeyRequest } from '../lib/components/context-menu-key';
import { AgentIcon } from './icons';
import { getTabAvatarColor, getTabAvatarLabel } from './tab-avatar';
import type { SessionTabContextTarget } from './types';

export function getSessionTabTooltip(agentCreated?: boolean, existingTooltip?: string): string | undefined {
  if (agentCreated !== true) return existingTooltip;
  return existingTooltip ? `${existingTooltip} · Agent-created session` : 'Agent-created session';
}

export interface SessionTabProps {
  tabPath: string;
  index: number;
  sessionByPath: Map<string, SessionSummary>;
  openIndexByPath: Map<string, number>;
  runningPathSet: Set<string>;
  generatingTitlePathSet?: Set<string>;
  startingModelPathSet: Set<string>;
  unreadFinishedPathSet: Set<string>;
  /** Host selection or the optimistic click override. Projected to a per-tab
   *  boolean before reaching the presentation memo barrier. */
  activePath: string | null;
  hasPendingExtensionUIRequest: boolean;
  isPinned: boolean;
  /** True when this pinned chip is the current group/merge drop target. */
  isDropTarget: boolean;
  /** True when this session is the delivery target of a pending deferred
   *  trigger — disables the close × with an explanatory tooltip (the trigger
   *  must be cancelled first, from the status strip). */
  hasDeferredTriggers: boolean;
  /** True when a pending deferred trigger includes a timer. */
  hasDeferredTimer: boolean;
  onContextMenu: (event: MouseEvent, tabPath: string, target?: SessionTabContextTarget, triggerEl?: HTMLElement | null) => void;
  onPointerDown: (event: PointerEvent, sourceIndex: number, sourcePath: string) => void;
  onClick: (tabPath: string) => void;
  onClose: (tabPath: string) => void;
  onRetryCreate?: (operationId: string) => void;
}

export function projectSessionTabProps(props: SessionTabProps): PresentationProps {
  const { tabPath, index, sessionByPath, openIndexByPath, runningPathSet,
    generatingTitlePathSet, startingModelPathSet, unreadFinishedPathSet, activePath,
    ...rest } = props;
  const session = sessionByPath.get(tabPath);
  return { ...rest, tabPath,
    label: session?.name ?? 'New Session', agentCreated: session?.agentCreated === true,
    creationState: session?.creationState, createOperationId: session?.createOperationId,
    originalIndex: openIndexByPath.get(tabPath) ?? index,
    isActive: activePath === tabPath, isRunning: runningPathSet.has(tabPath),
    isGeneratingTitle: generatingTitlePathSet?.has(tabPath) ?? false,
    isStartingModel: runningPathSet.has(tabPath) && startingModelPathSet.has(tabPath),
    isUnreadFinished: unreadFinishedPathSet.has(tabPath) && !props.hasDeferredTimer,
  };
}

type PresentationProps = Omit<SessionTabProps, 'index' | 'sessionByPath' | 'openIndexByPath'
  | 'runningPathSet' | 'generatingTitlePathSet' | 'startingModelPathSet' | 'unreadFinishedPathSet' | 'activePath'> & {
  label: string;
  agentCreated: boolean;
  creationState?: SessionSummary['creationState'];
  createOperationId?: string;
  originalIndex: number;
  isActive: boolean;
  isRunning: boolean;
  isGeneratingTitle: boolean;
  isStartingModel: boolean;
  isUnreadFinished: boolean;
};

export const SessionTabPresentation = memo(function SessionTabPresentation({
  tabPath, label, agentCreated, creationState, createOperationId, originalIndex,
  isActive, isRunning, isGeneratingTitle, isStartingModel, isUnreadFinished,
  hasPendingExtensionUIRequest, isPinned, isDropTarget, hasDeferredTriggers,
  hasDeferredTimer, onContextMenu, onPointerDown, onClick, onClose, onRetryCreate,
}: PresentationProps) {
  const isAttention = hasPendingExtensionUIRequest;
  const isPreparing = isPendingTabPath(tabPath);
  const isCreationDelayed = creationState === 'delayed';
  const isAgentCreated = agentCreated;
  const statusTitle = hasPendingExtensionUIRequest
    ? `${label} (waiting for your answer)`
    : isCreationDelayed
      ? `${label} (creation delayed — retry or wait for completion)`
      : isPreparing
        ? `${label} (preparing in background — you can type or send now)`
        : hasDeferredTimer
          ? `${label} (waiting for deferred timer)`
          : isUnreadFinished
            ? `${label} (finished, unread)`
            : label;
  const title = getSessionTabTooltip(agentCreated, statusTitle) ?? statusTitle;

  // A pending deferred trigger blocks closing its delivery target until it is
  // cancelled from the status strip, preventing the trigger from being orphaned.
  const deferredBlockTitle = 'Pending deferred trigger(s) — cancel from the status bar first.';

  const classBits = ['session-tab'];
  if (isActive) classBits.push('active');
  if (isAttention) classBits.push('attention');
  if (isUnreadFinished) classBits.push('unread-finished');
  if (hasDeferredTimer) classBits.push('deferred-timer');
  if (isPinned) classBits.push('pinned');
  if (isDropTarget) classBits.push('drop-target-on');
  if (isRunning) classBits.push('running');
  if (isCreationDelayed) classBits.push('creation-delayed');

  return (
    <div
      key={tabPath}
      class={classBits.join(' ')}
      data-drop-target-tab="true"
      data-tab-path={tabPath}
      data-pinned-item={isPinned ? 'true' : undefined}
      data-pinned-item-path={isPinned ? tabPath : undefined}
      data-pinned-item-group={isPinned ? 'false' : undefined}
      data-unpinned-tab={isPinned ? undefined : 'true'}
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
        onKeyDown={(event) => handleContextMenuKeyRequest(event as KeyboardEvent)}
      >
        {isPinned ? (
          <>
            <span
              class={isGeneratingTitle ? 'session-tab-avatar session-title-loading session-title-loading-avatar' : 'session-tab-avatar'}
              data-label={isGeneratingTitle ? getTabAvatarLabel(label) : undefined}
              style={{ background: getTabAvatarColor(tabPath) }}
              aria-hidden="true"
            >
              {getTabAvatarLabel(label)}
            </span>
            {isAgentCreated && <AgentIcon compact />}
          </>
        ) : (
          <>
            {isRunning || isPreparing
              ? <span class={isStartingModel ? 'session-tab-running starting-model' : 'session-tab-running'} aria-hidden="true" />
              : hasDeferredTimer
                ? <span class="session-tab-deferred-timer" aria-hidden="true">⌛</span>
                : isUnreadFinished
                  ? <span class="session-tab-finished" aria-hidden="true" />
                  : null}
            <span
              class={isGeneratingTitle ? 'session-tab-label session-title-loading' : 'session-tab-label'}
              data-label={isGeneratingTitle ? label : undefined}
            >
              {label}
            </span>
            {isAgentCreated && <AgentIcon />}
          </>
        )}
      </button>
      {isCreationDelayed && createOperationId && onRetryCreate && (
        <button
          class="session-tab-retry"
          type="button"
          aria-label={`Retry creating ${label}`}
          title="Retry session creation"
          onClick={(event) => {
            event.stopPropagation();
            onRetryCreate?.(createOperationId);
          }}
        >
          ↻
        </button>
      )}
      {!isPinned && (
        <button
          class="session-tab-close"
          type="button"
          aria-label={`Close ${label}`}
          title={hasDeferredTriggers ? deferredBlockTitle : `Close ${label}`}
          // A pending deferred trigger blocks closing, but the × must stay in
          // the tab order: hard-disabled buttons are unreachable for keyboard
          // users and their reason tooltip (below) is undiscoverable. Guarded
          // activation keeps the blocked release from closing the tab, and
          // focus stays on the button (a click must not fall through).
          aria-disabled={hasDeferredTriggers ? 'true' : undefined}
          aria-description={hasDeferredTriggers ? deferredBlockTitle : undefined}
          onClick={() => {
            if (hasDeferredTriggers) return;
            onClose(tabPath);
          }}
        >
          ×
        </button>
      )}
    </div>
  );
});
