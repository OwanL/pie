export const TRANSCRIPT_SCROLLBAR_INTERACTION_START_EVENT = 'pie:transcript-scrollbar-interaction-start';
export const TRANSCRIPT_SCROLLBAR_INTERACTION_END_EVENT = 'pie:transcript-scrollbar-interaction-end';

export function dispatchTranscriptScrollbarInteractionStart(element: HTMLElement): void {
  element.dispatchEvent(new Event(TRANSCRIPT_SCROLLBAR_INTERACTION_START_EVENT));
}

export function dispatchTranscriptScrollbarInteractionEnd(element: HTMLElement): void {
  element.dispatchEvent(new Event(TRANSCRIPT_SCROLLBAR_INTERACTION_END_EVENT));
}
