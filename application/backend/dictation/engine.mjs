// Sample-clock endpointing: independent of decoding speed and wall-clock stalls.
export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 512;
export const MAX_SAMPLES = 120 * SAMPLE_RATE;
/** Normalized RMS, without gain: zero is silence and full-scale DC is one. */
export function audioLevel(samples) {
  let squares = 0;
  for (const sample of samples) squares += sample * sample;
  const rms = Math.sqrt(squares / samples.length);
  return Number.isFinite(rms) ? Math.min(1, Math.max(0, rms)) : 0;
}
export class Endpoint {
  samples = 0;
  speechSamples = 0;
  lastSpeech = 0;
  admitted = false;
  accept(probability, count = FRAME_SAMPLES) {
    this.samples += count;
    if (probability >= 0.5) {
      this.speechSamples += count;
      this.lastSpeech = this.samples;
      if (this.speechSamples >= SAMPLE_RATE / 4) this.admitted = true;
    } else if (!this.admitted) this.speechSamples = 0;
    if (this.samples >= MAX_SAMPLES) return 'maximum';
    if (this.admitted && this.samples - this.lastSpeech >= 10 * SAMPLE_RATE) return 'silence';
    if (!this.admitted && this.samples >= 15 * SAMPLE_RATE) return 'initial-silence';
    return null;
  }
}
export function safeHypothesis(text) {
  if (typeof text !== 'string' || text.length > 32768) return null;
  // Reject only pathological consecutive repetitions, not legitimate revisions.
  const words = text.trim().split(/\s+/);
  let run = 0, previous = '';
  for (const word of words) {
    const key = word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    run = key && key === previous ? run + 1 : 1;
    previous = key;
    if (run >= 12) return null;
  }
  return text.trim();
}
/** Latest-only serial scheduler. flush drops previews and waits for native work. */
export class PreviewQueue {
  active = null;
  pending = null;
  closed = false;
  constructor(run) { this.run = run; }
  offer(value) {
    if (this.closed) return;
    this.pending = value;
    if (!this.active) this.active = this.drain();
  }
  async drain() {
    try {
      while (!this.closed && this.pending !== null) {
        const value = this.pending;
        this.pending = null;
        await this.run(value);
      }
    } finally { this.active = null; }
  }
  async flush() { this.closed = true; this.pending = null; await this.active; }
}
