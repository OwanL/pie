/** Consume only the earliest value-matching prefix of ordered host echoes.
 * A value is not a request revision: a duplicate may represent an older intent,
 * even when it also equals the newest. Keep the remaining intent until a later
 * unambiguous match or unrelated authoritative value resolves it. Coalescing
 * can skip any prefix, but cannot justify choosing a later duplicate.
 * An external change equal to a pending value is inherently indistinguishable
 * from its echo and is treated conservatively by the same rule. */
export function reconcileOptimisticEcho<T>(
  queue: T[],
  echo: T,
  equal: (a: T, b: T) => boolean,
): T[] {
  if (queue.length === 0) return queue;
  const index = queue.findIndex((intent) => equal(intent, echo));
  return index < 0 ? [] : queue.slice(index + 1);
}
