/** P7 disposable candidate-trial authority: filesystem confinement owner.
 *
 * Owns the uniquely created disposable OS-temp root, the confinement math that
 * keeps it disjoint from every caller-resolved live root plus the canonical
 * data owner, and the single-use/bounded-lifetime grant lifecycle. It never
 * touches the live activation store: no manifest and no tombstone is ever read
 * or written here, and it performs no env or settings/auth changes.
 */
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ActivationManifestError } from '../../../shared/analytics/activation.js';
import {
  CANDIDATE_TRIAL_AUTHORITY_KIND,
  CANDIDATE_TRIAL_DEFAULT_MAX_LIFETIME_MS,
  CANDIDATE_TRIAL_SCHEMA_VERSION,
  candidateTrialPlanSha256,
  validateCandidateTrialAuthorityGrant,
  validateCandidateTrialPlan,
  type CandidateTrialAuthorityGrant,
  type CandidateTrialPlan,
} from '../../../shared/analytics/candidate-trial.js';

/** Ported containment math (`path.relative`, both-direction checks). */
export function containsPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** lstat-based presence. ENOENT is the only absence; every other stat error
 * throws so callers fail closed instead of misreading a real failure as
 * "already removed". A dangling symlink is present because its path entry
 * exists even though its target is gone — `existsSync` follows the link and
 * would misreport exactly that case as removed. */
