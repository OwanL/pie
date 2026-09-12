import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, fsyncSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

import {
  ACTIVATION_MAX_FILE_BYTES,
  ACTIVATION_MANIFEST_FILENAME,
  ACTIVATION_TOMBSTONE_SCHEMA_VERSION,
  ACTIVATION_TOMBSTONE_FILENAME,
  ActivationManifestError,
  type AnalyticsActivationTombstone,
  type ActivationGenerationIdentity,
  type ActivationManifest,
  activationAuthority,
  validateAnalyticsActivationTombstone,
  validateActivationManifest,
} from '../../../shared/analytics/activation.js';
import { atomicWriteText } from '../shared/atomic-write.js';
import { withFileUpdateLock } from '../shared/settings-json-update.js';

export interface ActivationStoreOptions {
  /** Resolved state directory that owns the manifest. Never searched for. */
  stateDir: string;
}

export interface ActivationReadResult {
  /** null when the manifest is genuinely absent (legacy authority). */
  manifest: ActivationManifest | null;
  /** sha256 of the exact bytes read, for `expectedSha256` fencing on update. */
  sha256: string | null;
  /** True when the write-once tombstone exists. */
  tombstonePresent: boolean;
  authority: 'legacy' | 'canonical';
}

/** Durable, fail-closed owner of the analytics activation manifest.
 *
 * Reads never repair and never fall back: an absent manifest means legacy, but a
 * present manifest that fails validation raises {@link ActivationManifestError}
 * so the host fails startup closed instead of silently writing legacy analytics
 * after an authority switch was attempted.
 *
 * Writes are revision-CAS'd under an exclusive file lock with an atomic
 * replace, and the first activation writes and fsyncs the tombstone *before* the
 * active manifest, so the only reachable intermediate state is
 * tombstone-without-manifest — which still fails closed.
 */
export class ActivationStore {
  readonly manifestPath: string;
  readonly tombstonePath: string;

  constructor(options: ActivationStoreOptions) {
    this.manifestPath = path.join(options.stateDir, ACTIVATION_MANIFEST_FILENAME);
    this.tombstonePath = path.join(options.stateDir, ACTIVATION_TOMBSTONE_FILENAME);
  }

  sha256(bytes: Buffer | string): string {
    return createHash('sha256').update(bytes).digest('hex');
  }

