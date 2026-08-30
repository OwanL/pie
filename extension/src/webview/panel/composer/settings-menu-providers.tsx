/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';
import type { ChatPrefs, ProviderGateStats, ProviderGateProviderMetrics } from '../../../shared/protocol';
import { setProviderEnabled } from '../chat-prefs';
import { CollapsibleChevron } from '../components/chevron';
import type { OnSetPrefs } from './settings-menu-types';

interface ProviderItemProps {
  provider: string;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  metrics?: ProviderGateProviderMetrics;
  expanded: boolean;
  onToggleExpand: () => void;
}

function ProviderConcurrencyControls({
  provider,
  prefs,
  onSetPrefs,
  metrics,
}: {
  provider: string;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  metrics?: ProviderGateProviderMetrics;
}) {
  const overrides = prefs.providerConcurrency[provider] ?? {};
  const maxConcurrent = overrides.maxConcurrentRequests ?? metrics?.maxConcurrentRequests ?? 2;
  const afterburn = overrides.afterburnSeconds ?? metrics?.afterburnSeconds ?? 0;
  const queueWait = overrides.queueWaitSeconds ?? 30;
  const headerWait = overrides.headerWaitSeconds ?? 0;

  const setOverride = (field: 'maxConcurrentRequests' | 'afterburnSeconds' | 'queueWaitSeconds' | 'headerWaitSeconds', value: number) => {
    const current = prefs.providerConcurrency[provider] ?? {};
    onSetPrefs({
      providerConcurrency: {
        ...prefs.providerConcurrency,
        [provider]: { ...current, [field]: value },
      },
    });
  };

  return (
    <div class="toolbar-settings-ext-settings" style="padding-left: 28px;">
      <div class="toolbar-settings-list">
        {/* Max concurrent requests */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Max concurrent</span>
            <span class="toolbar-settings-ui-control-value">{maxConcurrent}</span>
          </div>
          <input
            type="range"
            class="toolbar-settings-slider toolbar-settings-ui-slider"
            min="1"
            max="8"
            step="1"
            value={maxConcurrent}
            onInput={(e) => setOverride('maxConcurrentRequests', Number((e.target as HTMLInputElement).value))}
            aria-label={`Max concurrent requests for ${provider}`}
          />
          <div class="toolbar-settings-item-hint">
            Max in-flight LLM requests to this provider. Lower = gentler on rate limits.
          </div>
        </div>

        {/* Afterburn sticky-slot window */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Afterburn</span>
            <span class="toolbar-settings-ui-control-value">
              {afterburn === 0 ? 'Off' : `${afterburn}s`}
            </span>
          </div>
          <input
            type="range"
            class="toolbar-settings-slider toolbar-settings-ui-slider"
            min="0"
            max="60"
            step="5"
            value={afterburn}
            onInput={(e) => setOverride('afterburnSeconds', Number((e.target as HTMLInputElement).value))}
            aria-label={`Afterburn sticky-slot window for ${provider}`}
          />
          <div class="toolbar-settings-item-hint">
            Reserves a slot for the same session after it finishes. 0 = disabled.
          </div>
        </div>

        {/* Queue wait timeout */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Queue wait</span>
            <span class="toolbar-settings-ui-control-value">
              {queueWait === 0 ? '300s max' : `${queueWait}s`}
            </span>
          </div>
          <input
            type="range"
            class="toolbar-settings-slider toolbar-settings-ui-slider"
            min="0"
            max="300"
            step="5"
            value={queueWait}
            onInput={(e) => setOverride('queueWaitSeconds', Number((e.target as HTMLInputElement).value))}
            aria-label={`Queue wait timeout for ${provider}`}
          />
          <div class="toolbar-settings-item-hint">
            How long a queued request waits before failing with 429. 0 uses the 300s safety maximum.
          </div>
        </div>

        {/* Header wait timeout */}
        <div class="toolbar-settings-ui-control">
          <div class="toolbar-settings-ui-control-head">
            <span class="toolbar-settings-ui-control-label">Header wait</span>
            <span class="toolbar-settings-ui-control-value">
              {headerWait === 0 ? 'default' : `${headerWait}s`}
            </span>
          </div>
          <input
            type="range"
            class="toolbar-settings-slider toolbar-settings-ui-slider"
            min="0"
            max="300"
            step="10"
            value={headerWait}
            onInput={(e) => setOverride('headerWaitSeconds', Number((e.target as HTMLInputElement).value))}
            aria-label={`Header wait timeout for ${provider}`}
          />
          <div class="toolbar-settings-item-hint">
            Max seconds to wait for upstream response headers. 0 = provider default.
          </div>
        </div>

        {/* Live metrics */}
        {metrics && (
          <div class="toolbar-settings-item-hint" style="margin-top: 4px;">
            {metrics.paused
              ? `⏸ Paused — ${Math.ceil((metrics.pausedUntilMs - Date.now()) / 1000)}s remaining (strike ${metrics.strikeCount})`
              : `Live: ${metrics.activeRequests} active / ${metrics.queuedRequests} queued`}
          </div>
        )}
      </div>
    </div>
  );
}

function ProviderItem({ provider, prefs, onSetPrefs, metrics, expanded, onToggleExpand }: ProviderItemProps) {
  const checked = prefs.providerToggles[provider] !== false;
  const hasConcurrency = !!metrics || provider in prefs.providerConcurrency;
  return (
    <div class="toolbar-settings-ext-group">
      <div class="toolbar-settings-ext-row">
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
        {hasConcurrency && (
          <button
            class="toolbar-settings-ext-chevron"
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${provider} concurrency settings`}
            aria-expanded={expanded}
            onClick={onToggleExpand}
          >
            <CollapsibleChevron open={expanded} size={12} />
          </button>
        )}
      </div>
      {expanded && hasConcurrency && (
        <ProviderConcurrencyControls provider={provider} prefs={prefs} onSetPrefs={onSetPrefs} metrics={metrics} />
      )}
    </div>
  );
}

interface ProvidersSectionProps {
  providers: string[];
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  providerGateStats: ProviderGateStats;
}

export function ProvidersSection({ providers, prefs, onSetPrefs, providerGateStats }: ProvidersSectionProps) {
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
  const metricsByProvider = new Map(
    providerGateStats.providers.map((m) => [m.provider, m]),
  );
  return (
    <div key="providers" class="toolbar-settings-section">
      <div class="toolbar-settings-list">
        {providers.map((provider) => (
          <ProviderItem
            key={provider}
            provider={provider}
            prefs={prefs}
            onSetPrefs={onSetPrefs}
            metrics={metricsByProvider.get(provider)}
            expanded={expandedProvider === provider}
            onToggleExpand={() => setExpandedProvider(expandedProvider === provider ? null : provider)}
          />
        ))}
      </div>
    </div>
  );
}
