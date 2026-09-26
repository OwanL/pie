/**
 * Per-session store of the skill-pruner's kept-skill set, consumed by the
 * subagent runner so subagent sessions inherit the main agent's pruned skills
 * (direction C) without running their own prepass.
 *
 * The pruner writes the kept set on every MAIN `before_agent_start` path; the
 * subagent runner reads it (keyed by the parent session id) and passes a
 * `skillsOverride` to its resource loader that filters loaded skills by name.
 *
 * Keyed by the MAIN session id — the same value the pruner computes via
 * `getSessionId(ctx)` and the subagent resolves from its parent ToolContext's
 * `sessionManager.getSessionId()`. Keying by session id (not a process-global)
 * is concurrency-safe across multiple main sessions in one process — the same
 * reason `subagent-context.ts` avoids a module global for nesting depth.
 *
 * Because the pruner writes on EVERY main turn (kept-set or "keep-all"), a
 * subagent spawned during a turn always reads a value written by that same
 * turn — never a stale set from a previous turn.
 *
 * "keep-all" is the sentinel for "no filtering" (pruner kept everything, was
 * skipped, errored, or had no skills). The subagent treats it the same as
 * "no record" → loads all skills (today's behavior).
 */

export type KeptSkills = string[] | "keep-all";

interface Entry {
	skills: KeptSkills;
	ts: number;
}

/** Soft cap on tracked sessions. The pruner writes once per main turn, so in
 *  practice the map holds ~one entry per active main session; the cap is a
 *  safety net against unbounded growth if session-end cleanup never fires. */
const MAX_ENTRIES = 64;
/** Entries older than this are considered stale and ignored on read. One hour
 *  comfortably outlasts any single turn's subagent fan-out. */
const TTL_MS = 60 * 60 * 1000;

const store = new Map<string, Entry>();

/** Records the kept-skill set for a main session turn. */
export function recordKeptSkills(sessionId: string, skills: KeptSkills): void {
	if (!sessionId) return;
	// Bound growth: when at capacity and inserting a new key, evict the oldest.
	if (store.size >= MAX_ENTRIES && !store.has(sessionId)) {
		let oldestKey: string | undefined;
		let oldestTs = Infinity;
		for (const [key, entry] of store) {
			if (entry.ts < oldestTs) {
				oldestTs = entry.ts;
				oldestKey = key;
			}
		}
		if (oldestKey !== undefined) store.delete(oldestKey);
	}
	store.set(sessionId, { skills, ts: Date.now() });
}

/** Reads the kept-skill set for a main session, or `undefined` when none is
 *  recorded (or the record has expired). `undefined` and `"keep-all"` both
 *  mean "apply no filter" to the subagent. */
export function readKeptSkills(sessionId: string): KeptSkills | undefined {
	if (!sessionId) return undefined;
	const entry = store.get(sessionId);
	if (!entry) return undefined;
	if (Date.now() - entry.ts > TTL_MS) {
		store.delete(sessionId);
		return undefined;
	}
	return entry.skills;
}

/** Removes the kept-skill set for a session (best-effort cleanup). */
export function clearKeptSkills(sessionId: string): void {
	store.delete(sessionId);
}
