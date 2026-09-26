import type { ChatMessage, SystemPromptEntry } from '../../lib/protocol/index.js';

interface TranscriptHydrationState {
  transcript: readonly ChatMessage[];
  systemPrompts: readonly SystemPromptEntry[];
  transcriptLoaded: boolean;
}

/**
 * Newly opened sessions hydrate their transcript rows and system prompt cards
 * asynchronously. Until either arrives, keep the transcript surface quiet and
 * render a lightweight loader instead of onboarding copy.
 */
export function isTranscriptHydrating({ transcript, systemPrompts, transcriptLoaded }: TranscriptHydrationState): boolean {
  return !transcriptLoaded && transcript.length === 0 && systemPrompts.length === 0;
}
