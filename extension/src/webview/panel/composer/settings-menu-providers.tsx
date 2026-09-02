/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';
import type { ChatPrefs, ProviderGateStats, ProviderGateProviderMetrics } from '../../../shared/protocol';
import { setProviderEnabled } from '../chat-prefs';
import { CollapsibleChevron } from '../components/chevron';
import { SettingCheckbox } from '../components/setting-checkbox';
import { SliderRow } from '../components/slider-row';
import type { OnSetPrefs } from './settings-menu-types';

export const PROVIDER_SETTING_LABELS = [
  'Max concurrent',
  'Afterburn',
  'Queue wait',
  'Header wait',
] as const;

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
    <div class="toolbar-settings-ext-settings toolbar-settings-indent">
      <div class="toolbar-settings-list">
        {/* Max concurrent requests */}
        <SliderRow
          label="Max concurrent"
          value={maxConcurrent}
          min={1}
          max={8}
          step={1}
          ariaLabel={`Max concurrent requests for ${provider}`}
          hint="Max in-flight LLM requests to this provider. Lower = gentler on rate limits."
          onChange={(value) => setOverride('maxConcurrentRequests', value)}
        />

        {/* Afterburn sticky-slot window */}
        <SliderRow
          label="Afterburn"
          value={afterburn}
          min={0}
          max={60}
          step={5}
          formatValue={(v) => (v === 0 ? 'Off' : `${v}s`)}
          ariaLabel={`Afterburn sticky-slot window for ${provider}`}
          hint="Reserves a slot for the same session after it finishes. 0 = disabled."
          onChange={(value) => setOverride('afterburnSeconds', value)}
        />

        {/* Queue wait timeout */}
        <SliderRow
          label="Queue wait"
          value={queueWait}
          min={0}
          max={300}
          step={5}
          formatValue={(v) => (v === 0 ? '300s max' : `${v}s`)}
          ariaLabel={`Queue wait timeout for ${provider}`}
          hint="How long a queued request waits before failing with 429. 0 uses the 300s safety maximum."
          onChange={(value) => setOverride('queueWaitSeconds', value)}
        />

        {/* Header wait timeout */}
        <SliderRow
          label="Header wait"
          value={headerWait}
          min={0}
          max={300}
          step={10}
          formatValue={(v) => (v === 0 ? 'default' : `${v}s`)}
          ariaLabel={`Header wait timeout for ${provider}`}
          hint="Max seconds to wait for upstream response headers. 0 = provider default."
          onChange={(value) => setOverride('headerWaitSeconds', value)}
        />

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
        <SettingCheckbox
          label={provider}
          checked={checked}
          onChange={() => onSetPrefs(setProviderEnabled(prefs, provider, !checked))}
          trailing={hasConcurrency && (
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
        />
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
