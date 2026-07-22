import {
  HISTORY_COMPACTION_ENV,
  resolveHistoryCompactionSettings,
  type ChatPrefs,
} from '../../shared/protocol';

/**
 * Seed settings required while the SDK is being loaded into the child process
 * environment. The normal runtimePrefs.set RPC remains authoritative for live
 * updates and the rest of the runtime policy, but it arrives after SDK startup
 * and can be delayed by cold session restoration. History compaction reads its
 * policy synchronously from the environment, so inheriting the persisted value
 * prevents a startup window where pi's native defaults can compact first.
 */
export function seedHistoryCompactionEnvironment(
  prefs: Pick<ChatPrefs, 'historyCompaction'>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  env[HISTORY_COMPACTION_ENV] = JSON.stringify(
    resolveHistoryCompactionSettings(prefs.historyCompaction),
  );
}
