import { createHash } from 'node:crypto';

export const INITIAL_CONTEXT_COHORT_VERSION = 'request-prefix-v1';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

/** Exact full-catalog identity. Only the digest may leave the worker. */
export function initialContextCohortKey(
  systemPrompt: string,
  tools: readonly unknown[],
  model: { provider: string; id: string },
  pruning: unknown,
): string {
  // Only the final SDK footer's date is volatile. Project/custom dates and
  // the working directory remain part of the prompt identity.
  const stablePrompt = systemPrompt.replace(
    /\nCurrent date: \d{4}-\d{2}-\d{2}(\nCurrent working directory: [^\n]*\n?)$/,
    '\nCurrent date: <date>$1',
  );
  const providerTools = tools.map((tool) => {
    const { name, description, parameters } = tool as { name?: unknown; description?: unknown; parameters?: unknown };
    return { name, description, parameters };
  });
  const payload = canonical({ version: INITIAL_CONTEXT_COHORT_VERSION, systemPrompt: stablePrompt, tools: providerTools,
    model: { provider: model.provider, id: model.id }, pruning });
  return `${INITIAL_CONTEXT_COHORT_VERSION}:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}
