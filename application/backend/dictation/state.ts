import type { DictationView } from '../../lib/protocol/dictation.js';

export interface DictationState extends DictationView {
  capture: null | {
    corrId: string;
    rendererId: string;
    rendererGeneration: number;
    prefix: string;
    selectedText: string;
    suffix: string;
    expectedAppliedDraft: string;
    sequence: number;
    hadSpeech: boolean;
  };
}
export function createDictationState(): DictationState {
  return { available: false, phase: 'idle', recordingId: null, sessionPath: null,
    transcript: '', error: null, capture: null };
}
export function projectDictationView(state: DictationState): DictationView {
  const { capture, ...view } = state;
  return capture ? { ...view, ownerRendererId: capture.rendererId } : view;
}
