import { isRecord } from '../type-guards';
import type { VerificationCommandKind } from '../../../../shared/tool-analysis-kinds.js';

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function extractCommandText(input: unknown): string | null {
  if (typeof input === 'string') {
    return input.trim() ? input : null;
  }

  if (!isRecord(input)) {
    return null;
  }

  const direct = [
    input.command,
    input.cmd,
    input.script,
  ];

  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate;
    }
  }

  if (Array.isArray(input.args) && input.args.every((arg) => typeof arg === 'string')) {
    const joined = input.args.join(' ').trim();
    return joined || null;
  }

  return null;
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .map((segment) => normalizeText(segment.toLowerCase()))
    .filter((segment) => segment.length > 0);
}

function classifyVerificationSegment(segment: string): VerificationCommandKind[] {
  const kinds = new Set<VerificationCommandKind>();

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.test(segment)
    || /\bvitest\b/.test(segment)
    || /\bjest\b/.test(segment)
    || /\bpytest\b/.test(segment)
    || /\bgo\s+test\b/.test(segment)
    || /\bcargo\s+test\b/.test(segment)
    || /\bdotnet\s+test\b/.test(segment)
    || /\bmvn(?:w)?\s+test\b/.test(segment)
    || /\bgradle(?:w)?\s+test\b/.test(segment)
    || /\bphpunit\b/.test(segment)
    || /\brspec\b/.test(segment)
  ) {
    kinds.add('test');
  }

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck\b/.test(segment)
    || (/\btsc\b/.test(segment) && /--no-?emit\b/.test(segment))
    || /\bpyright\b/.test(segment)
    || /\bmypy\b/.test(segment)
    || /\bsvelte-check\b/.test(segment)
    || /\bvue-tsc\b/.test(segment)
  ) {
    kinds.add('typecheck');
  }

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/.test(segment)
    || /\beslint\b/.test(segment)
    || /\bboxlint\b/.test(segment)
    || /\bstylelint\b/.test(segment)
    || /\bmarkdownlint\b/.test(segment)
    || /\bgolangci-lint\b/.test(segment)
    || /\bcargo\s+clippy\b/.test(segment)
    || /\bflake8\b/.test(segment)
    || /\bruff\s+check\b/.test(segment)
  ) {
    kinds.add('lint');
  }

  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(segment)
    || /\bvite\s+build\b/.test(segment)
    || /\bnext\s+build\b/.test(segment)
    || /\bnuxt\s+build\b/.test(segment)
    || /\bcargo\s+build\b/.test(segment)
    || /\bgo\s+build\b/.test(segment)
    || /\bdotnet\s+build\b/.test(segment)
    || /\bmvn(?:w)?\s+(?:package|install)\b/.test(segment)
    || /\bgradle(?:w)?\s+(?:build|assemble)\b/.test(segment)
    || /\bwebpack\b/.test(segment)
    || /\brollup\b/.test(segment)
    || (/\btsc\b/.test(segment) && !/--no-?emit\b/.test(segment))
  ) {
    kinds.add('build');
  }

  if (
    /\bprettier\b.*\b--check\b/.test(segment)
    || /\brustfmt\b.*\b--check\b/.test(segment)
    || /\bbiome\b.*\b(?:check|lint)\b/.test(segment)
    || /\bformat\b.*\b--check\b/.test(segment)
  ) {
    kinds.add('format');
  }

  if (
    kinds.size === 0 && (
      /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|verify|validate)\b/.test(segment)
      || /\bcargo\s+check\b/.test(segment)
      || /\bgradle(?:w)?\s+check\b/.test(segment)
      || /\bmvn(?:w)?\s+verify\b/.test(segment)
      || /\bcheck\b/.test(segment)
      || /\bverify\b/.test(segment)
      || /\bvalidate\b/.test(segment)
    )
  ) {
    kinds.add('other');
  }

  return [...kinds];
}

export function classifyVerificationCommandKindsFromInput(input: unknown): VerificationCommandKind[] {
  const command = extractCommandText(input);
  if (!command) {
    return [];
  }

  const kinds = new Set<VerificationCommandKind>();
  for (const segment of splitCommandSegments(command)) {
    for (const kind of classifyVerificationSegment(segment)) {
      kinds.add(kind);
    }
  }
  return [...kinds];
}

function extractFromTaskArray(
  entries: unknown[],
): {
  taskCount: number;
  agents: string[];
} {
  const agents = new Set<string>();
  let taskCount = 0;

  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    if (typeof entry.task === 'string' && entry.task.trim()) {
      taskCount += 1;
    }
    if (typeof entry.agent === 'string' && entry.agent.trim()) {
      agents.add(normalizeText(entry.agent));
    }
  }

  return { taskCount, agents: [...agents] };
}

function extractFromSingleTask(
  input: Record<string, unknown>,
): {
  taskCount: number;
  agents: string[];
} {
  const taskCount = typeof input.task === 'string' && input.task.trim() ? 1 : 0;
  const agents = typeof input.agent === 'string' && input.agent.trim()
    ? [normalizeText(input.agent)]
    : [];
  return { taskCount, agents };
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/**
 * Sum the per-result token usage (input/output/cacheRead/cacheWrite) carried on
 * the subagent tool call's raw `result`. The subagent extension accumulates
 * `usage` on each `SingleResult` and emits it on the result object (either
 * `{ results: [...] }` or `{ details: { results: [...] } }`). Returns zeros when
 * the result lacks usage (e.g. the subagent failed before producing any, or
 * predates the field) so the parent run can attribute subagent cost without
 * crashing on legacy data.
 */
function extractResultUsage(result: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  if (!isRecord(result)) {
    return empty;
  }
  const results = Array.isArray(result.results) ? result.results
    : isRecord(result.details) && Array.isArray(result.details.results) ? result.details.results
    : null;
  if (!Array.isArray(results)) {
    return empty;
  }
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  const seen = new Set<object>();
  const visit = (entries: unknown[], depth: number): void => {
    if (depth > 8) return;
    for (const entry of entries) {
      if (!isRecord(entry) || seen.has(entry)) continue;
      seen.add(entry);
      const usage = entry.usage;
      if (isRecord(usage)) {
        inputTokens += toNonNegativeInt(usage.input);
        outputTokens += toNonNegativeInt(usage.output);
        cacheReadTokens += toNonNegativeInt(usage.cacheRead);
        cacheWriteTokens += toNonNegativeInt(usage.cacheWrite);
      }
      if (!Array.isArray(entry.messages)) continue;
      for (const message of entry.messages) {
        if (!isRecord(message) || message.role !== 'toolResult' || message.toolName !== 'subagent') continue;
        if (isRecord(message.details) && Array.isArray(message.details.results)) {
          visit(message.details.results, depth + 1);
        }
      }
    }
  };
  visit(results, 0);
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

export function extractSubagentUsage(input: unknown, result?: unknown): {
  taskCount: number;
  agents: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
} {
  const empty = {
    taskCount: 0,
    agents: [] as string[],
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  if (!isRecord(input)) {
    return empty;
  }

  const taskEntries = Array.isArray(input.tasks) ? input.tasks
    : Array.isArray(input.chain) ? input.chain
    : null;

  const base = taskEntries
    ? extractFromTaskArray(taskEntries)
    : extractFromSingleTask(input);

  return { ...base, ...extractResultUsage(result) };
}
