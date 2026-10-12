/** Shared notification AudioContext, unlocked by a user gesture in each client. */
let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (sharedCtx && sharedCtx.state !== 'closed') return sharedCtx;
  sharedCtx = new AudioContext();
  return sharedCtx;
}

/** Warm both notification sounds from a click or keyboard interaction. */
export function warmupCompletionSoundContext(): void {
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  } catch {
    // Audio is optional in clients without Web Audio support.
  }
}

function playChime(volume: number, firstFrequency: number, secondFrequency: number): void {
  if (!Number.isFinite(volume) || volume <= 0) return;
  try {
    const ctx = getAudioContext();
    const play = () => {
      const normalizedVolume = Math.min(100, volume) / 100;
      const start = ctx.currentTime;
      const first = ctx.createOscillator();
      const firstGain = ctx.createGain();
      first.type = 'sine';
      first.frequency.setValueAtTime(firstFrequency, start);
      firstGain.gain.setValueAtTime(normalizedVolume * 0.4, start);
      firstGain.gain.exponentialRampToValueAtTime(0.001, start + 0.3);
      first.connect(firstGain);
      firstGain.connect(ctx.destination);
      first.start(start);
      first.stop(start + 0.3);

      const second = ctx.createOscillator();
      const secondGain = ctx.createGain();
      second.type = 'sine';
      second.frequency.setValueAtTime(secondFrequency, start + 0.15);
      secondGain.gain.setValueAtTime(0.001, start);
      secondGain.gain.setValueAtTime(normalizedVolume * 0.3, start + 0.15);
      secondGain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      second.connect(secondGain);
      secondGain.connect(ctx.destination);
      second.start(start + 0.15);
      second.stop(start + 0.5);
    };
    if (ctx.state === 'suspended') {
      void ctx.resume().then(play).catch(() => undefined);
    } else {
      play();
    }
  } catch {
    // Unsupported Web Audio or autoplay restrictions must not disrupt host sync.
  }
}

/** Existing rising completion chime. Volume 0–100; 0 is silent. */
export function playCompletionSound(volume: number): void {
  playChime(volume, 880, 1174.66);
}

/** Distinct lower, descending chime for an agent question. */
export function playQuestionSound(volume: number): void {
  playChime(volume, 659.25, 523.25);
}