function lstatPresent(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Realpath'd containment fence: the trial root must be disjoint from every
 * protected root, and every resolved trial child must stay inside the root and
 * disjoint from every protected root. */
export function assertTrialRootIsolated(
  rootReal: string,
  protectedRoots: ReadonlyArray<{ real: string; label: string }>,
  children: readonly string[],
): void {
  for (const protectedRoot of protectedRoots) {
    if (containsPath(protectedRoot.real, rootReal) || containsPath(rootReal, protectedRoot.real)) {
      throw new ActivationManifestError(
        `Candidate-trial root overlaps a protected root (${protectedRoot.label}); refusing to authorize.`,
      );
    }
  }
  for (const child of children) {
    const childStats = lstatSync(child);
    if (childStats.isSymbolicLink() || !childStats.isDirectory()) {
      throw new ActivationManifestError('Candidate-trial resolved child must be a real directory.');
    }
    const childReal = path.normalize(realpathSync(child));
    if (!containsPath(rootReal, childReal)) {
      throw new ActivationManifestError('Candidate-trial resolved child escaped its owned root.');
    }
    for (const protectedRoot of protectedRoots) {
      if (containsPath(protectedRoot.real, childReal) || containsPath(childReal, protectedRoot.real)) {
        throw new ActivationManifestError(
          `Candidate-trial resolved child overlaps a protected root (${protectedRoot.label}).`,
        );
      }
    }
  }
}

/** Actual, caller-resolved bindings the grant is validated against. Every path
 * is explicit; nothing is read from or written to the process environment. */
export interface CandidateTrialAuthorityOptions {
  /** Actual loaded build id; must equal the plan's. */
  buildId: string;
  /** Actual source head/fingerprint of the running source; must equal the plan's. */
  sourceHead: string;
  sourceFingerprint: string;
  /** REQUIRED caller-resolved live roots (real dirs) the trial must not overlap. */
  liveRoots: readonly string[];
  /** REQUIRED explicit canonical data-owner root, resolved by the caller. */
  canonicalDataRoot: string;
  maxLifetimeMs?: number;
}

/** Cleanup facts. Failure is preserved and reported, never reported as success. */
export interface CandidateTrialCleanupReceipt {
  readonly trialId: string;
  readonly completed: boolean;
  readonly rootRemoved: boolean;
  readonly stoppedAt: string;
  readonly failureReasons: readonly string[];
}

export type CandidateTrialCleanup = { completed: true; rootRemoved: true } | {
  completed: false;
  rootRemoved: boolean;
  failureReasons: readonly string[];
};

/** The granted disposable authority. Constructed only by
 * {@link authorizeCandidateTrialRoot}; one grant starts at most one trial. */
export class CandidateTrialAuthority {
  private consumed = false;
  private disposed = false;

  private constructor(
    public readonly grant: CandidateTrialAuthorityGrant,
    private readonly rootReal: string,
    private readonly protectedRoots: ReadonlyArray<{ real: string; label: string }>,
  ) {}

  get authorizedAtMs(): number {
    return Date.parse(this.grant.authorizedAt);
  }

  get isExpired(): boolean {
    return Date.now() > this.authorizedAtMs + this.grant.maxLifetimeMs;
  }

  get isConsumed(): boolean {
    return this.consumed;
  }

  /** Single-use consume. Rejects reuse and expiry; never restarts a consumed grant. */
  consume(): void {
    if (this.consumed) {
      throw new ActivationManifestError('Candidate-trial authority grant was already consumed; single use only.');
    }
    if (this.disposed) {
      throw new ActivationManifestError('Candidate-trial authority grant was already disposed.');
    }
    if (this.isExpired) {
      throw new ActivationManifestError('Candidate-trial authority grant has expired.');
    }
    this.consumed = true;
  }

  /** Revalidate the exact factory-owned root and both helper directories at
   * helper start/stop so a substituted junction cannot redirect trial I/O. */
  assertRuntimeRootIntegrity(): void {
    const rootStats = lstatSync(this.grant.resolvedPaths.rootDir);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new ActivationManifestError('Candidate-trial owned root is no longer a real directory.');
    }
    const currentRootReal = path.normalize(realpathSync(this.grant.resolvedPaths.rootDir));
    if (currentRootReal !== this.rootReal) {
      throw new ActivationManifestError('Candidate-trial owned root realpath changed before helper access.');
    }
    const children = [this.grant.resolvedPaths.stateDir, this.grant.resolvedPaths.analyticsDir];
    assertTrialRootIsolated(currentRootReal, this.protectedRoots, children);
    for (const child of children) {
      const childReal = path.normalize(realpathSync(child));
      const childExpected = path.normalize(child);
      if (process.platform === 'win32'
        ? childReal.toLowerCase() !== childExpected.toLowerCase()
        : childReal !== childExpected) {
        throw new ActivationManifestError('Candidate-trial helper directory realpath changed before helper access.');
      }
    }
  }

  /** Stop helpers first (caller-provided so this module owns no runtime), then
   * remove ONLY the factory-owned root, only after re-verifying it is still the
   * exact realpath'd directory this factory created. */
  async dispose(stopHelpers?: () => Promise<void>): Promise<CandidateTrialCleanupReceipt> {
    const failureReasons: string[] = [];
    if (stopHelpers) {
      try {
        await stopHelpers();
      } catch (error) {
        failureReasons.push(`helper-stop: ${String(error)}`);
      }
    }
    try {
      this.assertRuntimeRootIntegrity();
    } catch (error) {
      failureReasons.push(`root-integrity: ${String(error)}`);
    }
    const trialId = this.grant.identity.trialId;
    const stoppedAt = new Date().toISOString();
    let rootRemoved = false;
    try {
      // Presence via lstat, never existsSync: a dangling symlink/junction at
      // the owned path follows to ENOENT under existsSync and would be
      // misreported as removed while its path entry still exists.
      if (lstatPresent(this.grant.resolvedPaths.rootDir)) {
        const stats = lstatSync(this.grant.resolvedPaths.rootDir);
        if (stats.isSymbolicLink()) {
          // Any symlink or junction — including a dangling one whose target is
          // gone — is no longer the owned directory; refuse to delete it.
          throw new Error('owned root became a symlink/junction; refusing to delete');
        }
        const currentReal = path.normalize(realpathSync(this.grant.resolvedPaths.rootDir));
        if (currentReal !== this.rootReal) {
          throw new Error('owned root realpath changed; refusing to delete');
        }
        // A just-stopped recorder worker may hold the database open for a few
        // Windows handle-lag milliseconds; retry briefly, then report failure.
        let removed = false;
        let lastError: unknown;
        for (let attempt = 0; attempt < 5 && !removed; attempt += 1) {
          try {
            rmSync(this.grant.resolvedPaths.rootDir, { recursive: true, force: true });
            removed = !lstatPresent(this.grant.resolvedPaths.rootDir);
          } catch (error) {
            lastError = error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
          }
        }
        rootRemoved = removed;
        if (!rootRemoved) {
          failureReasons.push(`root-removal: ${lastError ? String(lastError) : 'root still present after rmSync'}`);
        }
      } else {
        rootRemoved = true;
      }
    } catch (error) {
      failureReasons.push(`root-removal: ${String(error)}`);
    } finally {
      this.disposed = true;
    }
    if (failureReasons.length > 0) {
      return {
        trialId,
        completed: false,
        rootRemoved,
        stoppedAt,
        failureReasons: Object.freeze(failureReasons),
      };
    }
    return { trialId, completed: true, rootRemoved: true, stoppedAt, failureReasons: [] };
  }

  static create(
    grant: CandidateTrialAuthorityGrant,
    rootReal: string,
    protectedRoots: ReadonlyArray<{ real: string; label: string }>,
  ): CandidateTrialAuthority {
    return new CandidateTrialAuthority(grant, rootReal, protectedRoots);
  }
}

