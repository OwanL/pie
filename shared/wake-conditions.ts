import * as path from 'node:path';

/** The durable condition kinds understood by the wake registry. */
export type TriggerKind = 'session_finished' | 'timer' | 'user_input' | 'command';

export interface SessionFinishedTrigger {
  kind: 'session_finished';
  /** Omit to watch any open session. */
  sessionPath?: string;
}

export interface TimerTrigger {
  kind: 'timer';
  ms: number;
}

export interface UserInputTrigger {
  kind: 'user_input';
}

/** A normalized command predicate. All optional input values are resolved at registration. */
export interface CommandTrigger {
  kind: 'command';
  command: string;
  /** Absolute working directory captured when the condition is registered. */
  cwd: string;
  intervalMs: number;
  timeoutMs: number;
}

/** A normalized durable wake condition. Conditions in one registration are ORed. */
export type TriggerSpec =
  | SessionFinishedTrigger
  | TimerTrigger
  | UserInputTrigger
  | CommandTrigger;

/** The input form accepted by `defer_trigger` before normalization. */
export type TriggerSpecInput =
  | SessionFinishedTrigger
  | TimerTrigger
  | UserInputTrigger
  | (Omit<CommandTrigger, 'cwd' | 'intervalMs' | 'timeoutMs'> & {
      cwd?: string;
      intervalMs?: number;
      timeoutMs?: number;
    });

export const DEFAULT_COMMAND_INTERVAL_MS = 30_000;
export const MIN_COMMAND_INTERVAL_MS = 1_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
export const MAX_COMMAND_TIMEOUT_MS = 5 * 60_000;

export interface WakeConditionValidation {
  specs?: TriggerSpec[];
  error?: string;
}

export interface WakeConditionValidationOptions {
  /** Registration cwd used to resolve command predicate cwd values. */
  registrationCwd?: string;
}

/**
 * Validate and normalize a raw trigger array.
 *
 * Command cwd values are resolved relative to the registration cwd and command
 * polling defaults are filled in here so every durable sidecar record carries
 * an executable, self-contained predicate.
 */
export function validateWakeConditions(
  raw: unknown,
  options: WakeConditionValidationOptions = {},
): WakeConditionValidation {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'triggers must be a non-empty array of trigger specs.' };
  }

  const registrationCwd = path.resolve(options.registrationCwd ?? process.cwd());
  const specs: TriggerSpec[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { error: 'each trigger spec must be an object.' };
    }

    const input = item as Record<string, unknown>;
    switch (input.kind) {
      case 'session_finished': {
        if (input.sessionPath !== undefined
          && (typeof input.sessionPath !== 'string' || input.sessionPath.trim() === '')) {
          return { error: 'session_finished.sessionPath must be a non-empty string or omitted.' };
        }
        specs.push({
          kind: 'session_finished',
          ...(input.sessionPath === undefined ? {} : { sessionPath: input.sessionPath as string }),
        });
        break;
      }
      case 'timer': {
        if (!isPositiveInteger(input.ms)) {
          return { error: 'timer.ms must be a positive integer (milliseconds).' };
        }
        specs.push({ kind: 'timer', ms: input.ms });
        break;
      }
      case 'user_input':
        specs.push({ kind: 'user_input' });
        break;
      case 'command': {
        if (typeof input.command !== 'string' || input.command.trim() === '') {
          return { error: 'command.command must be a non-empty string.' };
        }

        let cwd: string;
        if (input.cwd === undefined) {
          cwd = registrationCwd;
        } else if (typeof input.cwd !== 'string' || input.cwd.trim() === '') {
          return { error: 'command.cwd must be a non-empty string or omitted.' };
        } else {
          try {
            cwd = path.resolve(registrationCwd, input.cwd);
          } catch {
            return { error: 'command.cwd must be a valid path.' };
          }
        }

        const intervalMs = input.intervalMs === undefined
          ? DEFAULT_COMMAND_INTERVAL_MS
          : input.intervalMs;
        if (!isPositiveInteger(intervalMs) || intervalMs < MIN_COMMAND_INTERVAL_MS) {
          return { error: `command.intervalMs must be an integer of at least ${MIN_COMMAND_INTERVAL_MS} milliseconds.` };
        }

        const timeoutMs = input.timeoutMs === undefined
          ? DEFAULT_COMMAND_TIMEOUT_MS
          : input.timeoutMs;
        if (!isPositiveInteger(timeoutMs) || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
          return { error: `command.timeoutMs must be a positive integer no greater than ${MAX_COMMAND_TIMEOUT_MS} milliseconds.` };
        }

        specs.push({
          kind: 'command',
          command: input.command,
          cwd,
          intervalMs,
          timeoutMs,
        });
        break;
      }
      default:
        return {
          error: `trigger kind must be one of session_finished | timer | user_input | command (got ${String(input.kind)}).`,
        };
    }
  }

  return { specs };
}

/** Compatibility-oriented name for callers that describe the values as specs. */
export function validateTriggerSpecs(
  raw: unknown,
  options: WakeConditionValidationOptions = {},
): WakeConditionValidation {
  return validateWakeConditions(raw, options);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

export interface CommandPredicateExecutionResult {
  /** Process exit status. Missing/null means the command did not exit normally. */
  exitCode?: number | null;
  /** Captured only for bounded diagnostics; predicate satisfaction uses exitCode. */
  stdout?: string;
  /** Captured for bounded diagnostics, including abnormal exits. */
  stderr?: string;
  /** Set when the bounded command execution reached its timeout. */
  timedOut?: boolean;
  /** Spawn or execution failure, if one occurred. */
  error?: unknown;
}

export interface CommandPredicateResult {
  satisfied: boolean;
  /** Present only when the command could not produce a valid predicate result. */
  error?: string;
}

/**
 * Interpret a completed command predicate by exit status rather than command
 * output. Exit 0 means satisfied and exit 1 means not yet satisfied; signals,
 * timeouts, spawn failures, and every other exit status are errors.
 */
export function parseCommandPredicateResult(
  result: CommandPredicateExecutionResult,
): CommandPredicateResult {
  const diagnostic = commandDiagnostic(result);
  if (result.timedOut) {
    return { satisfied: false, error: `command predicate timed out${diagnostic}` };
  }

  if (result.exitCode === 0) {
    if (result.error !== undefined) {
      return { satisfied: false, error: `command predicate failed${diagnostic}` };
    }
    return { satisfied: true };
  }

  if (result.exitCode === 1) {
    if (result.error !== undefined) {
      return { satisfied: false, error: `command predicate failed${diagnostic}` };
    }
    return { satisfied: false };
  }

  const status = result.exitCode === undefined || result.exitCode === null
    ? 'did not exit normally'
    : `exited with code ${result.exitCode}`;
  return { satisfied: false, error: `command predicate ${status}${diagnostic}` };
}

function commandDiagnostic(result: CommandPredicateExecutionResult): string {
  const details: string[] = [];
  if (typeof result.error === 'string' && result.error.trim()) details.push(result.error.trim());
  else if (result.error instanceof Error && result.error.message.trim()) details.push(result.error.message.trim());
  if (typeof result.stderr === 'string' && result.stderr.trim()) details.push(`stderr: ${result.stderr.trim()}`);
  return details.length > 0 ? ` (${details.join('; ')})` : '';
}
