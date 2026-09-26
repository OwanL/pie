import {
  recordPendingControlledRestartFromRequest,
  readPendingControlledRestart,
  validateControlledRestartHostIdentity,
  type AnalyticsHostRestartHandler,
  type ControlledRestartHostIdentity,
} from '../../../analytics/authority/controlled-restart.js';

/** The quiet restart fires after the signed acknowledgement has flushed. */
export const CONTROLLED_RESTART_DELAY_MS = 500;

export interface AnalyticsHostControlledRestartOptions {
  stateDir: string;
  identity: ControlledRestartHostIdentity;
  /** Executes the supported quiet restart for this host's window. Called once,
   * after the signed acknowledgement has been produced and flushed. */
  performRestart: () => void;
  /** Injectable delay scheduler for tests. Returns a cancel function for the
   * pending restart. Defaults to a re-armed unref'd setTimeout. */
  schedule?: (perform: () => void, delayMs: number) => () => void;
}

/** Host-local restart driving stays in application composition; validation and
 * durable nonce/claim semantics remain owned by analytics authority. */
export function createAnalyticsHostControlledRestart(
  options: AnalyticsHostControlledRestartOptions,
): AnalyticsHostRestartHandler {
  const identity = validateControlledRestartHostIdentity(options.identity);
  let cancelScheduled: (() => void) | undefined;
  const defaultSchedule = (perform: () => void, delayMs: number): (() => void) => {
    const timer = setTimeout(perform, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  };
  return {
    async restart(request) {
      if (request.workspaceId !== identity.workspaceId) {
        throw new Error('controlled restart workspace identity does not match.');
      }
      if (request.targetHostInstanceId !== identity.hostInstanceId) {
        throw new Error('controlled restart target identity does not match.');
      }
      // A newer signed request for this predecessor supersedes its pending
      // record; requests for other hosts have independent durable slots.
      recordPendingControlledRestartFromRequest(options.stateDir, request);
      cancelScheduled?.();
      cancelScheduled = undefined;
      cancelScheduled = (options.schedule ?? defaultSchedule)(options.performRestart, CONTROLLED_RESTART_DELAY_MS);
      const recorded = readPendingControlledRestart(options.stateDir, identity.hostInstanceId);
      if (!recorded || recorded.restartNonce !== request.restartNonce
        || recorded.terminalRestartReceiptPath !== request.terminalRestartReceiptPath
        || recorded.successorHandoffKey !== request.successorHandoffKey) {
        throw new Error('controlled restart pending record was not durable.');
      }
      return { pendingRestartRecorded: true, restartScheduled: true };
    },
  };
}
