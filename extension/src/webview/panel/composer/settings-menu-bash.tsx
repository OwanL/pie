/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useState } from 'preact/hooks';
import type { ChatPrefs } from '../../../shared/protocol';
import { SettingCheckbox } from '../components/setting-checkbox';
import { SliderRow } from '../components/slider-row';
import type { OnSetPrefs } from './settings-menu-types';

export const BASH_SETTING_LABELS = [
  'Idle target',
  'Fast path (no shell for simple commands)',
  'Shell path',
  'Warmup timeout',
] as const;

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
        <SliderRow
          label="Idle target"
          value={prefs.bashWarmPoolSize}
          min={0}
          max={8}
          step={1}
          formatValue={(v) => (v === 0 ? 'Off' : String(v))}
          ariaLabel="Warm bash idle target"
          hint="Idle bash processes kept warm across ALL sessions (shared pool) to hide shell-spawn latency. Dynamically spawns up to the target and kills excess when lowered. 0 = off (today's fresh-spawn behaviour)."
          onChange={(bashWarmPoolSize) => onSetPrefs({ bashWarmPoolSize })}
        />

        {/* Fast path toggle */}
        <SettingCheckbox
          label="Fast path (no shell for simple commands)"
          checked={fastPathChecked}
          onChange={() => onSetPrefs({ bashFastPath: !prefs.bashFastPath })}
        />

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
        <SliderRow
          label="Warmup timeout"
          value={Math.round(prefs.bashWarmupTimeoutMs / 1000)}
          min={0}
          max={60}
          step={1}
          formatValue={(v) => (v === 0 ? 'default' : `${v}s`)}
          ariaLabel="Warm bash warmup timeout"
          hint="How long to wait for a bash process to be ready before falling back. 0 = default (10s). Useful on slow shells / WSL."
          onChange={(seconds) => onSetPrefs({ bashWarmupTimeoutMs: seconds * 1000 })}
        />

      </div>
    </div>
  );
}