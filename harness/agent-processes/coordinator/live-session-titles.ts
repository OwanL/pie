import * as crypto from 'node:crypto';

/**
 * Coordinator-owned live session title authority (session-control refinement
 * plan §1–2 building blocks). This module owns allocation across local live
 * sessions and in-progress name reservations only — never retained closed
 * history or the bounded tool-list page. It deliberately performs no durable
 * JSONL writes of its own: existing titles are reserved from restored session
 * metadata, collisions are persisted through the caller's fenced callback
 * before publication, and runtime-owned assignments flow through
 * `reserve()`/`confirm()`.
 *
 * Responsibilities:
 * - `reconcile` reserves literal existing titles first, then resolves restored
 *   collisions deterministically: the oldest durable header creation timestamp
 *   (`headerTimestamp`, not mutable `modifiedAt`) keeps the original, stable
 *   session identity breaks ties, and missing/invalid timestamps sort after
 *   valid ones. Collision suffixes are persisted (via `persist`) before the
 *   name is published. A failed persistence frees its reservation and leaves
 *   readiness failed closed.
 * - `reserve` allocates synchronously (no await between the occupied check and
 *   the synchronous reservation mutation), so concurrent allocations cannot
 *   collide and no allocation critical section is held through a worker
 *   callback. Automatic collision suffixes live outside the
 *   {@link LIVE_SESSION_TITLE_BASE_MAX_CHARS} base-title allowance.
 * - `confirm` publishes a reserved title only after the owner durably
 *   persisted it; `release` frees the reservation. Closing retains the
 *   reservation until the confirmed release.
 * - `resolve` matches a title exactly after trimming outer whitespace (no
 *   fuzzy matching, and provisional labels never resolve); the namespace stays
 *   unavailable (throws) until reconciliation completes.
 */

/** New base titles use the same 25-character input limit; automatic collision
 * suffixes are additional and must not consume the input allowance. */
export const LIVE_SESSION_TITLE_BASE_MAX_CHARS = 25;

/** Bound on the deterministic `(n)` suffix search so a corrupted name set
 * cannot spin forever; unreachable in practice. */
const LIVE_SESSION_TITLE_SUFFIX_SEARCH_LIMIT = 10_000;

/** One restored live member of the title authority during reconciliation.
 * `headerTimestamp` is the durable creation timestamp from the SDK session
 * header and `title` is the existing durable assigned title, if any. Entries
 * without a title are provisional sessions and never enter the namespace. */
export interface LiveSessionTitleEntry {
  sessionPath: string;
  sessionId: string;
  headerTimestamp?: string;
  title?: string;
}

/** Exact resolution of an assigned title against the live namespace. */
export interface LiveSessionTitleResolution {
  sessionPath: string;
  sessionId: string;
}

/** Synchronous reservation returned by {@link LiveSessionTitles.reserve}. The
 * returned title (base or base + automatic suffix) stays occupied until
 * `confirm` publishes it or `release` frees it. */
export interface LiveSessionTitleReservation {
  readonly reservationId: string;
  readonly baseTitle: string;
  readonly title: string;
  readonly sessionPath: string;
  readonly sessionId: string;
}

/** Snapshot record for list projections. `reserved` titles are allocated but
 * not yet durably published by their owning worker. */
export interface LiveSessionTitleRecord {
  readonly sessionPath: string;
  readonly sessionId: string;
  readonly title: string;
  readonly state: 'reserved' | 'assigned';
}

export interface LiveSessionTitlesReconcileResult {
  /** Number of restored live entries considered, including provisional ones. */
  readonly restoredEntries: number;
  /** Entries published under their existing durable title without a suffix. */
  readonly preserved: ReadonlyArray<{
    sessionPath: string;
    sessionId: string;
    title: string;
  }>;
  /** Collision-resolved entries whose suffix assignment was persisted through
   * `persist` (old title → new title) before publication. */
  readonly suffixed: ReadonlyArray<{
    sessionPath: string;
    sessionId: string;
    from: string;
    to: string;
  }>;
}

export interface LiveSessionTitlesReconcilePersist {
  (sessionPath: string, title: string, replaceExpectedTitle: string): Promise<void>;
}

/** Raised when the unique live namespace is not yet established. Callers must
 * report namespace unavailable rather than guessing from partial membership. */
export class LiveTitleNamespaceUnavailableError extends Error {
  readonly code = 'LIVE_TITLE_NAMESPACE_UNAVAILABLE';
  constructor() {
    super('The live session title namespace is not ready.');
    this.name = 'LiveTitleNamespaceUnavailableError';
  }
}

