/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect } from 'preact/hooks';
import { warmupCompletionSoundContext } from './completion-sound';

export function useWarmupAudio() {
  // Unlock notification audio in each client from a user gesture. Browser
  // autoplay policy still applies even when the host requests a sound.
  useEffect(() => {
    const warmup = () => {
      warmupCompletionSoundContext();
    };
    document.addEventListener('click', warmup, true);
    document.addEventListener('keydown', warmup, true);
    return () => {
      document.removeEventListener('click', warmup, true);
      document.removeEventListener('keydown', warmup, true);
    };
  }, []);
}
