/**
 * Shared AudioContext that persists across calls so that the autoplay
 * policy doesn't block sound triggered from non-user-gesture contexts
 * (e.g. a postMessage handler). Once warmed from a user click (Test
 * button or any interaction), subsequent plays work from any context,
 * including when the VS Code window is minimized.
 */
let sharedCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (sharedCtx && sharedCtx.state !== 'closed') {
    return sharedCtx;
  }
  sharedCtx = new AudioContext();
  return sharedCtx;
}

/**
 * Warm up the AudioContext during a user gesture so it enters the
 * 'running' state. Call this from any click handler (e.g. the Test
 * button). Subsequent calls to playCompletionSound from non-gesture
 * contexts (postMessage) will reuse the already-running context.
 */
export function warmupCompletionSoundContext(): void {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    void ctx.resume();
  }
}

/**
 * Plays a completion notification sound using the Web Audio API.
 * Synthesizes a pleasant two-tone chime.
 * @param volume 0–100 (0 = silent / off, 100 = full volume)
 */
export function playCompletionSound(volume: number): void {
  if (volume <= 0) return;

  const ctx = getAudioContext();

  const play = () => {
    const normalizedVolume = Math.min(100, Math.max(1, volume)) / 100;

    // First tone — a soft "ding"
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(880, ctx.currentTime); // A5
    gain1.gain.setValueAtTime(normalizedVolume * 0.4, ctx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.3);

    // Second tone — slightly higher, delayed
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.15); // D6
    gain2.gain.setValueAtTime(0.001, ctx.currentTime);
    gain2.gain.setValueAtTime(normalizedVolume * 0.3, ctx.currentTime + 0.15);
    gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(ctx.currentTime + 0.15);
    osc2.stop(ctx.currentTime + 0.5);
  };

  if (ctx.state === 'suspended') {
    void ctx.resume().then(play).catch(() => {
      // AudioContext.resume() may reject under autoplay policies; non-fatal.
    });
  } else {
    play();
  }
}