  /** Read and validate. Throws on a malformed, oversized or unreadable manifest. */
  read(): ActivationReadResult {
    const tombstonePresent = existsSync(this.tombstonePath);
    if (!existsSync(this.manifestPath)) {
      if (tombstonePresent) {
        // This is the recoverable crash window between the immutable writer
        // fence and the active manifest replace. It is never legacy authority:
        // tombstone-only state cannot be reconstructed, and only the explicit
        // evidence-bound recovery path may repair a ready predecessor.
        throw new ActivationManifestError(
          'Activation tombstone exists without a manifest; refusing to re-enable legacy authority. '
          + 'The tombstone alone cannot reconstruct authority; the exact ready predecessor is required.',
        );
      }
      return { manifest: null, sha256: null, tombstonePresent, authority: 'legacy' };
    }
    const stats = statSync(this.manifestPath);
    if (stats.size > ACTIVATION_MAX_FILE_BYTES) {
      throw new ActivationManifestError(
        `Activation manifest exceeds ${ACTIVATION_MAX_FILE_BYTES} bytes.`,
      );
    }
    const bytes = readFileSync(this.manifestPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new ActivationManifestError(
        `Activation manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const manifest = validateActivationManifest(parsed);
    if (manifest.everActive && !tombstonePresent) {
      throw new ActivationManifestError(
        'Activation manifest records everActive but the write-once tombstone is missing; refusing to continue.',
      );
    }
    if (tombstonePresent) {
      const tombstone = this.readTombstone();
      if (!manifest.everActive || !manifest.activeGeneration) {
        throw new ActivationManifestError(
          'Activation tombstone exists but the manifest has no active generation; refusing to select an ambiguous authority.',
        );
      }
      // The tombstone is the immutable first-activation fence, not the current
      // generation identity. A later active successor is valid; its predecessor
      // chain is validated by the manifest when the history entry is retained.
      // The bounded history may be trimmed, so authority cannot depend on the
      // first generation remaining in that list.
      this.assertTombstoneConsistency(manifest, tombstone);
    }
    return {
      manifest,
      sha256: this.sha256(bytes),
      tombstonePresent,
      authority: activationAuthority(manifest),
    };
  }

  /** True only for the narrow crash window that the explicit recovery path can
   * inspect. This probe has no authority meaning and performs no writes. */
  hasInterruptedActivation(): boolean {
    // A crash before the atomic replace normally leaves the ready predecessor
    // beside the tombstone; filesystem loss can leave no manifest. Both are
    // detected here, but only the former is recoverable by the evidence-bound
    // recovery method.
    return existsSync(this.tombstonePath);
  }

  /** Repair the crash window after the tombstone was committed but before the
   * active manifest replace completed. The immutable tombstone carries the
   * complete candidate identity and cutoff fence; a caller must supply the same
   * identity and receipt, so a stale or unrelated activation cannot adopt it. */
  async recoverInterruptedActivation(
    identity: ActivationGenerationIdentity,
    cutoffReceiptSha256: string | null,
  ): Promise<ActivationReadResult> {
    if (cutoffReceiptSha256 !== null && !/^[0-9a-f]{64}$/u.test(cutoffReceiptSha256)) {
      throw new ActivationManifestError('Interrupted activation cutoffReceiptSha256 must be a lowercase sha256.');
    }
    mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    return withFileUpdateLock(this.manifestPath, async () => {
      if (!existsSync(this.tombstonePath)) {
        throw new ActivationManifestError('Interrupted activation tombstone is missing; refusing recovery.');
      }
      const tombstone = this.readTombstone();
      if (!sameIdentity(identity, tombstone.identity)) {
        throw new ActivationManifestError('Interrupted activation tombstone identity does not match the requested evidence.');
      }
      if (tombstone.cutoffReceiptSha256 !== cutoffReceiptSha256) {
        throw new ActivationManifestError('Interrupted activation tombstone cutoff fence does not match the requested evidence.');
      }
      if (!existsSync(this.manifestPath)) {
        throw new ActivationManifestError(
          'Interrupted activation recovery requires the exact ready predecessor; refusing rollback from a tombstone alone.',
        );
      }
      const currentBytes = this.readManifestBytes();
      const current = this.parseManifest(currentBytes);
      if (current.everActive) {
        // A completed active replace raced with this recovery call. It must be
        // the requested generation, rather than an unrelated successor.
        if (!current.activeGeneration
          || !sameIdentity(current.activeGeneration.identity, identity)
          || current.activeGeneration.cutoffReceiptSha256 !== cutoffReceiptSha256) {
          throw new ActivationManifestError(
            'Interrupted activation recovery raced with a different active generation; refusing adoption.',
          );
        }
        return this.read();
      }
      if (current.successor?.state !== 'ready'
        || !sameIdentity(current.successor.identity, tombstone.identity)
        || current.revision + 1 !== tombstone.manifestRevision
        || this.sha256(currentBytes) !== tombstone.previousSha256) {
        throw new ActivationManifestError(
          'Interrupted activation manifest is not the exact ready predecessor named by the tombstone.',
        );
      }
      const revision = current.revision + 1;
      const previousSha256 = this.sha256(currentBytes);
      const repaired = validateActivationManifest({
        schemaVersion: 1,
        revision,
        previousSha256,
        everActive: true,
        activeGeneration: {
          identity: tombstone.identity,
          state: 'active',
          activatedAt: tombstone.activatedAt,
          retiredAt: null,
          predecessorGenerationId: null,
          cutoffReceiptSha256: tombstone.cutoffReceiptSha256,
        },
        successor: null,
        retiredHistory: [],
      });
      await atomicWriteText(this.manifestPath, `${JSON.stringify(repaired, null, 2)}\n`);
      return this.read();
    }, { timeoutMs: 15_000 });
  }

  /** Read for an update, refusing to proceed when the on-disk bytes no longer
   * match the caller's expectation (a concurrent writer won the revision).
   *
   * `mutate` receives the committed sha256 of the manifest it is replacing, so a
   * caller can set `previousSha256` from the actual bytes rather than
   * re-serializing them and hoping the encoding matches. `update` then verifies
   * the caller used it, so a caller that guesses cannot commit a broken chain. */
  async update(
    mutate: (current: ActivationManifest | null, currentSha256: string | null) => ActivationManifest,
    options: { expectedSha256?: string | null } = {},
  ): Promise<ActivationReadResult> {
    mkdirSync(path.dirname(this.manifestPath), { recursive: true });
    return withFileUpdateLock(this.manifestPath, async () => {
      // Re-read *under the lock* so the CAS decision uses committed bytes.
      const current = this.read();
      const expected = options.expectedSha256;
      if (expected !== undefined && expected !== current.sha256) {
        throw new ActivationManifestError(
          `Activation manifest changed under the lock (expected ${String(expected)}, found ${String(current.sha256)}).`,
        );
      }
      const next = mutate(current.manifest, current.sha256);
      // The contract requires the revision to advance by exactly one and the
      // previous hash to name the exact bytes being replaced.
      const expectedRevision = (current.manifest?.revision ?? 0) + 1;
      if (next.revision !== expectedRevision) {
        throw new ActivationManifestError(
          `Activation manifest revision must advance to ${expectedRevision}, received ${next.revision}.`,
        );
      }
      if (next.previousSha256 !== current.sha256) {
        throw new ActivationManifestError('Activation manifest previousSha256 must match the replaced bytes.');
      }
      const validated = validateActivationManifest(next);
      // Validate the immutable tombstone/authority relation before touching the
      // destination. A bad transition must leave the last committed bytes intact
      // rather than replacing them and throwing only on the post-write read.
      this.assertManifestWritable(validated, current.manifest);
      // Write the tombstone first, and only when the new state is ever-active:
      // the reachable intermediate (tombstone, no active manifest) fails closed.
      if (validated.everActive && !existsSync(this.tombstonePath)) {
        this.writeTombstone(validated);
      }
      await atomicWriteText(this.manifestPath, `${JSON.stringify(validated, null, 2)}\n`);
      return this.read();
    }, { timeoutMs: 15_000 });
  }

  /** Write and fsync the immutable tombstone. Never rewritten once present. */
  private writeTombstone(manifest: ActivationManifest): void {
    const active = manifest.activeGeneration;
    if (!active) throw new ActivationManifestError('An active manifest must carry active evidence before writing its tombstone.');
    const payload = `${JSON.stringify({
      schemaVersion: ACTIVATION_TOMBSTONE_SCHEMA_VERSION,
      everActive: true,
      firstActiveGenerationId: active.identity.generationId,
      identity: active.identity,
      manifestRevision: manifest.revision,
      previousSha256: manifest.previousSha256,
      activatedAt: active.activatedAt,
      cutoffReceiptSha256: active.cutoffReceiptSha256,
      recordedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    mkdirSync(path.dirname(this.tombstonePath), { recursive: true });
    // Fsync the file (and then its directory on the platforms that need it) so a
    // crash cannot leave a manifest claiming activation without the tombstone.
    const fd = openSync(this.tombstonePath, 'wx');
    try {
      writeFileSync(fd, payload, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** The identity a new candidate must carry, derived from the current bytes. */
  nextIdentity(generationId: string, buildId: string, evidence: {
    qualificationSha256: string;
    trialSha256: string;
  }): { identity: ActivationGenerationIdentity; revision: number; previousSha256: string | null } {
    const current = this.read();
    return {
      identity: { generationId, buildId, ...evidence },
      revision: (current.manifest?.revision ?? 0) + 1,
      previousSha256: current.sha256,
    };
  }

  private readTombstone(): AnalyticsActivationTombstone {
    let stats;
    try {
      stats = statSync(this.tombstonePath);
    } catch (error) {
      throw new ActivationManifestError(
        `Activation tombstone cannot be inspected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stats.size > ACTIVATION_MAX_FILE_BYTES) {
      throw new ActivationManifestError(`Activation tombstone exceeds ${ACTIVATION_MAX_FILE_BYTES} bytes.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.tombstonePath, 'utf8'));
    } catch (error) {
      throw new ActivationManifestError(
        `Activation tombstone is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return validateAnalyticsActivationTombstone(parsed);
  }

  private readManifestBytes(): Buffer {
    let stats;
    try {
      stats = statSync(this.manifestPath);
    } catch (error) {
      throw new ActivationManifestError(
        `Activation manifest cannot be inspected during recovery: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (stats.size > ACTIVATION_MAX_FILE_BYTES) {
      throw new ActivationManifestError(`Activation manifest exceeds ${ACTIVATION_MAX_FILE_BYTES} bytes.`);
    }
    return readFileSync(this.manifestPath);
  }

  private assertManifestWritable(manifest: ActivationManifest, previous: ActivationManifest | null): void {
    if (!existsSync(this.tombstonePath)) {
      if (manifest.everActive && !manifest.activeGeneration) {
        throw new ActivationManifestError('An ever-active manifest must carry an active generation.');
      }
      this.assertActiveTransition(previous, manifest);
      return;
    }
    const tombstone = this.readTombstone();
    if (!manifest.everActive || !manifest.activeGeneration) {
      throw new ActivationManifestError(
        'An existing activation tombstone forbids writing a non-active or never-active manifest.',
      );
    }
    this.assertActiveTransition(previous, manifest);
    this.assertTombstoneConsistency(manifest, tombstone);
  }

  /** Keep the immutable first-activation evidence useful after bounded history
   * trimming without requiring the first generation to remain in every row. */
  private assertTombstoneConsistency(
    manifest: ActivationManifest,
    tombstone: AnalyticsActivationTombstone,
  ): void {
    if (manifest.revision < tombstone.manifestRevision) {
      throw new ActivationManifestError(
        'Activation manifest revision precedes the immutable first-activation tombstone.',
      );
    }
    if (manifest.revision === tombstone.manifestRevision) {
      const active = manifest.activeGeneration;
      if (!active
        || !sameIdentity(active.identity, tombstone.identity)
        || active.activatedAt !== tombstone.activatedAt
        || manifest.previousSha256 !== tombstone.previousSha256) {
        throw new ActivationManifestError(
          'The first active manifest revision does not match the immutable activation tombstone.',
        );
      }
    }
    const retained = [manifest.activeGeneration, ...manifest.retiredHistory]
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .filter((entry) => entry.identity.generationId === tombstone.firstActiveGenerationId);
    for (const entry of retained) {
      if (!sameIdentity(entry.identity, tombstone.identity) || entry.activatedAt !== tombstone.activatedAt) {
        throw new ActivationManifestError(
          'A retained first-active generation disagrees with the immutable activation tombstone.',
        );
      }
    }
  }

  /** A replacement of live authority is valid only when it records the exact
   * current active generation as its predecessor and retains matching retired
   * evidence. Reusing an active id with altered identity/time is never a valid
   * update. */
  private assertActiveTransition(previous: ActivationManifest | null, next: ActivationManifest): void {
    const before = previous?.activeGeneration;
    const after = next.activeGeneration;
    if (!before || !after) return;
    if (before.identity.generationId === after.identity.generationId) {
      if (!sameIdentity(before.identity, after.identity) || before.activatedAt !== after.activatedAt) {
        throw new ActivationManifestError(
          'An active generation identity or activation time cannot change in place.',
        );
      }
      return;
    }
    if (after.predecessorGenerationId !== before.identity.generationId) {
      throw new ActivationManifestError(
        'An active generation replacement must name the current active generation as its predecessor.',
      );
    }
    const retired = next.retiredHistory.find(
      (entry) => entry.identity.generationId === before.identity.generationId,
    );
    if (!retired
      || !sameIdentity(retired.identity, before.identity)
      || retired.activatedAt !== before.activatedAt
      || retired.retiredAt === null) {
      throw new ActivationManifestError(
        'An active generation replacement must retain matching retired evidence for its predecessor.',
      );
    }
  }

  private parseManifest(bytes: Buffer): ActivationManifest {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new ActivationManifestError(
        `Activation manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return validateActivationManifest(parsed);
  }
}

function sameIdentity(a: ActivationGenerationIdentity, b: ActivationGenerationIdentity): boolean {
  return a.generationId === b.generationId
    && a.buildId === b.buildId
    && a.qualificationSha256 === b.qualificationSha256
    && a.trialSha256 === b.trialSha256;
}
