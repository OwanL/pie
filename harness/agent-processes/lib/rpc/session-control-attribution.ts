const SESSION_ID_MAX_BYTES = 512;
const TITLE_MAX_BYTES = 512;
export const SESSION_REPLY_REFERENCE_MAX_BYTES = 768;
const SESSION_REPLY_REFERENCE_PREFIX = 'pie-reply:v1:';

export interface SessionControlSenderIdentity {
  sessionId: string;
  identityFallback: boolean;
}

/** Coordinator-authenticated sender carried with an agent-to-agent message. */
export interface SessionControlMessage {
  sentAt: number;
  deliveredAt?: number;
  expectReply: boolean;
  kind?: 'completion';
}

export interface SessionControlSender {
  identity: SessionControlSenderIdentity;
  /** Assigned title from the coordinator title authority; absent while unnamed. */
  title?: string;
  /** Bounded identity-only reply address. It is not a secret or an operation token. */
  replyReference: string;
  message?: SessionControlMessage;
}

function boundedUtf8(value: string, maxBytes: number): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function isIdentity(value: unknown): value is SessionControlSenderIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return Object.keys(identity).length === 2
    && typeof identity.sessionId === 'string'
    && boundedUtf8(identity.sessionId, SESSION_ID_MAX_BYTES)
    && typeof identity.identityFallback === 'boolean';
}

/** Encode only the stable session identity. Membership and liveness are always
 * re-resolved by the coordinator when this reference is used. */
export function createSessionReplyReference(identity: SessionControlSenderIdentity): string {
  if (!isIdentity(identity)) throw new Error('Cannot create a reply reference from an invalid session identity.');
  const encodedIdentity = Buffer.from(
    JSON.stringify([identity.sessionId, identity.identityFallback]),
    'utf8',
  ).toString('base64url');
  const reference = `${SESSION_REPLY_REFERENCE_PREFIX}${encodedIdentity}`;
  if (Buffer.byteLength(reference, 'utf8') > SESSION_REPLY_REFERENCE_MAX_BYTES) {
    throw new Error('The session identity is too large for a bounded reply reference.');
  }
  return reference;
}

/** Build sender attribution from coordinator-resolved identity and title data. */
export function createSessionControlSender(
  identity: SessionControlSenderIdentity,
  assignedTitle?: string,
  message?: SessionControlMessage,
): SessionControlSender {
  const title = assignedTitle?.trim();
  if (assignedTitle !== undefined && (!title || !boundedUtf8(title, TITLE_MAX_BYTES))) {
    throw new Error('The assigned session title is invalid for sender attribution.');
  }
  return {
    identity: { sessionId: identity.sessionId, identityFallback: identity.identityFallback },
    ...(title ? { title } : {}),
    replyReference: createSessionReplyReference(identity),
    ...(message ? { message } : {}),
  };
}

/** Decode a reference for live-membership resolution. Invalid, noncanonical,
 * oversized, or unsupported references are unavailable rather than guessed. */
export function parseSessionReplyReference(value: unknown): SessionControlSenderIdentity | undefined {
  if (typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') > SESSION_REPLY_REFERENCE_MAX_BYTES
      || !value.startsWith(SESSION_REPLY_REFERENCE_PREFIX)) return undefined;
  const encodedIdentity = value.slice(SESSION_REPLY_REFERENCE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encodedIdentity)) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(encodedIdentity, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2
        || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'boolean') return undefined;
    const identity = { sessionId: parsed[0], identityFallback: parsed[1] };
    if (!isIdentity(identity) || createSessionReplyReference(identity) !== value) return undefined;
    return identity;
  } catch {
    return undefined;
  }
}

