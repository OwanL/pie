/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect } from 'preact/hooks';
import { warmupCompletionSoundContext } from './completion-sound';

export function useWarmupAudio() {
  // Warm the AudioContext on the first user click so the completion sound
  // works even when triggered from a non-gesture postMessage handler.
  useEffect(() => {
    const warmup = () => {
      warmupCompletionSoundContext();
      document.removeEventListener('click', warmup, true);
    };
    document.addEventListener('click', warmup, true);
    return () => document.removeEventListener('click', warmup, true);
  }, []);
}
