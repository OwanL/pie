/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';

import type { ChatMessage } from '../../../lib/protocol/index.js';
import { AGENT_MESSAGE_CUSTOM_TYPE } from '../../../lib/protocol/messages.js';
import { AgentIcon } from '../../session-tabs/icons';
import {
  assistantReplyMeta,
  formatDuration,
  formatRequestTime,
  roleLabel,
} from '../header';
import { MessageHeader } from '../message-header';
import { PruningHeaderChip } from '../pruning-header';
import type { PruningHeaderState } from '../pruning';
import { StatusChip, type StatusTone } from '../status-chip';

interface MessageHeaderActionsProps {
  pruningHeaderState: PruningHeaderState | undefined;
  pruningExpanded: boolean;
  onTogglePruning: () => void;
  statusLabel: string | null;
  statusTone: StatusTone;
  onCancelPrepass?: () => void;
}

export function MessageHeaderActions({
  pruningHeaderState,
  pruningExpanded,
  onTogglePruning,
  statusLabel,
  statusTone,
  onCancelPrepass,
}: MessageHeaderActionsProps) {
  if (!pruningHeaderState && !statusLabel) return null;
  return (
    <>
      {pruningHeaderState && (
        <PruningHeaderChip
          state={pruningHeaderState}
          expanded={pruningExpanded}
          onToggle={onTogglePruning}
          onCancel={onCancelPrepass}
        />
      )}
      {statusLabel && <StatusChip tone={statusTone} label={statusLabel} />}
    </>
  );
}

interface MessageItemHeaderProps {
  role: ChatMessage['role'];
  isCurrentlyStreaming: boolean;
  durationMs: number | undefined;
  replyMeta: ReturnType<typeof assistantReplyMeta>;
  assistantMetaTooltip: string | null;
  requestCreatedAt?: string;
  actions: ComponentChildren;
  /** Host-side synthetic-send tag. Surfaces a label on the user bubble
   *  when the message is host-injected rather than typed. */
  customType?: string;
}

export function MessageItemHeader({
  role,
  isCurrentlyStreaming,
  durationMs,
  replyMeta,
  assistantMetaTooltip,
  requestCreatedAt,
  actions,
  customType,
}: MessageItemHeaderProps) {
  // Agent-originated session messages keep the user-role bubble but carry an
  // explicit bot cue. Other host-injected messages retain their Auto-resume tag.
  const userLabel = role !== 'user'
    ? null
    : customType === AGENT_MESSAGE_CUSTOM_TYPE
      ? <span class="inline-flex items-center gap-1"><AgentIcon compact />Agent</span>
      : customType !== undefined ? 'Auto-resume' : null;
  const requestTime = role === 'assistant' ? formatRequestTime(requestCreatedAt) : null;
  return (
    <MessageHeader
      label={role !== 'user' ? roleLabel(role) : userLabel}
      duration={role === 'assistant' && !isCurrentlyStreaming && durationMs !== undefined ? formatDuration(durationMs) : null}
      meta={replyMeta?.compactText ?? null}
      timestamp={requestTime?.compactText ?? null}
      timestampTitle={requestTime?.title}
      timestampDateTime={requestCreatedAt}
      title={assistantMetaTooltip ?? undefined}
      actions={actions}
      align={role === 'user' ? 'end' : 'start'}
      className={role === 'assistant' ? 'message-assistant-header' : undefined}
    />
  );
}