/** Raised for base titles that are blank, oversize beyond the 25-character
 * allowance, or not a single line. Oversize input is rejected, never
 * shortened, and automatic suffixes are additional to this limit. */
export class LiveSessionTitleBaseInvalidError extends Error {
  readonly code = 'LIVE_TITLE_BASE_INVALID';
  constructor() {
    super(
      `A new session title must be 1-${LIVE_SESSION_TITLE_BASE_MAX_CHARS} characters after trimming.`
      + ' Automatic collision suffixes are additional and must not consume the input allowance.',
    );
    this.name = 'LiveSessionTitleBaseInvalidError';
  }
}

interface PublishedTitle {
  sessionPath: string;
  sessionId: string;
}

interface AssignedTitle {
  sessionId: string;
  title: string;
}

interface ReservationState {
  reservationId: string;
  baseTitle: string;
  title: string;
  sessionPath: string;
  sessionId: string;
  state: 'reserved' | 'assigned';
}

interface ParsedEntry {
  sessionPath: string;
  sessionId: string;
  trimmedTitle: string;
  readonly sortKey: {
    validTimestamp: 0 | 1;
    timestamp: number;
    sessionId: string;
    sessionPath: string;
  };
}

/** Coordinator allocation authority for assigned live session titles. */
export class LiveSessionTitles {
  private namespaceReady = false;
  /** Trimmed assigned title → exact target. Published only after the owning
   * worker durably persisted the name (or it arrived durable at restoration). */
  private readonly published = new Map<string, PublishedTitle>();
  /** Live session path → currently published assigned title. One assigned
   * title per path; repeat reconciliation releases an overwritten alias. */
  private readonly assignedByPath = new Map<string, AssignedTitle>();
  private readonly reservations = new Map<string, ReservationState>();

  /** True only after a full successful reconciliation; every failure leaves
   * the namespace closed so callers report it as unavailable. */
  get ready(): boolean {
    return this.namespaceReady;
  }

  /** Establish (or repeat) reconciliation of restored live sessions. Existing
   * unique titles are preserved verbatim — including legacy titles longer than
   * the new base limit; collisions are resolved by durable creation timestamp
   * (valid first, ascending; missing/invalid last) then session identity, and
   * every suffix assignment is persisted through `persist` before its name is
   * published. A failed `persist` call frees that suffix reservation and
   * propagates the error with readiness failed closed. */
  async reconcile(
    entries: ReadonlyArray<LiveSessionTitleEntry>,
    persist: LiveSessionTitlesReconcilePersist,
    isCurrent: () => boolean = () => true,
  ): Promise<LiveSessionTitlesReconcileResult> {
    // Namespace unavailable while (re)initialization is incomplete.
    this.namespaceReady = false;

    const parsed: ParsedEntry[] = [];
    for (const entry of entries) {
      const trimmedTitle = entry.title?.trim();
      if (!trimmedTitle) continue;
      const timestamp = entry.headerTimestamp ? Date.parse(entry.headerTimestamp) : Number.NaN;
      const validTimestamp = Number.isFinite(timestamp) && timestamp > 0;
      parsed.push({
        sessionPath: entry.sessionPath,
        sessionId: entry.sessionId,
        trimmedTitle,
        sortKey: {
          validTimestamp: validTimestamp ? 0 : 1,
          timestamp: validTimestamp ? timestamp : 0,
          sessionId: entry.sessionId,
          sessionPath: entry.sessionPath,
        },
      });
    }
    parsed.sort((left, right) => {
      if (left.sortKey.validTimestamp !== right.sortKey.validTimestamp) {
        return left.sortKey.validTimestamp - right.sortKey.validTimestamp;
      }
      if (left.sortKey.timestamp !== right.sortKey.timestamp) {
        return left.sortKey.timestamp - right.sortKey.timestamp;
      }
      const byIdentity = left.sortKey.sessionId.localeCompare(right.sortKey.sessionId);
      if (byIdentity !== 0) return byIdentity;
      return left.sortKey.sessionPath.localeCompare(right.sortKey.sessionPath);
    });

    // Occupied names: everything already published or still reserved survives
    // a repeatable reconciliation pass, then every restored literal title is
    // reserved before any new suffix is allocated (an existing `Review (2)`
    // must not collide with a newly suffixed `Review`).
    const occupied = new Map<string, 'published' | 'reserved'>();
    for (const title of this.published.keys()) occupied.set(title, 'published');
    for (const reservation of this.reservations.values()) {
      occupied.set(reservation.title, 'reserved');
    }
    for (const entry of parsed) occupied.set(entry.trimmedTitle, 'published');

    const preserved: Array<LiveSessionTitlesReconcileResult['preserved'][number]> = [];
    const suffixed: Array<LiveSessionTitlesReconcileResult['suffixed'][number]> = [];
    try {
      for (const entry of parsed) {
        if (!isCurrent()) throw new LiveTitleNamespaceUnavailableError();
        const reserved = occupied.get(entry.trimmedTitle) === 'reserved';
        const holder = this.published.get(entry.trimmedTitle);
        if (!reserved && (!holder || holder.sessionPath === entry.sessionPath)) {
          // Keep the original (oldest) restored title. Idempotent on retry. The
          // entry's durable name outranks a still-unpublished in-flight
          // reservation holding the same title.
          this.publish(entry.sessionPath, entry.sessionId, entry.trimmedTitle);
          preserved.push({
            sessionPath: entry.sessionPath,
            sessionId: entry.sessionId,
            title: entry.trimmedTitle,
          });
          continue;
        }
        // Collision: the literal name is already held. Allocate
        // deterministically, persist through the fenced cold mutation
        // callback, and only then publish the assignment.
        const finalTitle = this.allocateTitle(entry.trimmedTitle, occupied);
        occupied.set(finalTitle, 'published');
        await persist(entry.sessionPath, finalTitle, entry.trimmedTitle);
        if (!isCurrent()) throw new LiveTitleNamespaceUnavailableError();
        this.publish(entry.sessionPath, entry.sessionId, finalTitle);
        suffixed.push({
          sessionPath: entry.sessionPath,
          sessionId: entry.sessionId,
          from: entry.trimmedTitle,
          to: finalTitle,
        });
      }
    } catch (error) {
      // Readiness fails closed: the namespace stays unavailable for callers.
      this.namespaceReady = false;
      throw error;
    }
    if (!isCurrent()) throw new LiveTitleNamespaceUnavailableError();
    this.namespaceReady = true;
    return {
      restoredEntries: entries.length,
      preserved,
      suffixed,
    };
  }