/** Authorize one disposable trial root: validate the plan, bind the actual
 * build/source identity, create the unique owned root, and fence it off from
 * the live roots and the canonical data owner. Throws before creating anything
 * when identity or options are invalid. */
export function authorizeCandidateTrialRoot(
  plan: CandidateTrialPlan,
  options: CandidateTrialAuthorityOptions,
): CandidateTrialAuthority {
  const validatedPlan = validateCandidateTrialPlan(plan);
  if (validatedPlan.identity.buildId !== options.buildId
    || validatedPlan.identity.sourceHead !== options.sourceHead
    || validatedPlan.identity.sourceFingerprint !== options.sourceFingerprint) {
    throw new ActivationManifestError(
      'Candidate-trial plan identity does not match the actual build/source identity; refusing to authorize.',
    );
  }
  const maxLifetimeMs = options.maxLifetimeMs ?? CANDIDATE_TRIAL_DEFAULT_MAX_LIFETIME_MS;
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs <= 0) {
    throw new ActivationManifestError('Candidate-trial maxLifetimeMs is invalid.');
  }
  if (typeof options.canonicalDataRoot !== 'string' || options.canonicalDataRoot.length === 0) {
    throw new ActivationManifestError('Candidate-trial canonicalDataRoot is required.');
  }
  if (!Array.isArray(options.liveRoots)) {
    throw new ActivationManifestError('Candidate-trial liveRoots must be a caller-resolved array.');
  }
  const root = mkdtempSync(path.join(tmpdir(), 'pie-analytics-candidate-trial-'));
  const rootReal = path.normalize(realpathSync(root));
  try {
    const stateDir = path.join(root, 'state');
    const analyticsDir = path.join(root, 'analytics');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(analyticsDir, { recursive: true });
    const resolveProtected = (input: string, label: string) => {
      try {
        return { real: path.normalize(realpathSync(input)), label };
      } catch (error) {
        throw new ActivationManifestError(`Candidate-trial protected root (${label}) is not accessible: ${String(error)}`);
      }
    };
    const protectedRoots = [
      ...options.liveRoots.map((liveRoot) => resolveProtected(liveRoot, 'live-root')),
      resolveProtected(options.canonicalDataRoot, 'canonical-data-owner'),
    ];
    assertTrialRootIsolated(rootReal, protectedRoots, [stateDir, analyticsDir]);
    const grant = validateCandidateTrialAuthorityGrant({
      kind: CANDIDATE_TRIAL_AUTHORITY_KIND,
      schemaVersion: CANDIDATE_TRIAL_SCHEMA_VERSION,
      identity: validatedPlan.identity,
      workspaceId: validatedPlan.workspaceId,
      planSha256: candidateTrialPlanSha256(validatedPlan),
      authorityRevision: 1,
      authorizedAt: new Date().toISOString(),
      maxLifetimeMs,
      resolvedPaths: { rootDir: root, stateDir, analyticsDir },
    });
    return CandidateTrialAuthority.create(grant, rootReal, protectedRoots);
  } catch (error) {
    // A failed authorization must not leak a half-owned root.
    try { rmSync(root, { recursive: true, force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}