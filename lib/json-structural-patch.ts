export type JsonSafePrimitive = null | boolean | number | string;
export type JsonSafeValue = JsonSafePrimitive | JsonSafeValue[] | { [key: string]: JsonSafeValue };
export type JsonPatchPathSegment = string | number;
export type JsonPatchPath = JsonPatchPathSegment[];

export type JsonStructuralPatchOperation =
  | { op: 'set'; path: JsonPatchPath; value: JsonSafeValue }
  | { op: 'delete'; path: JsonPatchPath }
  | { op: 'appendString'; path: JsonPatchPath; value: string }
  | { op: 'appendArray'; path: JsonPatchPath; value: JsonSafeValue[] };

export interface JsonPatchLimits {
  maxDepth: number;
  maxPathSegments: number;
  maxOperations: number;
}

export const DEFAULT_JSON_PATCH_LIMITS: JsonPatchLimits = {
  maxDepth: 64,
  maxPathSegments: 128,
  maxOperations: 4_096,
};

export type JsonPatchApplyResult =
  | { ok: true; value: JsonSafeValue }
  | { ok: false; reason: string };

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function diffJsonValues(
  previous: JsonSafeValue,
  next: JsonSafeValue,
  limits: JsonPatchLimits = DEFAULT_JSON_PATCH_LIMITS,
): JsonStructuralPatchOperation[] {
  if (!isJsonSafeValue(previous, limits) || !isJsonSafeValue(next, limits)) {
    throw new Error('Structural patch inputs must be bounded JSON-safe values.');
  }
  const operations: JsonStructuralPatchOperation[] = [];
  diffAt(previous, next, [], operations, limits);
  if (operations.length > limits.maxOperations) return [{ op: 'set', path: [], value: cloneJson(next) }];
  return compactJsonPatchOperations(operations);
}

export function applyJsonPatch(
  previous: JsonSafeValue,
  operations: readonly JsonStructuralPatchOperation[],
  limits: JsonPatchLimits = DEFAULT_JSON_PATCH_LIMITS,
): JsonPatchApplyResult {
  if (!isJsonSafeValue(previous, limits)) return { ok: false, reason: 'base is not bounded JSON-safe data' };
  if (!Array.isArray(operations) || operations.length > limits.maxOperations) {
    return { ok: false, reason: 'patch operation capacity exceeded' };
  }
  let root = cloneJson(previous);
  for (const operation of operations) {
    const validation = validateOperation(operation, limits);
    if (validation) return { ok: false, reason: validation };
    if (operation.path.length === 0) {
      if (operation.op !== 'set') return { ok: false, reason: 'only set may target the root' };
      root = cloneJson(operation.value);
      continue;
    }
    const resolved = resolveParent(root, operation.path);
    if (!resolved) return { ok: false, reason: 'patch path does not exist' };
    const { parent, key } = resolved;
    if (operation.op === 'set') {
      if (!setChild(parent, key, cloneJson(operation.value))) return { ok: false, reason: 'invalid set target' };
    } else if (operation.op === 'delete') {
      if (!deleteChild(parent, key)) return { ok: false, reason: 'invalid delete target' };
    } else {
      const current = getChild(parent, key);
      if (operation.op === 'appendString') {
        if (typeof current !== 'string') return { ok: false, reason: 'appendString target is not a string' };
        if (!setChild(parent, key, current + operation.value)) return { ok: false, reason: 'invalid append target' };
      } else {
        if (!Array.isArray(current)) return { ok: false, reason: 'appendArray target is not an array' };
        current.push(...operation.value.map(cloneJson));
      }
    }
  }
  return { ok: true, value: root };
}

export function compactJsonPatchOperations(
  operations: readonly JsonStructuralPatchOperation[],
): JsonStructuralPatchOperation[] {
  const compacted: JsonStructuralPatchOperation[] = [];
  for (const operation of operations) {
    const copy = cloneOperation(operation);
    const previous = compacted[compacted.length - 1];
    if (previous && samePath(previous.path, copy.path)) {
      if (previous.op === 'appendString' && copy.op === 'appendString') {
        previous.value += copy.value;
        continue;
      }
      if (previous.op === 'appendArray' && copy.op === 'appendArray') {
        previous.value.push(...copy.value.map(cloneJson));
        continue;
      }
      if ((previous.op === 'set' && copy.op === 'set')
        || (previous.op === 'delete' && copy.op === 'delete')) {
        compacted[compacted.length - 1] = copy;
        continue;
      }
    }
    compacted.push(copy);
  }
  return compacted;
}

export function isJsonSafeValue(
  value: unknown,
  limits: JsonPatchLimits = DEFAULT_JSON_PATCH_LIMITS,
): value is JsonSafeValue {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, depth: number): boolean => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return true;
    if (typeof candidate === 'number') return Number.isFinite(candidate);
    if (typeof candidate !== 'object' || depth > limits.maxDepth || seen.has(candidate)) return false;
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.prototype.hasOwnProperty.call(candidate, index)
            || !visit(candidate[index], depth + 1)) return false;
        }
        return true;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.keys(candidate).every((key) => !FORBIDDEN_KEYS.has(key)
        && visit((candidate as Record<string, unknown>)[key], depth + 1));
    } catch {
      return false;
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
}

