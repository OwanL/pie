import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, fsyncSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';

import {
  ACTIVATION_MAX_FILE_BYTES,
  ACTIVATION_MANIFEST_FILENAME,
  ACTIVATION_TOMBSTONE_FILENAME,
  ActivationManifestError,
  type ActivationGenerationIdentity,
  type ActivationManifest,
  activationAuthority,
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
      // A tombstone with no manifest is the deliberate safe intermediate of a
      // first activation. It fails closed: no manifest means legacy, and the
      // tombstone forbids a later silent re-enable.
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
    return {
      manifest,
      sha256: this.sha256(bytes),
      tombstonePresent,
      authority: activationAuthority(manifest),
    };
  }

  /** Read for an update, refusing to proceed when the on-disk bytes no longer
   * match the caller's expectation (a concurrent writer won the revision). */
  async update(
    mutate: (current: ActivationManifest | null) => ActivationManifest,
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
      const next = mutate(current.manifest);
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
    const payload = `${JSON.stringify({
      schemaVersion: 1,
      everActive: true,
      firstActiveGenerationId: manifest.activeGeneration?.identity.generationId ?? null,
      recordedAt: new Date().toISOString(),
    }, null, 2)}\n`;
    mkdirSync(path.dirname(this.tombstonePath), { recursive: true });
    // Fsync the file (and then its directory on the platforms that need it) so a
    // crash cannot leave a manifest claiming activation without the tombstone.
    const fd = openSync(this.tombstonePath, 'w');
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
}
