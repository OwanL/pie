/** Local, user-initiated dictation. Audio never enters the renderer protocol. */
export type DictationPhase = 'idle' | 'preparing' | 'recording' | 'finalizing' | 'error';
export interface DictationView {
  available: boolean;
  phase: DictationPhase;
  recordingId: string | null;
  /** Only this renderer may control an active capture. Not an authorization token. */
  ownerRendererId?: string;
  sessionPath: string | null;
  transcript: string;
  error: string | null;
  detail?: string;
  /** Ephemeral normalized RMS in [0, 1]; never audio samples. */
  audioLevel?: number;
}
export type DictationObservation =
  | { kind: 'status'; phase: 'preparing' | 'recording' | 'finalizing'; detail?: string }
  | { kind: 'transcript'; text: string; final: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'level'; level: number };
export const DICTATION_SILENCE_MS = 10_000;
export const DICTATION_INITIAL_SILENCE_MS = 15_000;
export const DICTATION_MAX_DURATION_MS = 120_000;
export const DICTATION_PREVIEW_PERIOD_MS = 500;
/** Cheap renderer capability projection; command authorization remains host-side. */
export function dictationForRenderer(view: DictationView | undefined, rendererId: string, microphoneAllowed = true): DictationView | undefined {
  if (!view || !view.available) return view;
  return !microphoneAllowed || (view.ownerRendererId !== undefined && view.ownerRendererId !== rendererId)
    ? { ...view, available: false } : view;
}
export function dictationActive(view: DictationView | undefined): boolean {
  return view?.phase === 'preparing' || view?.phase === 'recording' || view?.phase === 'finalizing';
}