function diffAt(
  previous: JsonSafeValue,
  next: JsonSafeValue,
  path: JsonPatchPath,
  operations: JsonStructuralPatchOperation[],
  limits: JsonPatchLimits,
): void {
  if (deepEqual(previous, next)) return;
  if (typeof previous === 'string' && typeof next === 'string' && next.startsWith(previous)) {
    operations.push({ op: 'appendString', path: [...path], value: next.slice(previous.length) });
    return;
  }
  if (Array.isArray(previous) && Array.isArray(next)) {
    const common = Math.min(previous.length, next.length);
    for (let index = 0; index < common; index += 1) {
      diffAt(previous[index]!, next[index]!, [...path, index], operations, limits);
      if (operations.length > limits.maxOperations) return;
    }
    if (next.length > previous.length) {
      operations.push({ op: 'appendArray', path: [...path], value: next.slice(previous.length).map(cloneJson) });
    } else {
      for (let index = previous.length - 1; index >= next.length; index -= 1) {
        operations.push({ op: 'delete', path: [...path, index] });
      }
    }
    return;
  }
  if (isPlainJsonObject(previous) && isPlainJsonObject(next)) {
    for (const key of Object.keys(previous)) {
      if (!hasOwn(next, key)) operations.push({ op: 'delete', path: [...path, key] });
    }
    for (const [key, value] of Object.entries(next)) {
      if (!hasOwn(previous, key)) operations.push({ op: 'set', path: [...path, key], value: cloneJson(value) });
      else diffAt(previous[key]!, value, [...path, key], operations, limits);
      if (operations.length > limits.maxOperations) return;
    }
    return;
  }
  operations.push({ op: 'set', path: [...path], value: cloneJson(next) });
}

function validateOperation(operation: unknown, limits: JsonPatchLimits): string | undefined {
  if (!operation || typeof operation !== 'object') return 'malformed patch operation';
  const candidate = operation as Partial<JsonStructuralPatchOperation>;
  if (!Array.isArray(candidate.path) || candidate.path.length > limits.maxPathSegments) return 'invalid patch path';
  for (const segment of candidate.path) {
    if (typeof segment === 'string') {
      if (FORBIDDEN_KEYS.has(segment)) return 'forbidden patch path';
    } else if (!Number.isSafeInteger(segment) || segment < 0) return 'invalid array index';
  }
  if (candidate.op === 'set') return isJsonSafeValue(candidate.value, limits) ? undefined : 'set value is not JSON-safe';
  if (candidate.op === 'delete') return undefined;
  if (candidate.op === 'appendString') return typeof candidate.value === 'string' ? undefined : 'invalid string append';
  if (candidate.op === 'appendArray') {
    return Array.isArray(candidate.value) && candidate.value.every((entry) => isJsonSafeValue(entry, limits))
      ? undefined : 'invalid array append';
  }
  return 'unknown patch operation';
}

function resolveParent(root: JsonSafeValue, path: JsonPatchPath): { parent: JsonSafeValue[] | Record<string, JsonSafeValue>; key: JsonPatchPathSegment } | undefined {
  let current: JsonSafeValue = root;
  for (const segment of path.slice(0, -1)) {
    const child = getChild(current, segment);
    if (child === undefined || child === null || typeof child !== 'object') return undefined;
    current = child;
  }
  if (current === null || typeof current !== 'object') return undefined;
  return { parent: current, key: path[path.length - 1]! };
}

function getChild(parent: JsonSafeValue, key: JsonPatchPathSegment): JsonSafeValue | undefined {
  if (Array.isArray(parent)) return typeof key === 'number' ? parent[key] : undefined;
  if (isPlainJsonObject(parent)) return typeof key === 'string' && hasOwn(parent, key) ? parent[key] : undefined;
  return undefined;
}

function setChild(parent: JsonSafeValue[] | Record<string, JsonSafeValue>, key: JsonPatchPathSegment, value: JsonSafeValue): boolean {
  if (Array.isArray(parent)) {
    if (typeof key !== 'number' || key > parent.length) return false;
    parent[key] = value;
    return true;
  }
  if (typeof key !== 'string' || FORBIDDEN_KEYS.has(key)) return false;
  parent[key] = value;
  return true;
}

function deleteChild(parent: JsonSafeValue[] | Record<string, JsonSafeValue>, key: JsonPatchPathSegment): boolean {
  if (Array.isArray(parent)) {
    if (typeof key !== 'number' || key >= parent.length) return false;
    parent.splice(key, 1);
    return true;
  }
  if (typeof key !== 'string' || !hasOwn(parent, key)) return false;
  delete parent[key];
  return true;
}

function isPlainJsonObject(value: JsonSafeValue): value is Record<string, JsonSafeValue> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson<T extends JsonSafeValue>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry)) as T;
  const clone: Record<string, JsonSafeValue> = {};
  for (const [key, entry] of Object.entries(value)) clone[key] = cloneJson(entry);
  return clone as T;
}

function cloneOperation(operation: JsonStructuralPatchOperation): JsonStructuralPatchOperation {
  if (operation.op === 'set') return { ...operation, path: [...operation.path], value: cloneJson(operation.value) };
  if (operation.op === 'appendArray') return { ...operation, path: [...operation.path], value: operation.value.map(cloneJson) };
  return { ...operation, path: [...operation.path] };
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function samePath(left: JsonPatchPath, right: JsonPatchPath): boolean {
  return left.length === right.length && left.every((segment, index) => segment === right[index]);
}

function deepEqual(left: JsonSafeValue, right: JsonSafeValue): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]!));
  }
  if (isPlainJsonObject(left) && isPlainJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key) => hasOwn(right, key) && deepEqual(left[key]!, right[key]!));
  }
  return false;
}
