/**
 * Versioned-migration registry for the run-analytics checkpoint.
 *
 * Each {@link CheckpointMigration} entry transforms a raw parsed checkpoint
 * value (the result of `JSON.parse` on the checkpoint file) from schema
 * version `from` → `to`. `parseCheckpoint` (in `checkpoint-io.ts`) reads the
 * file's `schemaVersion`, then walks this registry from that version up to
 * {@link RUN_ANALYTICS_SCHEMA_VERSION}, applying each `up` step in order and
 * threading the result, before validating the (now-current) `sessions` shape.
 *
 * Rules — critical for forward correctness:
 *  - The registry MUST be append-only. Never edit or reorder an existing entry;
 *    only push a new one onto the end.
 *  - Entries MUST be sequential and contiguous: 1→2, 2→3, 3→4, … with no gaps.
 *    `migrateCheckpoint` verifies the chain is complete from `fileVersion` to
 *    `targetVersion`; a missing step aborts migration (the checkpoint is
 *    dropped loudly by `parseCheckpoint`, never silently mis-migrated).
 *  - Each `up` MUST return a new raw value whose `schemaVersion` equals its
 *    `to`. It is the migration's job to bump `schemaVersion`; the walker does
 *    not patch it.
 *  - `up` must be total over any well-formed `from`-shaped value and must not
 *    throw for valid inputs. If it throws, `parseCheckpoint` treats that as a
 *    failed migration and drops + warns.
 *
 * v1 is the first schema version, so the registry is empty. The next schema
 * bump adds an entry here, e.g.:
 *   { from: 1, to: 2, up: (raw) => ({ ...(raw as object), schemaVersion: 2, sessions: migrateSessionsV1ToV2((raw as any).sessions) }) }
 */
export interface CheckpointMigration {
  from: number;
  to: number;
  up: (raw: unknown) => unknown;
}

// Empty for v1. No migrations exist yet — v1 is the first schema version and
// there is no v0 data in the wild.
export const CHECKPOINT_MIGRATIONS: readonly CheckpointMigration[] = [];

/**
 * Sentinel returned by {@link migrateCheckpoint} when the migration chain from
 * `fileVersion` to `targetVersion` is incomplete (a required step is missing)
 * or the caller asked for a no-op / backwards migration. Callers treat this as
 * "drop loudly" — it is intentionally a distinct value so a throwing `up` can
 * be told apart from a gap in the registry.
 */
export const MIGRATION_FAILED = Symbol('checkpoint-migration-failed');

/**
 * Walk the {@link CHECKPOINT_MIGRATIONS}-shaped registry from `fileVersion` up
 * to `targetVersion`, applying each `up` step in order and threading the
 * result. Returns the migrated raw value (with `schemaVersion` ==
 * `targetVersion` when migrations follow the rules), or {@link MIGRATION_FAILED}
 * if:
 *  - `fileVersion === targetVersion` (no migration needed — callers should not
 *    call in this case; treated as a no-op failure so the caller's "same
 *    version" fast-path stays explicit), or
 *  - `fileVersion > targetVersion` (downgrades are not supported), or
 *  - a required step `n → n+1` is missing from `migrations`, or
 *  - an `up` step throws.
 *
 * This function is exported so it can be unit-tested with a synthetic
 * registry without bumping the real {@link RUN_ANALYTICS_SCHEMA_VERSION}.
 *
 * @param raw          the parsed checkpoint value at `fileVersion`
 * @param fileVersion  the schema version recorded in the file
 * @param targetVersion the schema version the caller wants (currently always
 *                      {@link RUN_ANALYTICS_SCHEMA_VERSION})
 * @param migrations   the migration registry (defaults to
 *                      {@link CHECKPOINT_MIGRATIONS})
 */
export function migrateCheckpoint(
  raw: unknown,
  fileVersion: number,
  targetVersion: number,
  migrations: readonly CheckpointMigration[] = CHECKPOINT_MIGRATIONS,
): unknown {
  if (fileVersion >= targetVersion) {
    // Same-version is the caller's fast path (no migration); a newer-than-code
    // file is a downgrade we cannot perform. Either way, refuse here.
    return MIGRATION_FAILED;
  }

  // Index steps by `from` for O(1) lookup and contiguity checking.
  const byFrom = new Map<number, CheckpointMigration>();
  for (const step of migrations) {
    if (byFrom.has(step.from)) {
      // Duplicate `from` — registry invariant violated; refuse to guess.
      return MIGRATION_FAILED;
    }
    byFrom.set(step.from, step);
  }

  let current = raw;
  let version = fileVersion;
  while (version < targetVersion) {
    const step = byFrom.get(version);
    if (!step || step.to !== version + 1) {
      // Missing or non-sequential step — chain is not contiguous.
      return MIGRATION_FAILED;
    }
    try {
      current = step.up(current);
    } catch {
      return MIGRATION_FAILED;
    }
    version = step.to;
  }

  return current;
}