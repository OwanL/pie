import { LIVE_PIPELINE_LIMITS, type SubagentChildPreview, type ToolPreview } from '../shared/live-pipeline-protocol.js';

const MAX_TAIL_CHARS = 8_192;
const MAX_SUMMARY_CHARS = 1_024;
const MAX_CHILDREN = 16;

export function normalizeToolProgress(toolName: string, value: unknown): ToolPreview {
  const normalizedName = toolName.trim().toLowerCase();
  if (normalizedName === 'subagent') return normalizeSubagent(value);
  if (normalizedName === 'ask_user') return normalizeQuestion(value);
  if (normalizedName === 'bash') return normalizeCommand(value);
  if (normalizedName === 'read' || normalizedName === 'write' || normalizedName === 'edit') {
    return normalizeText(value);
  }
  return normalizeGeneric(value);
}

function normalizeText(value: unknown): ToolPreview {
  const text = extractText(value) ?? safeSummary(value);
  const { tail, omittedChars } = boundedTail(text, MAX_TAIL_CHARS);
  return { kind: 'text', tail, omittedChars };
}

function normalizeCommand(value: unknown): ToolPreview {
  const record = asRecord(value);
  const command = stringField(record, ['command', 'commandSummary']) ?? 'Command running';
  const output = stringField(record, ['output', 'stdout', 'text', 'partialResult']);
  const boundedCommand = boundedHead(command, MAX_SUMMARY_CHARS);
  if (!output) {
    return { kind: 'command', commandSummary: boundedCommand, omittedChars: Math.max(0, command.length - boundedCommand.length) };
  }
  const bounded = boundedTail(output, MAX_TAIL_CHARS);
  return {
    kind: 'command',
    commandSummary: boundedCommand,
    outputTail: bounded.tail,
    omittedChars: Math.max(0, command.length - boundedCommand.length) + bounded.omittedChars,
  };
}

function normalizeSubagent(value: unknown): ToolPreview {
  const record = asRecord(value);
  const details = asRecord(record?.details);
  const rawChildren = Array.isArray(record?.children)
    ? record.children
    : Array.isArray(record?.results)
      ? record.results
      : Array.isArray(details?.results)
        ? details.results
        : Array.isArray(record?.details)
          ? record.details
          : [];
  const mode = normalizeSubagentMode(details?.mode ?? record?.mode);
  const visibleChildren = rawChildren.slice(0, MAX_CHILDREN);
  const textBudget = Math.max(512, Math.floor(12 * 1024 / Math.max(1, visibleChildren.length)));
  const taskBudget = Math.max(256, Math.floor(4 * 1024 / Math.max(1, visibleChildren.length)));
  const children: SubagentChildPreview[] = [];
  for (let index = 0; index < visibleChildren.length; index += 1) {
    const item = visibleChildren[index];
    const child = asRecord(item);
    if (!child) continue;
    const agent = boundedOptional(stringField(child, ['agent']), 256);
    const task = boundedOptional(stringField(child, ['task']), taskBudget);
    const id = stringField(child, ['id', 'childId', 'sessionId']) ?? agent ?? `child-${index + 1}`;
    const phase = normalizeChildPhase(stringField(child, ['activityPhase', 'phase', 'status']), numberField(child, 'exitCode'));
    const streamingText = boundedTailOptional(stringField(child, ['streamingText']), textBudget);
    const streamingReasoning = boundedTailOptional(stringField(child, ['streamingReasoning']), Math.max(256, Math.floor(textBudget / 2)));
    const summary = boundedOptional(
      stringField(child, ['summary', 'finalOutput', 'text', 'detail']) ?? latestAssistantText(child.messages),
      Math.max(256, Math.floor(textBudget / 2)),
    );
    children.push({
      id: boundedHead(id, 128),
      phase,
      agent,
      task,
      summary,
      exitCode: numberField(child, 'exitCode'),
      model: boundedOptional(stringField(child, ['model', 'selectedModel']), 256),
      provider: boundedOptional(stringField(child, ['provider']), 256),
      activityDetail: boundedOptional(stringField(child, ['activityDetail']), 256),
      activitySince: numberField(child, 'activitySince'),
      lastProgressAt: numberField(child, 'lastProgressAt'),
      inactivityBudgetMs: numberField(child, 'inactivityBudgetMs'),
      streaming: typeof child.streaming === 'boolean' ? child.streaming : undefined,
      streamingText,
      streamingReasoning,
      runningTools: Array.isArray(child.runningTools)
        ? child.runningTools.filter((tool): tool is string => typeof tool === 'string').slice(0, 20).map((tool) => boundedHead(tool, 128))
        : undefined,
    });
  }
  while (children.length > 1 && jsonBytes({ kind: 'subagent', mode, children, omittedChildren: rawChildren.length - children.length }) > LIVE_PIPELINE_LIMITS.previewBytes) {
    children.pop();
  }
  return { kind: 'subagent', mode, children, omittedChildren: Math.max(0, rawChildren.length - children.length) };
}

function normalizeSubagentMode(value: unknown): 'single' | 'parallel' | 'chain' {
  return value === 'parallel' || value === 'chain' ? value : 'single';
}

function normalizeQuestion(value: unknown): ToolPreview {
  const record = asRecord(value);
  const prompt = stringField(record, ['question', 'prompt', 'text']) ?? 'Waiting for input';
  const options = Array.isArray(record?.options) ? record.options.length : 0;
  return { kind: 'question', promptSummary: boundedHead(prompt, MAX_SUMMARY_CHARS), optionCount: options };
}

function normalizeGeneric(value: unknown): ToolPreview {
  return { kind: 'generic', summary: boundedHead(safeSummary(value), MAX_SUMMARY_CHARS) };
}

function normalizeChildPhase(value: string | undefined, exitCode?: number): SubagentChildPreview['phase'] {
  switch (value) {
    case 'queued': case 'running': case 'completed': case 'failed': case 'cancelled': return value;
    case 'error': return 'failed';
    case 'aborted': return 'cancelled';
    default: return exitCode === 0 ? 'completed' : typeof exitCode === 'number' && exitCode !== -1 ? 'failed' : 'running';
  }
}

function latestAssistantText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const message = asRecord(value[index]);
    if (message?.role !== 'assistant') continue;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .map((part) => {
        const record = asRecord(part);
        return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return undefined;
}

function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  return stringField(record, ['text', 'output', 'content', 'partialResult']);
}

function safeSummary(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'No progress detail';
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  const seen = new WeakSet<object>();
  try {
    const json = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function' || typeof item === 'symbol') return `[${typeof item}]`;
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    return json ?? Object.prototype.toString.call(value);
  } catch {
    return '[Unserializable progress]';
  }
}

function boundedTail(value: string, maxChars: number): { tail: string; omittedChars: number } {
  if (value.length <= maxChars) return { tail: value, omittedChars: 0 };
  return { tail: value.slice(-maxChars), omittedChars: value.length - maxChars };
}

function boundedHead(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function boundedOptional(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : boundedHead(value, maxChars);
}

function boundedTailOptional(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : boundedTail(value, maxChars).tail;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) if (typeof record[key] === 'string') return record[key];
  return undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] : undefined;
}

function jsonBytes(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8'); }
  catch { return Number.POSITIVE_INFINITY; }
}

/** Defensive protocol assertion used by the accumulator before publication. */
export function isBoundedToolPreview(preview: ToolPreview): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(preview), 'utf8') <= LIVE_PIPELINE_LIMITS.previewBytes;
  } catch {
    return false;
  }
}
