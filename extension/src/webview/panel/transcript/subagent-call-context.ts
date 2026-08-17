/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext } from 'preact';
import type { LiveSubagentDetailAddress } from '../../../shared/protocol/subagent-detail';

/**
 * Context that carries the enclosing subagent's identity through nested
 * transcript rendering. When a nested ask_user tool call needs to find its
 * matching ExtensionUIRequestPayload, it reads `id` from this context to
 * match against `subagentCallId`.
 *
 * - `id` — the subagentCallId to match pending requests against. For a
 *   single-result subagent this is the bare tool-call id; for a multi-result
 *   (parallel/chain) subagent it is `${toolCallId}:${index}`, mirroring the
 *   stamping applied by the subagent extension's `ParentExtensionUIBridgeProxy`.
 * - `agent` — the subagent's name (e.g. "worker"), surfaced as a source label
 *   on ask_user prompts so the user knows who is asking.
 * - `depth` — nesting depth (1 = top-level subagent, 2 = subagent-of-subagent,
 *   …), shown on nested-subagent prompts to make the call stack legible.
 * - `detailRoot` — the immutable address root (session/turn/root tool call +
 *   root attempt) of the enclosing Phase 5 detail subscription. A nested
 *   live-addressable child combines it with its own complete producer lineage
 *   to derive the address it subscribes with. Absent for cards rendered from
 *   legacy (non-live-addressable) details.
 *
 * `undefined` means we're at the top level (main agent transcript) — no
 * enclosing subagent, so ask_user prompts render without a source label.
 */
export interface SubagentCallContextValue {
  id: string;
  agent: string;
  depth: number;
  detailRoot?: Pick<LiveSubagentDetailAddress, 'sessionPath' | 'turnId' | 'rootToolCallId' | 'rootAttemptId'>;
}

export const SubagentCallContext = createContext<SubagentCallContextValue | undefined>(undefined);
