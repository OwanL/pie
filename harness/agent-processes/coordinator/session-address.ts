import {
  createSessionAddress,
  parseSessionReplyReference,
  type SessionControlSenderIdentity,
} from '../lib/rpc/session-control-attribution.js';

export { createSessionAddress };
const SESSION_ADDRESS_PREFIX = 'pie-session:v1:';

export type SessionAddressResolution<T> =
  | { status: 'resolved'; value: T }
  | { status: 'unavailable' }
  | { status: 'ambiguous' }
  | { status: 'invalid' };

/** Resolve either a current compact address or a historical reply reference
 * against caller-supplied authoritative candidates. More than one match fails
 * closed, including duplicated identities or a truncated-hash collision. */
export function resolveSessionAddress<T>(
  address: unknown,
  candidates: readonly { identity: SessionControlSenderIdentity; value: T }[],
): SessionAddressResolution<T> {
  if (typeof address !== 'string') return { status: 'invalid' };
  let matches: typeof candidates[number][];
  if (address.startsWith(SESSION_ADDRESS_PREFIX)) {
    if (!/^pie-session:v1:[0-9a-f]{16}$/.test(address)) return { status: 'invalid' };
    matches = candidates.filter(candidate => createSessionAddress(candidate.identity) === address);
  } else if (address.startsWith('pie-reply:')) {
    const identity = parseSessionReplyReference(address);
    if (!identity) return { status: 'invalid' };
    matches = candidates.filter(candidate => candidate.identity.sessionId === identity.sessionId
      && candidate.identity.identityFallback === identity.identityFallback);
  } else {
    return { status: 'invalid' };
  }
  if (matches.length === 0) return { status: 'unavailable' };
  if (matches.length !== 1) return { status: 'ambiguous' };
  return { status: 'resolved', value: matches[0].value };
}
