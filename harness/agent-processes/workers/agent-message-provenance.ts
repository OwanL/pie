import * as fs from 'node:fs';

import { isAgentSessionMessageLocalId } from '../lib/rpc/message-contract.js';
import { sessionControlPromptPrefix, formatSessionControlPrompt, stripSessionControlPrompt, stampSessionControlDelivery, isSessionControlSender } from '../lib/rpc/session-control-attribution.js';
import type { SessionContext } from '../coordinator/server-types.js';
import { FENCED_ENTRY_ID, type MutableSdkSessionManager } from '../../session-storage/ownership/session-manager-fence.js';

/** Pie-only data on the persisted user message. The SDK serializes the entire
 * message at appendMessage; its model input is the original, unmodified object.
 * Unlike a subsequent custom entry, this cannot be lost after user admission. */
export const AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY = 'pieAgentMessageProvenance';

export function attachAgentMessageProvenance(
  manager: MutableSdkSessionManager,
  currentContext: () => SessionContext | undefined,
  onFailure: (context: SessionContext, reason: 'fenced' | 'append_failed', error?: unknown) => void,
  isFenced: () => boolean = () => false,
): MutableSdkSessionManager {
  return new Proxy(manager, {
    get(target, key, receiver) {
      if (key !== 'appendMessage') return Reflect.get(target, key, receiver);
      return (message: unknown): string => {
        const context = currentContext();
        const active = context?.activeRequest;
        const record: Record<string, unknown> | undefined = message && typeof message === 'object' && !Array.isArray(message)
          ? message as Record<string, unknown> : undefined;
        const role = record?.role;
        if (role !== 'user' || !active || !isAgentSessionMessageLocalId(active.agentMessageLocalId)) {
          return target.appendMessage(message);
        }
        let sender = isSessionControlSender(active.coordinatorAttribution)
          ? active.coordinatorAttribution : undefined;
        if (sender?.message && sender.message.deliveredAt === undefined) {
          const stamped = stampSessionControlDelivery(sender, Date.now());
          const content = record!.content;
          if (typeof content === 'string') {
            const body = stripSessionControlPrompt(content, sender);
            if (body !== undefined) record!.content = formatSessionControlPrompt(body, stamped);
          } else if (Array.isArray(content)) {
            // The prefix may span adjacent text blocks. Replace only that
            // authenticated prefix, preserving body/image ordering and objects.
            const prefix = sessionControlPromptPrefix(sender)!;
            const leading: { text: string }[] = [];
            let joined = '';
            for (const part of content) {
              if (part?.type !== 'text' || typeof part.text !== 'string') break;
              leading.push(part);
              joined += part.text;
              if (joined.length >= prefix.length) break;
            }
            const allText = content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text).join('');
            if (joined.startsWith(prefix) && stripSessionControlPrompt(allText, sender) !== undefined) {
              let remaining = prefix.length;
              for (const [index, part] of leading.entries()) {
                const consumed = Math.min(remaining, part.text.length);
                remaining -= consumed;
                part.text = `${index === 0 ? sessionControlPromptPrefix(stamped)! : ''}${part.text.slice(consumed)}`;
              }
            }
          }
          sender = stamped;
          active.coordinatorAttribution = sender;
        }
        // Never copy caller-controlled provenance from a user message. The
        // coordinator-authenticated request is the only source of this field.
        const persisted = {
          ...record,
          [AGENT_MESSAGE_PERSISTED_PROVENANCE_KEY]: { ...(sender ? { sender } : {}) },
        };
        try {
          const entryId = target.appendMessage(persisted);
          if (entryId === FENCED_ENTRY_ID || !entryId) {
            onFailure(context!, entryId === FENCED_ENTRY_ID ? 'fenced' : 'append_failed');
          } else {
            active.agentMessageProvenanceEntryId = entryId;
            // The pinned SDK buffers a fresh session until its first assistant.
            // Persist the admitted user entry synchronously instead: waiting for
            // that assistant would turn message acceptance into answer completion
            // (and can deadlock a target waiting for its sender's tool result).
            if (typeof target.isPersisted !== 'function' || target.isPersisted() !== true
              || !target.getSessionFile?.() || isFenced()) {
              onFailure(context!, isFenced() ? 'fenced' : 'append_failed');
              return entryId;
            }
            if (target.flushed !== true) {
              target._rewriteFile();
              // A fenced/no-op or swallowed admission failure can return void.
              // Verify the actual user entry before enabling SDK append mode.
              const lines = fs.readFileSync(target.getSessionFile()!, 'utf8').trimEnd().split('\n');
              const last: unknown = JSON.parse(lines.at(-1) ?? 'null');
              if (!last || typeof last !== 'object' || (last as { id?: unknown }).id !== entryId) {
                onFailure(context!, 'append_failed');
                return entryId;
              }
              target.flushed = true;
            }
            if (!isFenced()) {
              active.agentMessageDurabilityConfirmed = true;
              active.agentMessageDurability?.settle(true);
            } else onFailure(context!, 'fenced');
          }
          return entryId;
        } catch (error) {
          onFailure(context!, isFenced() ? 'fenced' : 'append_failed', error);
          throw error;
        }
      };
    },
  });
}