/** Validate durable or transport attribution before it reaches a transcript row. */
export function isSessionControlSender(value: unknown): value is SessionControlSender {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const sender = value as Record<string, unknown>;
  if (Object.keys(sender).some((key) => key !== 'identity' && key !== 'title' && key !== 'replyReference' && key !== 'message')) return false;
  if (!isIdentity(sender.identity) || typeof sender.replyReference !== 'string'
      || sender.replyReference !== createSessionReplyReference(sender.identity)) return false;
  if (sender.title !== undefined
      && (typeof sender.title !== 'string' || !boundedUtf8(sender.title, TITLE_MAX_BYTES))) return false;
  if (sender.message !== undefined) {
    const m = sender.message as Record<string, unknown>;
    if (!m || typeof m !== 'object' || Array.isArray(m)
        || Object.keys(m).some((key) => !['sentAt', 'deliveredAt', 'expectReply', 'kind'].includes(key))
        || !validTimestamp(m.sentAt) || (m.deliveredAt !== undefined && !validTimestamp(m.deliveredAt))
        || typeof m.expectReply !== 'boolean'
        || (m.kind !== undefined && m.kind !== 'completion')
        || (m.kind === 'completion' && m.expectReply)) return false;
  }
  return true;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function stampSessionControlDelivery(sender: SessionControlSender, deliveredAt: number): SessionControlSender {
  if (!isSessionControlSender(sender) || !validTimestamp(deliveredAt)) throw new Error('Invalid delivery attribution.');
  if (!sender.message || sender.message.deliveredAt !== undefined) return sender;
  return { ...sender, message: { ...sender.message, deliveredAt } };
}

/** Return the exact display-removable prefix for validated coordinator sender metadata.
 * A transcript may remove this prefix only when the persisted sender validates. */
export function sessionControlPromptPrefix(sender: unknown): string | undefined {
  if (!isSessionControlSender(sender)) return undefined;
  const sourceIdentity = JSON.stringify(sender.identity.sessionId);
  const identityQualifier = sender.identity.identityFallback ? ' (identity fallback)' : '';
  const sourceTitle = sender.title
    ? `; assigned title: ${JSON.stringify(sender.title)}`
    : '; unnamed session';
  if (sender.message) {
    const m = sender.message;
    return `[Pie cross-session sender identity: ${sourceIdentity}${identityQualifier}${sourceTitle}. Reply reference: ${sender.replyReference}. Sent at: ${m.sentAt}; delivered at: ${m.deliveredAt ?? 'pending'}; expectReply: ${m.expectReply}${m.kind ? `; kind: ${m.kind}` : ''}.]\n\n`;
  }
  return `[Pie cross-session sender identity: ${sourceIdentity}${identityQualifier}${sourceTitle}. Reply reference: ${sender.replyReference}. Use this exact reference as message.replyTo if replying.]\n\n`;
}

/** Embed coordinator-authenticated sender context in the durable model input.
 * The caller's message body is never inspected for or used to derive identity. */
export function formatSessionControlPrompt(text: string, sender: SessionControlSender): string {
  const prefix = sessionControlPromptPrefix(sender);
  if (!prefix) throw new Error('Cannot format a message with invalid sender attribution.');
  return `${prefix}${text}${sessionControlPromptSuffix(sender) ?? ''}`;
}

export function sessionControlPromptSuffix(sender: unknown): string | undefined {
  if (!isSessionControlSender(sender) || !sender.message) return undefined;
  const guidance = sender.message.kind === 'completion'
    ? 'Informational completion; no acknowledgement requested.'
    : sender.message.expectReply
      ? `If this is your delegated creator task, your final outcome is handed back automatically; do not also send the final via session_control. Otherwise reply using session_control with {"action":"message","replyTo":${JSON.stringify(sender.replyReference)},"expectReply":false,"prompt":"your reply"}. Ordinary assistant output is not delivered for other cross-session requests.`
      : 'No acknowledgement requested for this message; it does not cancel an outstanding task or completion handoff.';
  return `\n\n[Pie cross-session reply guidance: ${guidance}]`;
}

/** Exact authenticated envelope removal, never inferred from body text. */
export function stripSessionControlPrompt(text: string, sender: unknown): string | undefined {
  const prefix = sessionControlPromptPrefix(sender);
  const suffix = sessionControlPromptSuffix(sender) ?? '';
  if (!prefix || !text.startsWith(prefix) || (suffix && !text.endsWith(suffix))
      || text.length < prefix.length + suffix.length) return undefined;
  return text.slice(prefix.length, suffix ? -suffix.length : undefined);
}
