/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useState } from 'preact/hooks';
import type { ChatPrefs } from '../../../shared/protocol';
import type { OnSetPrefs } from './settings-menu-types';

/** Settings section for the warm-bash bash-tool accelerator.
 *
 *  Mirrors `bashWarmPoolSize` / `bashFastPath` / `bashShellPath` prefs →
 *  PIE_BASH_WARM_POOL / PIE_BASH_FAST_PATH / PIE_SHELL env (see
 *  handleRuntimePrefsSet). `bashWarmPoolSize` is the IDLE TARGET for the
 *  single shared warm pool — the process keeps that many bash processes warm
 *  across ALL sessions (not per session) and dynamically kills/spawns to hit
 *  it. Changes take effect on the next bash call (live-tuned, no restart). */
export function BashSection({ prefs, onSetPrefs }: { prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  const fastPathChecked = prefs.bashFastPath;
  // Keep a local draft of the shell-path text field and commit on blur / Enter so
  // typing doesn't fire a host round-trip (and a persisted write) per keystroke.
  const [shellDraft, setShellDraft] = useState(prefs.bashShellPath);
  useEffect(() => { setShellDraft(prefs.bashShellPath); }, [prefs.bashShellPath]);
  const commitShell = () => {
    if (shellDraft !== prefs.bashShellPath) onSetPrefs({ bashShellPath: shellDraft });
  };
  return (
    <div class="toolbar-settings-ext-settings">
      <div class="toolbar-settings-list">
        {/* Idle target (shared warm pool) */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Idle target</span>
            <span class="toolbar-settings-ui-control-value">
              {prefs.bashWarmPoolSize === 0 ? 'Off' : prefs.bashWarmPoolSize}
            </span>
          </div>
          <input
            type="range"
            class="toolbar-settings-slider toolbar-settings-ui-slider"
            min="0"
            max="8"
            step="1"
            value={prefs.bashWarmPoolSize}
            onInput={(e) => onSetPrefs({ bashWarmPoolSize: Number((e.target as HTMLInputElement).value) })}
            aria-label="Warm bash idle target"
          />
          <div class="toolbar-settings-item-hint">
            Idle bash processes kept warm across ALL sessions (shared pool) to hide shell-spawn latency. Dynamically spawns up to the target and kills excess when lowered. 0 = off (today's fresh-spawn behaviour).
          </div>
        </div>

        {/* Fast path toggle */}
        <button
          class={`toolbar-settings-item${fastPathChecked ? ' checked' : ''}`}
          type="button"
          role="checkbox"
          aria-checked={fastPathChecked}
          onClick={() => onSetPrefs({ bashFastPath: !prefs.bashFastPath })}
        >
          <span class="toolbar-settings-item-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={fastPathChecked ? '' : 'opacity:0'}>
              <polyline points="2.5,6.5 5,9 10.5,3.5" />
            </svg>
          </span>
          <span class="toolbar-settings-item-label">Fast path (no shell for simple commands)</span>
        </button>

        {/* Shell path */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Shell path</span>
          </div>
          <input
            type="text"
            class="toolbar-settings-select"
            placeholder="auto-detect (Git Bash / bash)"
            value={shellDraft}
            onInput={(e) => setShellDraft((e.target as HTMLInputElement).value)}
            onBlur={commitShell}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
            aria-label="Explicit bash shell path"
            spellcheck={false}
          />
          <div class="toolbar-settings-item-hint">
            Leave blank to auto-detect. Used by both the warm pool and the fallback.
          </div>
        </div>

        {/* Warmup timeout */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Warmup timeout</span>
            <span class="toolbar-settings-ui-control-value">
              {prefs.bashWarmupTimeoutMs === 0 ? 'default' : `${Math.round(prefs.bashWarmupTimeoutMs / 1000)}s`}
            </span>
          </div>
          <input
            type="range"
            class="toolbar-settings-slider toolbar-settings-ui-slider"
            min="0"
            max="60"
            step="1"
            value={Math.round(prefs.bashWarmupTimeoutMs / 1000)}
            onInput={(e) => onSetPrefs({ bashWarmupTimeoutMs: Number((e.target as HTMLInputElement).value) * 1000 })}
            aria-label="Warm bash warmup timeout"
          />
          <div class="toolbar-settings-item-hint">
            How long to wait for a bash process to be ready before falling back. 0 = default (10s). Useful on slow shells / WSL.
          </div>
        </div>

        {/* Acquire timeout */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Acquire timeout</span>
            <span class="toolbar-settings-ui-control-value">
              {prefs.bashAcquireTimeoutMs === 0 ? 'default' : `${Math.round(prefs.bashAcquireTimeoutMs / 1000)}s`}
            </span>
          </div>
          <input
            type="range"
            class="toolbar-settings-slider toolbar-settings-ui-slider"
            min="0"
            max="60"
            step="1"
            value={Math.round(prefs.bashAcquireTimeoutMs / 1000)}
            onInput={(e) => onSetPrefs({ bashAcquireTimeoutMs: Number((e.target as HTMLInputElement).value) * 1000 })}
            aria-label="Warm bash acquire timeout"
          />
          <div class="toolbar-settings-item-hint">
            How long to wait for a warm worker when the pool is empty before falling back to a fresh spawn. 0 = default (15s).
          </div>
        </div>
      </div>
    </div>
  );
}