  /** Synchronously reserve a unique title for a new or reopened live session.
   * This must never await: the occupied-title check and its reservation
   * complete in this synchronous turn, so concurrent allocations cannot collide
   * and no allocation critical section is held through an owner persistence
   * callback. Session identity must already be resolved by the caller (reuse
   * `resolveSessionIdentity`, including its deterministic normalized-path
   * fallback for legacy headers). The returned title stays reserved until the
   * owning flow confirms durable persistence with {@link confirm}; an
   * unconfirmed reservation is never published to `resolve()`. */
  reserve(
    baseTitle: string,
    identity: { sessionPath: string; sessionId: string },
  ): LiveSessionTitleReservation {
    if (!this.namespaceReady) throw new LiveTitleNamespaceUnavailableError();
    const normalized = normalizeBaseTitle(baseTitle);
    const occupied = new Map<string, 'published' | 'reserved'>();
    for (const title of this.published.keys()) occupied.set(title, 'published');
    for (const reservation of this.reservations.values()) {
      occupied.set(reservation.title, 'reserved');
    }
    const title = this.allocateTitle(normalized, occupied);
    const reservationId = crypto.randomUUID();
    const state: ReservationState = {
      reservationId,
      baseTitle: normalized,
      title,
      sessionPath: identity.sessionPath,
      sessionId: identity.sessionId,
      state: 'reserved',
    };
    this.reservations.set(reservationId, state);
    return { ...state };
  }

  /** Publish a reservation after its owning worker durably persisted the
   * assigned title. The name stays reserved until an explicitly confirmed
   * close/deletion calls {@link release}. Publishing is refused when the title
   * has meanwhile been durably published to a different session (repeat
   * reconciliation restored it first, and an entry's durable name outranks a
   * still-unpublished reservation); the owning flow must release and reserve
   * again under the resolved namespace. */
  confirm(reservation: LiveSessionTitleReservation): void {
    const state = this.reservations.get(reservation.reservationId);
    if (!state) throw new Error(`Live title reservation is stale: ${reservation.reservationId}`);
    if (state.state === 'reserved') {
      const holder = this.published.get(state.title);
      if (holder && holder.sessionPath !== state.sessionPath) {
        throw new Error(
          `Live title reservation conflicts with a durable assignment: ${state.title}`,
        );
      }
      this.publish(reservation.sessionPath, reservation.sessionId, reservation.title);
      state.state = 'assigned';
    }
  }

