import type { ChatMessage, LazyDetailRef, ToolCall } from '../../agent-processes/lib/rpc/message-contract.js';

const CUSTOM_TYPE = 'pie.tool-model-exchange';

export interface CapturedModelExchangeEntry {
  readonly customType: typeof CUSTOM_TYPE;
  readonly durableEntryId?: string;
  readonly assistantEntryId?: string;
  readonly data: {
    readonly version: 1;
    readonly toolCallId: string;
    readonly produced?: { name: string; arguments: unknown };
    readonly received?: unknown[];
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Project occurrence identities and capture payloads; never retain branch messages. */
export function captureModelExchangeEntries(entries: readonly unknown[]): readonly CapturedModelExchangeEntry[] {
  type Occurrence = {
    toolCallId: string; assistantIndex: number; assistantEntryId?: string; resultIndex?: number; durableEntryId?: string;
    ambiguous: boolean; produced?: { name: string; arguments: unknown }; received?: unknown[];
  };
  const occurrences: Occurrence[] = [];
  const latest = new Map<string, Occurrence>();
  const assistants: { index: number; occurrences: Occurrence[] }[] = [];
  entries.forEach((value, index) => {
    const entry = record(value);
    const message = record(entry?.message);
    if (entry?.type !== 'message') return;
    if (message?.role === 'assistant') {
      const current: Occurrence[] = [];
      for (const value of Array.isArray(message.content) ? message.content : []) {
        const block = record(value);
        if (block?.type !== 'toolCall' || typeof block.id !== 'string') continue;
        const duplicate = current.find((item) => item.toolCallId === block.id);
        if (duplicate) { duplicate.ambiguous = true; continue; }
        const occurrence: Occurrence = { toolCallId: block.id, assistantIndex: index, assistantEntryId: typeof entry.id === 'string' ? entry.id : undefined, ambiguous: false };
        current.push(occurrence);
        occurrences.push(occurrence);
        latest.set(block.id, occurrence);
      }
      assistants.push({ index, occurrences: current });
    } else if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      const occurrence = latest.get(message.toolCallId);
      if (!occurrence) return;
      if (occurrence.resultIndex !== undefined || typeof entry.id !== 'string') occurrence.ambiguous = true;
      occurrence.resultIndex = index;
      occurrence.durableEntryId = typeof entry.id === 'string' ? entry.id : undefined;
    }
  });
  entries.forEach((value, index) => {
    const entry = record(value);
    const data = record(entry?.data);
    if (entry?.type !== 'custom' || entry.customType !== CUSTOM_TYPE
      || data?.version !== 1 || typeof data.toolCallId !== 'string') return;
    const produced = record(data.produced);
    if (produced && typeof produced.name === 'string' && Object.hasOwn(produced, 'arguments')) {
      // SDK appends produced immediately before the durable assistant response.
      const occurrence = assistants.find((item) => item.index > index)?.occurrences
        .find((item) => item.toolCallId === data.toolCallId);
      if (occurrence) {
        if (occurrence.produced !== undefined) occurrence.ambiguous = true;
        occurrence.produced = { name: produced.name, arguments: produced.arguments };
      }
    }
    if (Array.isArray(data.received)) {
      // Received is appended after the result, before the next assistant response.
      const occurrence = occurrences.filter((item) => item.toolCallId === data.toolCallId && item.assistantIndex < index).at(-1);
      if (occurrence?.resultIndex !== undefined && occurrence.resultIndex < index && occurrence.received === undefined) {
        occurrence.received = data.received;
      }
    }
  });
  return occurrences.map((item) => ({
    customType: CUSTOM_TYPE,
    ...(item.durableEntryId && !item.ambiguous ? { durableEntryId: item.durableEntryId } : {}),
    ...(item.assistantEntryId && !item.ambiguous ? { assistantEntryId: item.assistantEntryId } : {}),
    data: {
      version: 1, toolCallId: item.toolCallId,
      ...(item.produced !== undefined ? { produced: item.produced } : {}),
      ...(item.received !== undefined ? { received: item.received } : {}),
    },
  }));
}

export function modelExchangeRef(sessionPath: string, tool: ToolCall): LazyDetailRef {
  const messageId = tool.durableEntryId ?? tool.id;
  return {
    key: JSON.stringify(['model-exchange', sessionPath, messageId, tool.id]),
    kind: 'model-exchange', source: 'durable', sessionPath, messageId,
    toolCallId: tool.id, sizeBytes: 0, summary: 'Captured model exchange', available: true,
  };
}

/** The transcript supplies identity only. Display inputs/results are never evidence. */
export function findToolModelExchange(
  transcript: readonly ChatMessage[],
  entries: readonly CapturedModelExchangeEntry[],
  ref: LazyDetailRef,
): { status: 'loaded'; value: { produced?: { name: string; arguments: unknown }; received?: unknown[] }; sizeBytes: number }
  | { status: 'unavailable'; message: string } {
  const unavailable = { status: 'unavailable' as const, message: 'No captured model exchange is available for this tool on the active branch.' };
  const tools = transcript.flatMap((message) =>
    message.parts?.flatMap((part) => part.kind === 'toolCall' ? [part.toolCall] : []) ?? message.toolCalls ?? []);
  if (ref.kind !== 'model-exchange' || ref.source !== 'durable' || !ref.toolCallId
    || !tools.some((tool) => tool.id === ref.toolCallId && (tool.durableEntryId ?? tool.id) === ref.messageId)
    || (ref.messageId === ref.toolCallId && tools.filter((tool) => tool.id === ref.toolCallId).length !== 1)) return unavailable;
  const matching = entries.filter((entry) => entry.data.toolCallId === ref.toolCallId);
  const exact = matching.filter((entry) => entry.durableEntryId === ref.messageId);
  const occurrence = ref.messageId === ref.toolCallId
    ? (matching.length === 1 && (matching[0].durableEntryId || matching[0].assistantEntryId) ? matching[0] : undefined)
    : (exact.length === 1 ? exact[0] : undefined);
  if (!occurrence) return unavailable;
  const { produced, received } = occurrence.data;
  if (produced === undefined && received === undefined) return unavailable;
  const value = { ...(produced !== undefined ? { produced } : {}), ...(received !== undefined ? { received } : {}) };
  return { status: 'loaded', value, sizeBytes: Buffer.byteLength(JSON.stringify(value), 'utf8') };
}
