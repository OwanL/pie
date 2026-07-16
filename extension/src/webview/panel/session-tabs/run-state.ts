import type { ActiveRunSummary } from '../../../shared/protocol';

export type SessionTabRunAction = 'recordOutcome' | 'startNewTask' | 'continueTask';

export interface SessionTabRunMenuItem {
  action: SessionTabRunAction;
  label: string;
}

export interface ComposerRunStatus {
  text: string;
  tone: 'open' | 'pending-score' | 'subtle';
  title: string;
}

export interface ComposerRunAction {
  text: string;
  tone: 'open';
  title: string;
  ariaLabel: string;
}

export interface ComposerRunControls {
  status: ComposerRunStatus | null;
  action: ComposerRunAction | null;
}

export const COMPOSER_MARK_DONE_ACTION: ComposerRunAction = {
  text: 'Mark done',
  tone: 'open',
  title: 'Mark this session as done and record a local outcome.',
  ariaLabel: 'Mark session done',
};

export function getSessionTabRunMenuItems(runSummary: ActiveRunSummary | null): SessionTabRunMenuItem[] {
  if (!runSummary) {
    return [];
  }

  switch (runSummary.status) {
    case 'open':
      return [
        { action: 'recordOutcome', label: 'Mark tab as complete…' },
        { action: 'startNewTask', label: 'Start new task' },
      ];
    case 'closed_unscored':
      return [
        { action: 'recordOutcome', label: 'Rate completed run…' },
        { action: 'continueTask', label: 'Continue task' },
        { action: 'startNewTask', label: 'Start new task' },
      ];
    case 'scored':
      return [
        { action: 'continueTask', label: 'Continue task' },
        { action: 'startNewTask', label: 'Start new task' },
      ];
    default:
      return [];
  }
}

export function getComposerRunControls(runSummary: ActiveRunSummary | null): ComposerRunControls {
  if (!runSummary) {
    return { status: null, action: null };
  }

  switch (runSummary.status) {
    case 'open':
      return {
        status: runSummary.nextSendStartsNewTask
          ? {
              text: 'New task queued',
              tone: 'subtle',
              title: 'The next send will close the current run and start a new task group.',
            }
          : null,
        action: COMPOSER_MARK_DONE_ACTION,
      };
    case 'closed_unscored':
      return {
        status: runSummary.nextSendStartsNewTask
          ? {
              text: 'New task queued',
              tone: 'subtle',
              title: 'The next send will start a new task group after this completed run.',
            }
          : null,
        action: COMPOSER_MARK_DONE_ACTION,
      };
    case 'scored':
      return {
        status: runSummary.nextSendStartsNewTask
          ? {
              text: 'New task queued',
              tone: 'subtle',
              title: 'The next send will start a new task group instead of continuing the completed one.',
            }
          : {
              text: 'Outcome saved',
              tone: 'subtle',
              title: 'Local outcome saved. Send another message to continue this task, or queue a new one.',
            },
        action: null,
      };
    default:
      return { status: null, action: null };
  }
}
