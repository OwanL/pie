/**
 * Reference-stabilization helpers for host-delivered config objects.
 *
 * The host posts a fully-serialized `ViewState` on every `state` message
 * (≈7/sec while streaming, debounced to 150ms). `postMessage`'s structured
 * clone gives every nested object a fresh reference even when its content is
 * byte-identical, which defeats downstream `memo()` barriers,
 * `useMemo`/`useCallback` deps, and pref-driven `useEffect`s — they all re-run
 * on every snapshot. To make those barriers effective we reuse the previous
 * reference when a config object's content is structurally unchanged.
 *
 * Only the small, infrequently-changing JSON-like config objects (`prefs`,
 * `pruningSettings`, `pruningCatalog`) are stabilized here. The transcript is
 * left untouched (it changes shape every snapshot while streaming, and a
 * correct content comparison would be O(n) per tick).
 */

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Recursive equality for the small JSON-like config values posted on every
 * host `state` message. Arrays are compared by index and plain records by key,
 * including nested arrays/maps such as ChatPrefs' model buckets and per-session
 * provider settings. Unsupported prototypes fail open so a class/Date/Map from
 * a malformed snapshot can never cause a stale reference to be reused.
 */
function jsonLikeConfigEqual(
  left: unknown,
  right: unknown,
  leftAncestors: WeakSet<object>,
  rightAncestors: WeakSet<object>,
): boolean {
  if (Object.is(left, right)) return true;

  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray || rightIsArray) {
    if (!leftIsArray || !rightIsArray || left.length !== right.length) return false;
    if (leftAncestors.has(left) || rightAncestors.has(right)) return false;
    leftAncestors.add(left);
    rightAncestors.add(right);
    try {
      for (let index = 0; index < left.length; index += 1) {
        if ((index in left) !== (index in right)) return false;
        if (!jsonLikeConfigEqual(left[index], right[index], leftAncestors, rightAncestors)) return false;
      }
      return true;
    } finally {
      leftAncestors.delete(left);
      rightAncestors.delete(right);
    }
  }

  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  if (leftAncestors.has(left) || rightAncestors.has(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  leftAncestors.add(left);
  rightAncestors.add(right);
  try {
    for (const key of leftKeys) {
      if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
      if (!jsonLikeConfigEqual(left[key], right[key], leftAncestors, rightAncestors)) return false;
    }
    return true;
  } finally {
    leftAncestors.delete(left);
    rightAncestors.delete(right);
  }
}

/**
 * Structural equality for host-delivered config objects. The historical export
 * name is retained for callers; comparison now follows nested JSON-like data.
 */
export function shallowConfigEqual(a: object, b: object): boolean {
  return jsonLikeConfigEqual(a, b, new WeakSet<object>(), new WeakSet<object>());
}

/**
 * Reuse `stable` when its content equals `candidate` (keeping a stable
 * reference across host state posts that didn't actually change this config),
 * otherwise adopt `candidate`. Pure and stateless; the caller owns the cached
 * reference (e.g. a module-level `let`).
 */
export function pickStable<T extends object>(stable: T | null, candidate: T): T {
  if (stable && shallowConfigEqual(stable, candidate)) {
    return stable;
  }
  return candidate;
}
