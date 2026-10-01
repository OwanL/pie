export const NEW_SESSION_NAME = 'New Session';
/**
 * Base-title budget shared with the coordinator title authority: a newly
 * assigned name is at most 25 characters after trimming, and automatic
 * collision suffixes are additional. This bound covers the provisional
 * first-prompt snippet so it can never consume an assigned title's base
 * allowance; existing assigned titles are never bulk-shortened.
 */
export const MAX_SESSION_NAME_SNIPPET_LENGTH = 25;

export interface DerivedSessionName {
  name: string;
  /** True until a durable explicit/LLM title has been written. A prompt
   * snippet is meaningful fallback text, but it is still replaceable. */
  isPlaceholder: boolean;
}

/**
 * Build the immediate fallback shown before async title generation completes.
 * This deliberately performs no semantic extraction: it is a normalized,
 * bounded snippet of the first user prompt and remains replaceable.
 */
export function deriveSessionNameFromText(text: string | null | undefined): DerivedSessionName {
  const normalized = text?.replace(/\s+/g, ' ').trim() ?? '';
  if (!normalized) return { name: NEW_SESSION_NAME, isPlaceholder: true };
  const name = normalized.length <= MAX_SESSION_NAME_SNIPPET_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SESSION_NAME_SNIPPET_LENGTH - 1).trimEnd()}…`;
  return { name, isPlaceholder: true };
}
