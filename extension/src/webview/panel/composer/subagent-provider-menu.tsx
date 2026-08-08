/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ChatPrefs, ModelInfo } from '../../../shared/protocol';
import { useAnchoredOverlay } from '../components/anchored-overlay';
import { getSubagentBucketProviders, isSubagentProviderEnabled, setSubagentProviderEnabled } from '../chat-prefs';
import { Tooltip } from '../components/tooltip';
import { cx } from '../utils/cx';

interface Props {
  sessionPath: string | null;
  prefs: ChatPrefs;
  availableModels: ModelInfo[];
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
}

/** Per-session provider filter for models eligible through subagent buckets. */
export function SubagentProviderMenu({ sessionPath, prefs, availableModels, onSetPrefs }: Props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useAnchoredOverlay({
    open,
    triggerRef,
    overlayRef: menuRef,
    preferredDirection: 'up',
    preferredWidth: 260,
    minHeight: 110,
    maxHeight: 320,
  });

  const providers = useMemo(
    () => getSubagentBucketProviders(prefs, availableModels, sessionPath),
    [availableModels, prefs.subagentBuckets, prefs.subagentProviderDefaults, prefs.subagentProviderTogglesBySession, sessionPath],
  );
  const enabledCount = providers.filter((provider) => isSubagentProviderEnabled(prefs, provider, sessionPath)).length;
  const disabledCount = providers.length - enabledCount;

  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('mousedown', pointer);
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('mousedown', pointer); document.removeEventListener('keydown', keyboard); };
  }, [open]);

  if (!sessionPath || providers.length === 0) return null;

  const toggle = (provider: string) => {
    const currentlyEnabled = isSubagentProviderEnabled(prefs, provider, sessionPath);
    // Keep one route available. Turning subagents off entirely is controlled by
    // the nesting setting; an empty provider set could otherwise fall through
    // to an SDK default and defeat this cost-control surface.
    if (currentlyEnabled && enabledCount <= 1) return;
    onSetPrefs(setSubagentProviderEnabled(prefs, sessionPath, provider, !currentlyEnabled));
  };
  const keydown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); setOpen(true);
    }
  };

  const providerSummary = `${enabledCount}/${providers.length} subagent providers enabled`;

  return (
    <div class="system-prompt-toggle-menu subagent-provider-menu">
      <Tooltip content={open ? null : providerSummary} placement="top">
        <button ref={triggerRef} type="button"
          class={cx('system-prompt-toggle-trigger', 'subagent-provider-trigger', open && 'open', disabledCount > 0 && 'has-disabled')}
          aria-haspopup="dialog" aria-expanded={open} aria-label={`Subagent providers: ${providerSummary}`}
          onClick={() => setOpen((value) => !value)} onKeyDown={keydown}>
          <svg class="subagent-provider-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="6" cy="5" r="2.25" />
            <path d="M2.25 13c.25-2.25 1.5-3.5 3.75-3.5S9.5 10.75 9.75 13" />
            <circle cx="11.5" cy="5.5" r="1.75" />
            <path d="M10.75 9.5c1.75.1 2.75 1.1 3 3" />
          </svg>
        </button>
      </Tooltip>
      {open && (
        <div ref={menuRef} class="system-prompt-toggle-dropdown subagent-provider-dropdown" role="dialog" aria-label="Subagent provider toggles">
          <div class="system-prompt-toggle-header">
            <span class="system-prompt-toggle-title">Subagent providers</span>
          </div>
          <div class="system-prompt-toggle-body">
            {providers.map((provider) => {
              const enabled = isSubagentProviderEnabled(prefs, provider, sessionPath);
              const lastEnabled = enabled && enabledCount === 1;
              return (
                <button key={provider} type="button" class={cx('toolbar-settings-item', enabled && 'checked')}
                  role="checkbox" aria-checked={enabled} disabled={lastEnabled}
                  title={lastEnabled ? 'At least one subagent provider must remain enabled' : undefined}
                  onClick={() => toggle(provider)}>
                  <span class="toolbar-settings-item-check" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={enabled ? '' : 'opacity:0'}>
                      <polyline points="2.5,6.5 5,9 10.5,3.5" />
                    </svg>
                  </span>
                  <span class="toolbar-settings-item-label">{provider}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