  /** Free a reservation. Closing retains the reservation until the confirmed
   * close/deletion; the recorded title stays in historical metadata, but the
   * live name becomes reusable again (identity is NOT preserved: released
   * titles are not historical aliases). Stale (already released) reservations
   * are rejected rather than silently freeing a re-allocated name. */
  release(reservation: LiveSessionTitleReservation): void {
    const state = this.reservations.get(reservation.reservationId);
    if (!state || state.reservationId !== reservation.reservationId) {
      throw new Error(`Live title reservation is stale: ${reservation.reservationId}`);
    }
    if (state.state === 'assigned') {
      this.unassign(state.sessionPath, state.title);
    }
    this.reservations.delete(state.reservationId);
  }

  /** Repeatable refresh after a successful reconciliation: publish durable
   * assigned titles for newly admitted live sessions only (a reopened history
   * session or a duplicate tab). The caller supplies resolved durable identity
   * per entry, never archive rows. Existing unique titles publish verbatim;
   * entries colliding with a published/reserved name allocate deterministic
   * suffixes that are persisted through `persist` (the coordinator chooses the
   * owning writer per path) before publication. A failed persist propagates
   * without changing readiness. An in-flight reservation that took a colliding
   * name meanwhile fails its own confirmed publish and must release and
   * reserve again; this method never mutates reservations. */
  async admit(
    entries: ReadonlyArray<LiveSessionTitleEntry>,
    persist: LiveSessionTitlesReconcilePersist,
  ): Promise<void> {
    if (!this.namespaceReady) throw new LiveTitleNamespaceUnavailableError();
    const pending: ParsedEntry[] = [];
    for (const entry of entries) {
      const trimmedTitle = entry.title?.trim();
      if (!trimmedTitle) continue;
      // Assigned sessions are stable while live; a repeated admission never
      // retargets or re-suffixes a published assignment.
      if (this.assignedByPath.get(entry.sessionPath)) continue;
      const timestamp = entry.headerTimestamp ? Date.parse(entry.headerTimestamp) : Number.NaN;
      const validTimestamp = Number.isFinite(timestamp) && timestamp > 0;
      pending.push({
        sessionPath: entry.sessionPath,
        sessionId: entry.sessionId,
        trimmedTitle,
        sortKey: {
          validTimestamp: validTimestamp ? 0 : 1,
          timestamp: validTimestamp ? timestamp : 0,
          sessionId: entry.sessionId,
          sessionPath: entry.sessionPath,
        },
      });
    }
    pending.sort((left, right) => {
      if (left.sortKey.validTimestamp !== right.sortKey.validTimestamp) {
        return left.sortKey.validTimestamp - right.sortKey.validTimestamp;
      }
      if (left.sortKey.timestamp !== right.sortKey.timestamp) {
        return left.sortKey.timestamp - right.sortKey.timestamp;
      }
      const byIdentity = left.sortKey.sessionId.localeCompare(right.sortKey.sessionId);
      if (byIdentity !== 0) return byIdentity;
      return left.sortKey.sessionPath.localeCompare(right.sortKey.sessionPath);
    });
    // Existing literal suffixes outrank newly allocated suffixes, regardless
    // of the order in which the incoming paths were read.
    const literals = new Set(pending.map((entry) => entry.trimmedTitle));
    for (const entry of pending) {
      const holder = this.published.get(entry.trimmedTitle);
      if (!holder || holder.sessionPath === entry.sessionPath) {
        this.publish(entry.sessionPath, entry.sessionId, entry.trimmedTitle);
        continue;
      }
      const occupied = new Map<string, unknown>();
      for (const title of this.published.keys()) occupied.set(title, 'published');
      for (const reservation of this.reservations.values()) {
        occupied.set(reservation.title, 'reserved');
      }
      for (const literal of literals) occupied.set(literal, 'literal');
      const finalTitle = this.allocateTitle(entry.trimmedTitle, occupied);
      // Reserve synchronously before crossing the owner-write await: a
      // concurrent reopen/duplicate cannot allocate this same suffix.
      const reservation: ReservationState = {
        reservationId: crypto.randomUUID(), baseTitle: entry.trimmedTitle,
        title: finalTitle, sessionPath: entry.sessionPath, sessionId: entry.sessionId,
        state: 'reserved',
      };
      this.reservations.set(reservation.reservationId, reservation);
      try {
        await persist(entry.sessionPath, finalTitle, entry.trimmedTitle);
        this.confirm(reservation);
      } catch (error) {
        this.release(reservation);
        throw error;
      }
    }
  }

