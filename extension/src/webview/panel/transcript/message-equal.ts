import type { ChatMessage } from '../../../shared/protocol';

/**
 * Content equality for {@link ChatMessage}, used by `MessageItem`'s `memo`
 * comparer so unchanged rows bail out of rendering on host snapshot posts.
 *
 * Why this exists: the host posts a fully serialized `ViewState` ~7×/sec while
 * streaming. `postMessage`'s structured clone gives every message a fresh
 * reference even when its content is byte-identical, which defeats
 * `MessageItem = memo(MessageItemView)`'s default shallow compare (the
 * `message` prop is always a "new" object). Without a content comparer, every
 * visible row re-renders on every snapshot — including the ~10–15 virtualized
 * rows that haven't changed — paying for hook re-runs, `renderMarkdown` cache
 * lookups, and Preact reconciliation each tick.
 *
 * The whole-transcript reference-stabilization in `view-state-stabilize.ts`
 * is deliberately NOT applied to the transcript (it would be O(n) per tick for
 * every message, not just the visible ones). This comparer is O(visible rows)
 * instead — it only runs for rows the virtualizer actually renders.
 *
 * Completeness: every field of {@link ChatMessage} is covered. Primitives and
 * strings use `===` with early-exit (during streaming the streaming message's
 * `markdown` grows, so the `markdown !==` check fails fast without touching the
 * nested arrays). Nested arrays/objects (`parts`, `toolCalls`, `userParts`,
 * `usage`, `customDetails`) fall through to `deepEqual`, which is
 * complete-by-construction — a newly added field on `ChatMessage` only needs to
 * be added here to stay covered, and a missed addition fails safe (the field
 * would be absent from the `deepEqual` calls, but since `deepEqual` walks the
 * whole sub-object structurally, nested fields are still compared; a brand-new
 * top-level field would require an explicit check, so a test enumerates the
 * fields).
 */
export function chatMessageEqual(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true;

  // Cheap primitive/string early-exits. String `!==` is O(length) but
  // allocation-free and early-exits on the first differing byte — the
  // streaming message bails here (markdown grew) without reaching the nested
  // structural comparisons below.
  if (
    a.id !== b.id ||
    a.role !== b.role ||
    a.status !== b.status ||
    a.createdAt !== b.createdAt ||
    a.markdown !== b.markdown ||
    a.thinking !== b.thinking ||
    a.modelId !== b.modelId ||
    a.thinkingLevel !== b.thinkingLevel ||
    a.errorDetail !== b.errorDetail ||
    a.durationMs !== b.durationMs ||
    a.turnLatencyMs !== b.turnLatencyMs ||
    a.overheadMs !== b.overheadMs ||
    a.providerLatencyMs !== b.providerLatencyMs ||
    a.customType !== b.customType
  ) {
    return false;
  }

  // Nested arrays/objects. Only reached when every primitive matched, i.e. the
  // message appears unchanged — `deepEqual` confirms the nested content is
  // identical too. The structural walk is complete (covers every own
  // enumerable nested field) so this can't silently reuse a stale reference for
  // a nested mutation that the primitive checks missed (e.g. a tool call's
  // `result` landing, or `parts` growing without `markdown` changing), and it
  // allocates nothing and early-exits on the first differing leaf (see
  // `deepEqual`).
  if (!deepEqual(a.parts, b.parts)) return false;
  if (!deepEqual(a.toolCalls, b.toolCalls)) return false;
  if (!deepEqual(a.userParts, b.userParts)) return false;
  if (!deepEqual(a.usage, b.usage)) return false;
  if (!deepEqual(a.customDetails, b.customDetails)) return false;
  return true;
}

/**
 * Structural deep equality for the nested `ChatMessage` fields (`parts`,
 * `toolCalls`, `userParts`, `usage`, `customDetails`).
 *
 * This runs inside {@link chatMessageEqual}, which `MessageItem`'s `memo()`
 * invokes for every visible row on every host snapshot (~7/sec while
 * streaming). For unchanged rows — the common case, since only the streaming
 * message's `markdown` grows — every primitive check passes and execution
 * reaches here to confirm the nested content is identical too. The previous
 * implementation (`JSON.stringify(a) === JSON.stringify(b)`) allocated two full
 * strings per field per visible row per snapshot and then compared them
 * byte-by-byte; for rows carrying large tool results (file reads, bash output)
 * that is significant per-frame allocation + GC pressure, and the cost was
 * invisible to the render-count perf test (`webview-render-count.test.ts`),
 * which only asserts that `MessageItemView`'s body doesn't re-run — not that
 * the comparer itself is cheap. This walk allocates nothing and early-exits on
 * the first differing leaf.
 *
 * Semantics match the old `JSON.stringify` comparison for all
 * `ChatMessage`-shaped data (typed arrays/objects from a structured clone; no
 * `undefined` array holes, no `undefined`-valued object keys, no `NaN`), and
 * corrects two latent footguns the old serializer-based check had:
 *   - `NaN`/`Infinity` no longer collapse to `null` (so `{x: NaN}` is no longer
 *     spuriously equal to `{x: null}`); token/usage counts are integers in
 *     practice, so this is a correctness hardening rather than a behavior
 *     change for real data.
 *   - Object key order no longer affects the result (the old check was order-
 *     sensitive because `JSON.stringify` walks insertion order); two
 *     structurally-identical objects whose keys serialize in different orders
 *     now compare equal, as intended.
 *
 * Rules:
 *   - identical references → equal (short-circuit; the cheap path for
 *     host-stabilized objects, and the only cheap path during streaming since
 *     the host re-clones everything else fresh each snapshot)
 *   - `undefined` is "absent": one absent / other present → unequal (so a
 *     missing optional field like `usage` is never confused with a present
 *     one); both-absent → equal (via the `a === b` short-circuit)
 *   - arrays: equal length + element-wise equality
 *   - objects: same own-enumerable string keys + per-key value equality
 *
 * Correctness is pinned by `test/message-equal.test.ts`, which enumerates a
 * difference in every single `ChatMessage` field (including nested
 * `parts`/`toolCalls`/`userParts`/`usage`/`customDetails` mutations and
 * absent-vs-present optionals).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // `undefined` is treated as "absent": one absent / other present is unequal.
  // (Both-absent already returned true via `a === b` above.)
  if (a === undefined || b === undefined) return false;
  // `null` is a value: both-null hit `a === b`; null-vs-anything-else differs.
  if (a === null || b === null) return false;

  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return false;
  // Primitives already failed `a === b` above, so type-matched non-object
  // values are unequal. (No NaN appears in ChatMessage-shaped data; if it did,
  // `NaN === NaN` is false here too, which is the desired non-collapsing
  // behaviour — see the docstring.)
  if (ta !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (aa.length !== bb.length) return false;
    for (let i = 0; i < aa.length; i++) {
      if (!deepEqual(aa[i], bb[i])) return false;
    }
    return true;
  }

  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  const aa = a as Record<string, unknown>;
  const bb = b as Record<string, unknown>;
  for (let i = 0; i < ka.length; i++) {
    const k = ka[i];
    if (!Object.prototype.hasOwnProperty.call(bb, k)) return false;
    if (!deepEqual(aa[k], bb[k])) return false;
  }
  return true;
}
