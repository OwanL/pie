import {
  isLiveSubagentDetailAddress,
  type LiveSubagentDetailAddress,
} from '../../../shared/protocol/subagent-detail.js';

interface ChildCollection {
  children: unknown[];
  replace(children: unknown[]): unknown;
}

export type SubagentDetailAddressRoot = Omit<LiveSubagentDetailAddress, 'lineage'>;

/**
 * A terminal tool event intentionally releases its progress preview. Rebuild
 * the small immutable address from the terminal child's producer identity and
 * the owning live tool record rather than retaining the recursive preview.
 */
export function reconstructSubagentDetailAddresses(
  result: unknown,
  root: SubagentDetailAddressRoot,
): unknown {
  const collection = childCollection(result);
  if (!collection) return result;

  let changed = false;
  const children = collection.children.map((candidate) => {
    if (!isRecord(candidate)
      || isLiveSubagentDetailAddress(candidate.detailAddress)
      || candidate.liveAddressable !== true
      || !Array.isArray(candidate.lineage)) return candidate;
    const address = { ...root, lineage: candidate.lineage };
    if (!isLiveSubagentDetailAddress(address)) return candidate;
    changed = true;
    return { ...candidate, detailAddress: address };
  });

  return changed ? collection.replace(children) : result;
}

/**
 * Restore the small producer-owned detail address after a subagent's terminal
 * result replaces its live progress preview. The durable/terminal result stays
 * authoritative for every content field; only an address whose child identity
 * matches exactly is carried across.
 */
export function retainSubagentDetailAddresses(
  result: unknown,
  addressSource: unknown,
): unknown {
  const resultCollection = childCollection(result);
  const sourceCollection = childCollection(addressSource);
  if (!resultCollection || !sourceCollection) return result;

  const addresses = addressMap(sourceCollection.children);
  if (addresses.size === 0) return result;

  let changed = false;
  const children = resultCollection.children.map((candidate) => {
    if (!isRecord(candidate)) return candidate;
    if (isLiveSubagentDetailAddress(candidate.detailAddress)) return candidate;
    const key = childIdentityKey(candidate);
    const address = key ? addresses.get(key) : undefined;
    if (!address) return candidate;
    changed = true;
    return { ...candidate, liveAddressable: true, detailAddress: address };
  });

  return changed ? resultCollection.replace(children) : result;
}

function addressMap(children: readonly unknown[]): Map<string, LiveSubagentDetailAddress> {
  const addresses = new Map<string, LiveSubagentDetailAddress>();
  const ambiguous = new Set<string>();
  for (const candidate of children) {
    if (!isRecord(candidate) || !isLiveSubagentDetailAddress(candidate.detailAddress)) continue;
    const key = childIdentityKey(candidate);
    if (!key || ambiguous.has(key)) continue;
    if (addresses.has(key)) {
      addresses.delete(key);
      ambiguous.add(key);
      continue;
    }
    addresses.set(key, candidate.detailAddress);
  }
  return addresses;
}

function childIdentityKey(value: Record<string, unknown>): string | undefined {
  if (typeof value.childId === 'string' && typeof value.attemptId === 'string') {
    return JSON.stringify(['child', value.childId, value.attemptId]);
  }
  if (!Array.isArray(value.lineage) || value.lineage.length === 0) return undefined;
  const lineage = value.lineage.map((candidate) => {
    if (!isRecord(candidate)
      || typeof candidate.childId !== 'string'
      || typeof candidate.spawningToolCallId !== 'string'
      || typeof candidate.attemptId !== 'string') return undefined;
    return [candidate.childId, candidate.spawningToolCallId, candidate.attemptId] as const;
  });
  return lineage.every((candidate) => candidate !== undefined)
    ? JSON.stringify(['lineage', lineage])
    : undefined;
}

function childCollection(value: unknown): ChildCollection | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'subagent' && Array.isArray(value.children)) {
    return {
      children: value.children,
      replace: (children) => ({ ...value, children }),
    };
  }
  if (Array.isArray(value.results)) {
    return {
      children: value.results,
      replace: (children) => ({ ...value, results: children }),
    };
  }
  if (isRecord(value.details)) {
    const details = value.details;
    if (Array.isArray(details.results)) {
      return {
        children: details.results,
        replace: (children) => ({ ...value, details: { ...details, results: children } }),
      };
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
