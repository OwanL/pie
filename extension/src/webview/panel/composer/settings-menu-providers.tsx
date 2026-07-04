/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs } from '../../../shared/protocol';
import { setProviderEnabled } from '../chat-prefs';
import type { OnSetPrefs } from './settings-menu-types';

interface ProviderItemProps {
  provider: string;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
}

function ProviderItem({ provider, prefs, onSetPrefs }: ProviderItemProps) {
  const checked = prefs.providerToggles[provider] !== false;
  return (
    <button
      class={`toolbar-settings-item${checked ? ' checked' : ''}`}
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onSetPrefs(setProviderEnabled(prefs, provider, !checked))}
    >
      <span class="toolbar-settings-item-check" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
          <polyline points="2.5,6.5 5,9 10.5,3.5" />
        </svg>
      </span>
      <span class="toolbar-settings-item-label">{provider}</span>
    </button>
  );
}

interface ProvidersSectionProps {
  providers: string[];
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
}

export function ProvidersSection({ providers, prefs, onSetPrefs }: ProvidersSectionProps) {
  return (
    <div key="providers" class="toolbar-settings-section">
      <div class="toolbar-settings-section-label">Providers</div>
      <div class="toolbar-settings-list">
        {providers.map((provider) => (
          <ProviderItem key={provider} provider={provider} prefs={prefs} onSetPrefs={onSetPrefs} />
        ))}
      </div>
    </div>
  );
}
