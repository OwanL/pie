/**
 * Deprecated thin re-export of the backend structured logger. The canonical
 * implementation lives in `./log` (`backendLog` + level helpers + the
 * `backendTrace` compat wrapper). This shim exists so the pre-structured
 * import sites (`session-metadata`, `subagent-profiles`,
 * `system-prompt-toggle-store`) keep compiling without a churn edit; new code
 * should import directly from `./log`.
 *
 * @see ./log.ts for the structured stderr contract.
 */
export { backendTrace, backendLog, backendDebug, backendInfo, backendWarn, backendError } from './log.js';
export type { BackendLogLevel, BackendLogRecord } from './log.js';