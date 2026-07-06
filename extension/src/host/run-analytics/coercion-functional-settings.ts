import type { PruningMode } from '../../shared/protocol';
import type { FunctionalSettingsSnapshot } from './types';
import { isObjectRecord } from './coercion-utils';

const PRUNING_MODES: readonly PruningMode[] = ['auto', 'shadow', 'off', 'custom'];

/**
 * Coerce a `Record<string, boolean>`, dropping non-boolean values and
 * non-string keys. Returns an empty record for any non-object input so callers
 * always receive a finite map (never `undefined`).
 */
function coerceBooleanRecord(value: unknown): Record<string, boolean> {
  if (!isObjectRecord(value)) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof key === 'string' && typeof entry === 'boolean') {
      result[key] = entry;
    }
  }
  return result;
}

/**
 * Coerce an unknown value into a {@link FunctionalSettingsSnapshot}, returning
 * `null` when the input is not a recognizable record. A valid `pruningMode` is
 * the only gating field: capture always writes all three fields together, so a
 * record lacking a valid mode is treated as untracked (same as records that
 * predate the field). This keeps the field's `| null` contract honest for the
 * chart's "(untracked)" bucket.
 */
export function coerceFunctionalSettings(value: unknown): FunctionalSettingsSnapshot | null {
  if (!isObjectRecord(value)) {
    return null;
  }

  const pruningModeCandidate = value.pruningMode;
  const pruningMode =
    typeof pruningModeCandidate === 'string'
    && (PRUNING_MODES as readonly string[]).includes(pruningModeCandidate)
      ? (pruningModeCandidate as PruningMode)
      : null;
  if (pruningMode === null) {
    return null;
  }

  return {
    subagentAlwaysParentModel: value.subagentAlwaysParentModel === true,
    pruningMode,
    extensionToggles: coerceBooleanRecord(value.extensionToggles),
    toolResultPruningEnabled: value.toolResultPruningEnabled === true || value.toolResultPruningEnabled === false ? value.toolResultPruningEnabled : null,
    toolResultPruningProfile: value.toolResultPruningProfile === 'default' || value.toolResultPruningProfile === 'security' ? value.toolResultPruningProfile : null,
  };
}