  /** Free the published assignment of a confirmed-closed live session. The
   * caller retires only after the host removed the path from both its live and
   * closing reservations (a failed close restores membership instead). In-flight
   * (unconfirmed) reservations are untouched: their owning flow owns
   * confirm/release. Confirmed reservations for the path are dropped with the
   * assignment; a later `release` of that stale object is rejected rather than
   * silently re-freeing a name. */
  retireLive(sessionPath: string): void {
    for (const [reservationId, reservation] of this.reservations) {
      if (reservation.sessionPath !== sessionPath || reservation.state !== 'assigned') continue;
      this.reservations.delete(reservationId);
    }
    const current = this.assignedByPath.get(sessionPath);
    if (!current) return;
    this.unassign(sessionPath, current.title);
  }

  /** Exact title matching after trimming outer whitespace, without fuzzy
   * matching. Unassigned reservations are not published and never resolve here
   * (a caller must never wait for a guessed future name). */
  resolve(title: string): LiveSessionTitleResolution | undefined {
    if (!this.namespaceReady) throw new LiveTitleNamespaceUnavailableError();
    const normalized = title.trim();
    if (!normalized) return undefined;
    const holder = this.published.get(normalized);
    if (!holder) return undefined;
    return { sessionPath: holder.sessionPath, sessionId: holder.sessionId };
  }

  /** The currently published assigned title for a live session path, if any.
   * Unassigned (provisional) sessions are undefined here. */
  assigned(sessionPath: string): string | undefined {
    return this.assignedByPath.get(sessionPath)?.title;
  }

  /** Compact deterministic snapshot of every live assigned/reserved title. */
  list(): readonly LiveSessionTitleRecord[] {
    const records: LiveSessionTitleRecord[] = [];
    for (const reservation of this.reservations.values()) {
      if (reservation.state !== 'reserved') continue;
      records.push({
        sessionPath: reservation.sessionPath,
        sessionId: reservation.sessionId,
        title: reservation.title,
        state: 'reserved',
      });
    }
    for (const [sessionPath, assigned] of this.assignedByPath.entries()) {
      records.push({
        sessionPath,
        sessionId: assigned.sessionId,
        title: assigned.title,
        state: 'assigned',
      });
    }
    return records.sort((left, right) => {
      const byTitle = left.title.localeCompare(right.title);
      if (byTitle !== 0) return byTitle;
      return left.sessionPath.localeCompare(right.sessionPath);
    });
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** Publish an assigned title. Never call before the name is durably
   * persisted on its owner (reconcile entries are durable already). */
  private publish(sessionPath: string, sessionId: string, title: string): void {
    // A repeatable reconciliation that re-assigns a path frees its previous
    // published name so no historical alias is retained.
    const previous = this.assignedByPath.get(sessionPath);
    if (previous && previous.title !== title) this.published.delete(previous.title);
    this.published.set(title, { sessionPath, sessionId });
    this.assignedByPath.set(sessionPath, { sessionId, title });
  }

  private unassign(sessionPath: string, title: string): void {
    const holder = this.published.get(title);
    if (holder && holder.sessionPath === sessionPath) this.published.delete(title);
    const pathHolder = this.assignedByPath.get(sessionPath);
    if (pathHolder?.title === title) this.assignedByPath.delete(sessionPath);
  }

  private allocateTitle(baseTitle: string, occupied: ReadonlyMap<string, unknown>): string {
    if (!occupied.has(baseTitle)) return baseTitle;
    for (let suffix = 2; suffix <= LIVE_SESSION_TITLE_SUFFIX_SEARCH_LIMIT; suffix += 1) {
      const candidate = `${baseTitle} (${suffix})`;
      if (!occupied.has(candidate)) return candidate;
    }
    throw new Error(`Unable to allocate a collision suffix for: ${baseTitle}`);
  }
}

/** Tool-facing alias for the base-title normalizer: the session-control tool
 *  and create flow share this so bounds never diverge between layers. */
export function normalizeSessionControlBaseTitle(raw: string): string {
  return normalizeBaseTitle(raw);
}

/** Normalize a prospective base title: trim outer whitespace, require 1–25
 * characters and a single line. Suffixes are allocated separately. */
function normalizeBaseTitle(raw: string): string {
  const normalized = raw.trim();
  if (!normalized
    || normalized.length > LIVE_SESSION_TITLE_BASE_MAX_CHARS
    || /[\r\n]/.test(normalized)) {
    throw new LiveSessionTitleBaseInvalidError();
  }
  return normalized;
}