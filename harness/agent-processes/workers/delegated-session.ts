import { createHash } from 'node:crypto';
import { readAgentCreatedSessionCreator } from '../../session-storage/metadata/session-provenance.js';
import type { SdkSessionManager } from '../lib/sdk-integration/sdk.js';
import type { ActiveRequest, SessionContext } from '../coordinator/server-types.js';
import type { DelegatedHandoff } from '../lib/rpc/session-events.js';
import { parseSessionReplyReference, type SessionControlSender } from '../lib/rpc/session-control-attribution.js';
import { FENCED_ENTRY_ID } from '../../session-storage/ownership/session-manager-fence.js';

export const DELEGATED_HANDOFF_CUSTOM_TYPE = 'pie.delegated-handoff-claim';
export const HANDOFF_TEXT_MAX_BYTES = 48 * 1024;
export const HANDOFF_INPUT_LIMIT = 256;
export interface DelegationState { request: ActiveRequest; inputIds: string[] }
const consumedByRequest = new WeakMap<ActiveRequest, Set<string>>();

export function delegatedRolePrompt(manager: Pick<SdkSessionManager, 'getSessionId' | 'getHeader' | 'getEntries'>): string {
  const creator = readAgentCreatedSessionCreator(manager);
  return creator ? `\n\n## Delegated primary session\nThis independent primary session was created by session ${creator.sessionId}. An authenticated assignment supplies its taskId and revision. Call session_finish once with the outcome, deliverable, evidence, verification, and blockers before ending that assignment. Results belong to the actual requester, whether your creator or another peer. Do not separately send the same final as a note. A plain note assigns no work and requests no acknowledgement. Ending a run without session_finish leaves its task awaiting-result; settlement does not prove task success. A human may steer this session directly; follow their steering without silently claiming the assigned task succeeded.\n` : '';
}

/** Called only after the durable, authenticated user delivery boundary. Never
 * reconstruct obligations from historical messages after restart. */
export function consumeDelegatedInput(context: SessionContext, inputId: string, sender: SessionControlSender): void {
  const active = context.activeRequest;
  if (sender.message?.expectReply !== true || sender.message.kind === 'completion') return;
  const creator = readAgentCreatedSessionCreator(context.session.sessionManager);
  if (!active || !creator || !inputId || inputId.length > 256
    || sender.identity.sessionId !== creator.sessionId
    || sender.identity.identityFallback !== creator.identityFallback) return;
  const manager = context.session.sessionManager;
  const childId = manager.getSessionId?.();
  if (manager.getEntries().some(entry => entry.type === 'custom' && entry.customType === DELEGATED_HANDOFF_CUSTOM_TYPE
    && (entry.data as {childSessionId?:unknown})?.childSessionId === childId
    && Array.isArray((entry.data as {inputIds?:unknown})?.inputIds)
    && ((entry.data as {inputIds:string[]}).inputIds).includes(inputId))) return;
  const consumed = consumedByRequest.get(active) ?? new Set<string>();
  if (consumed.has(inputId) || consumed.size >= HANDOFF_INPUT_LIMIT) return;
  consumed.add(inputId);
  consumedByRequest.set(active, consumed);
  if (context.delegation?.request !== active) context.delegation = { request: active, inputIds: [] };
  const ids = context.delegation.inputIds;
  if (!ids.includes(inputId) && ids.length < HANDOFF_INPUT_LIMIT) ids.push(inputId);
}

export function claimExplicitFulfillment(context: SessionContext | undefined, payload: Record<string, unknown>): void {
  if (payload.fulfills === undefined) return;
  const ids = payload.fulfills;
  const creator = context && readAgentCreatedSessionCreator(context.session.sessionManager);
  const recipient = parseSessionReplyReference(payload.replyTo);
  const state = context?.delegation;
  if (!context || !creator || !recipient || recipient.sessionId !== creator.sessionId
    || recipient.identityFallback !== creator.identityFallback || payload.expectReply !== false
    || !Array.isArray(ids) || !ids.length || ids.length > HANDOFF_INPUT_LIMIT
    || new Set(ids).size !== ids.length || !state || state.request !== context.activeRequest
    || !ids.every(id => typeof id === 'string' && state.inputIds.includes(id))) {
    throw new Error('fulfills requires outstanding delivered creator input IDs, creator replyTo, and expectReply:false.');
  }
  const remaining = state.inputIds.filter(id => !ids.includes(id));
  context.delegation = {request:state.request,inputIds:ids as string[]};
  try {
    const claim = claimDelegatedHandoff(context, state.request, 'Explicit final message attempt.');
    if (!claim) throw new Error('Explicit final handoff was already attempted.');
  } finally {
    context.delegation = {request:state.request,inputIds:remaining};
  }
}

export function boundHandoffText(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= HANDOFF_TEXT_MAX_BYTES) return text;
  // Decode without splitting a UTF-8 code point.
  let end = HANDOFF_TEXT_MAX_BYTES - 32;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0,end).toString('utf8')}\n[Final response truncated]`;
}

export function claimDelegatedHandoff(context: SessionContext, request: ActiveRequest | undefined, text: string,
  outcome: DelegatedHandoff['outcome'] = 'completed'): DelegatedHandoff | undefined {
  const state = context.delegation;
  if (!request || state?.request !== request || !state.inputIds.length) return undefined;
  // Remove before attempting persistence: unknown writes must never retry.
  context.delegation = undefined;
  const manager = context.session.sessionManager;
  const recipient = readAgentCreatedSessionCreator(manager);
  const childSessionId = manager.getSessionId?.();
  if (!recipient || !childSessionId) return undefined;
  const inputIds = [...state.inputIds];
  const id = createHash('sha256').update(JSON.stringify([childSessionId, recipient, inputIds])).digest('hex');
  if (manager.getEntries().some(entry => entry.type === 'custom' && entry.customType === DELEGATED_HANDOFF_CUSTOM_TYPE
    && (entry.data as {childSessionId?:unknown; id?:unknown})?.childSessionId === childSessionId
    && (entry.data as {id?:unknown})?.id === id)) return undefined;
  const handoff: DelegatedHandoff = { id, childSessionId, recipient, inputIds, outcome, text: boundHandoffText(text) };
  const writer = manager as SdkSessionManager & {appendCustomEntry?: (type: string, data: unknown) => string};
  if (!writer.appendCustomEntry) throw new Error('Delegated handoff claim persistence is unavailable.');
  const entryId = writer.appendCustomEntry(DELEGATED_HANDOFF_CUSTOM_TYPE, {version:1,...handoff});
  if (!entryId || entryId === FENCED_ENTRY_ID) throw new Error('Delegated handoff claim was fenced.');
  const claimed = manager.getEntries().some(entry => entry.type === 'custom' && entry.customType === DELEGATED_HANDOFF_CUSTOM_TYPE
    && (entry.data as {id?:unknown})?.id === id && (entry.data as {childSessionId?:unknown})?.childSessionId === childSessionId);
  if (!claimed) throw new Error('Delegated handoff claim could not be confirmed.');
  return handoff;
}
