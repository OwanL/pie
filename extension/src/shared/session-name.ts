export const NEW_SESSION_NAME = 'New Session';
export const MAX_SESSION_NAME_LENGTH = 40;

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
  const name = normalized.length <= MAX_SESSION_NAME_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_SESSION_NAME_LENGTH - 1).trimEnd()}…`;
  return { name, isPlaceholder: true };
}
