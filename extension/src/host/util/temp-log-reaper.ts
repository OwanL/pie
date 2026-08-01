import { reapTempFiles, type ReapOptions, type ReapResult } from '../../../../shared/temp-file-reaper.js';

/**
 * The pi SDK (@earendil-works/pi-coding-agent) writes a temp log to the OS
 * tmpdir every time a tool result is truncated — `pi-bash-*.log` for the bash
 * tool, `pi-output-*.log` for find/grep/ls. The SDK never deletes these; they
 * accumulate indefinitely (observed: 139 files / 75 MB over ~11 days, with one
 * 30 MB orphan from a single truncated grep). This is a best-effort, never-
 * throwing reaper run fire-and-forget on extension activation.
 *
 * The age + total-size eviction algorithm is shared via
 * `shared/temp-file-reaper.ts`; this wrapper selects the SDK's file pattern.
 */

const TEMP_LOG_PREFIXES = ['pi-bash-', 'pi-output-'] as const;

export type TempLogReapOptions = ReapOptions;
export type TempLogReapResult = ReapResult;

/** Delete orphaned pi tool-output temp logs by age and total size.
 *  Never throws — best-effort. */
export async function reapTempLogs(
  options: TempLogReapOptions = {},
): Promise<TempLogReapResult> {
  return reapTempFiles(
    (name) =>
      TEMP_LOG_PREFIXES.some((p) => name.startsWith(p)) && name.endsWith('.log'),
    options,
  );
}
