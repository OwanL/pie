import type { ActiveRunSummary } from '../../../shared/protocol';

export type SessionTabRunAction = 'startNewTask' | 'continueTask';

export interface SessionTabRunMenuItem {
  action: SessionTabRunAction;
  label: string;
}

export interface ComposerRunStatus {
  text: string;
  tone: 'open' | 'pending-score' | 'subtle';
  title: string;
}

export interface ComposerRunControls {
  status: ComposerRunStatus | null;
}

export function getSessionTabRunMenuItems(runSummary: ActiveRunSummary | null): SessionTabRunMenuItem[] {
  if (!runSummary) {
    return [];
  }

  switch (runSummary.status) {
    case 'open':
      return [
        { action: 'startNewTask', label: 'Start new task' },
      ];
    case 'closed_unscored':
      return [
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
    return { status: null };
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
      };
    case 'scored':
      return {
        status: runSummary.nextSendStartsNewTask
          ? {
              text: 'New task queued',
              tone: 'subtle',
              title: 'The next send will start a new task group instead of continuing the completed one.',
            }
          : null,
      };
    default:
      return { status: null };
  }
}
