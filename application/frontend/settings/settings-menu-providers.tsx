/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useId, useState } from 'preact/hooks';
import type { ChatPrefs, ProviderGateStats, ProviderGateProviderMetrics } from '../../lib/protocol/index.js';
import {
  PROVIDER_MAX_CONCURRENT_REQUESTS,
  PROVIDER_UNLIMITED_CONCURRENCY,
} from '../../lib/protocol/provider-concurrency.js';
import { concurrencySourceLabel } from '../../../lib/concurrency-config.js';
import { setProviderEnabled } from '../shell/chat-prefs';
import { CollapsibleChevron } from '../lib/components/chevron';
import { SettingCheckbox } from './setting-checkbox';
import { SliderRow } from './slider-row';
import type { OnSetPrefs } from './settings-menu-types';

export const PROVIDER_SETTING_LABELS = [
  'Max concurrent',
  'Afterburn',
  'Queue wait',
  'Header wait',
] as const;

/** The rightmost UI position is reserved for the explicit Unlimited sentinel;
 * finite values remain the human-readable 1–128 range. */
const PROVIDER_UNLIMITED_SLIDER_VALUE = PROVIDER_MAX_CONCURRENT_REQUESTS + 1;

interface ProviderItemProps {
  provider: string;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  metrics?: ProviderGateProviderMetrics;
  expanded: boolean;
  onToggleExpand: () => void;
}

/** Seconds until a host-supplied resume deadline, clamped so a stale or
 *  elapsed deadline never shows a negative countdown. */
function remainingSeconds(pausedUntilMs: number): number {
  return Math.max(0, Math.ceil((pausedUntilMs - Date.now()) / 1000));
}

/** Ticking pause status for one provider's gate strike. The interval lives
 *  only inside this row, so the per-second countdown updates without
 *  re-rendering the surrounding settings panel; the effect clears it on
 *  unmount and when the host stops reporting the provider as paused. */
function PausedProviderStatus({ metrics }: { metrics: ProviderGateProviderMetrics }) {
  const [remaining, setRemaining] = useState(() => remainingSeconds(metrics.pausedUntilMs));
  useEffect(() => {
    const pausedUntilMs = metrics.pausedUntilMs;
    const interval = setInterval(() => {
      setRemaining((previous) => {
        const next = remainingSeconds(pausedUntilMs);
        return next === previous ? previous : next;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [metrics.pausedUntilMs]);
  return <>⏸ Paused — {remaining}s remaining (strike {metrics.strikeCount})</>;
}

function ProviderConcurrencyControls({
  provider,
  prefs,
  onSetPrefs,
  metrics,
  id,
}: {
  provider: string;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  metrics?: ProviderGateProviderMetrics;
  id: string;
}) {
  const overrides = prefs.providerConcurrency[provider] ?? {};
  const hasRequestedMax = overrides.maxConcurrentRequests !== undefined || metrics !== undefined;
  const maxConcurrent = overrides.maxConcurrentRequests ?? metrics?.maxConcurrentRequests;
  const maxConcurrentSliderValue = maxConcurrent === PROVIDER_UNLIMITED_CONCURRENCY
    ? PROVIDER_UNLIMITED_SLIDER_VALUE
    : maxConcurrent ?? 1;
  const maxConcurrentLabel = maxConcurrent === undefined
    ? 'Unavailable'
    : maxConcurrent === PROVIDER_UNLIMITED_CONCURRENCY ? 'Unlimited' : String(maxConcurrent);
  const runtimeMaxConcurrentLabel = metrics === undefined
    ? 'Unavailable'
    : metrics.maxConcurrentRequests === PROVIDER_UNLIMITED_CONCURRENCY
      ? 'Unlimited'
      : String(metrics.maxConcurrentRequests);
  const afterburn = overrides.afterburnSeconds ?? metrics?.afterburnSeconds ?? 0;
  const queueWait = overrides.queueWaitSeconds ?? metrics?.queueWaitSeconds ?? 30;
  const headerWait = overrides.headerWaitSeconds ?? 0;
  const requestedMaxDetail = overrides.maxConcurrentRequests !== undefined
    ? `Configured/requested: ${maxConcurrentLabel} · ${concurrencySourceLabel('saved-preference')}`
    : metrics
      ? `No saved override · using current runtime value (${maxConcurrentLabel})`
      : 'Configured/requested: unavailable';

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
    <div id={id} class="toolbar-settings-ext-settings toolbar-settings-indent">
      <div class="toolbar-settings-list">
        {/* Max concurrent requests */}
        <SliderRow
          label="Max concurrent"
          value={maxConcurrentSliderValue}
          min={1}
          max={PROVIDER_UNLIMITED_SLIDER_VALUE}
          step={1}
          formatValue={(value) => !hasRequestedMax
            ? 'Unavailable'
            : value === PROVIDER_UNLIMITED_SLIDER_VALUE ? 'Unlimited' : `${value}`}
          ariaLabel={`Max concurrent requests for ${provider}`}
          tooltip="Provider-wide in-flight request cap. Unlimited disables this provider's concurrency and afterburn capacity throttling while retaining circuit breakers and network safety deadlines. It does not bypass the separate subagent tree limit."
          hint={<>
            <div>Max in-flight LLM requests to this provider. Move to the rightmost position for Unlimited.</div>
            <div>{requestedMaxDetail}</div>
            <div>{metrics
              ? `Runtime/applied: ${runtimeMaxConcurrentLabel} · ${concurrencySourceLabel(metrics.maxConcurrentRequestsSource)}`
              : 'Runtime/applied: unavailable'}</div>
          </>}
          disabled={!hasRequestedMax}
          onChange={(value) => setOverride(
            'maxConcurrentRequests',
            value === PROVIDER_UNLIMITED_SLIDER_VALUE ? PROVIDER_UNLIMITED_CONCURRENCY : value,
          )}
        />
        {overrides.maxConcurrentRequests !== undefined && (!metrics || overrides.maxConcurrentRequests !== metrics.maxConcurrentRequests) && (
          <div class="toolbar-settings-runtime-status">
            {metrics ? `Applied: ${runtimeMaxConcurrentLabel}` : 'Runtime unavailable'}
          </div>
        )}

        {/* Afterburn sticky-slot window */}
        <SliderRow
          label="Afterburn"
          value={afterburn}
          min={0}
          max={300}
          step={5}
          formatValue={(v) => (v === 0 ? 'Off' : `${v}s`)}
          ariaLabel={`Afterburn sticky-slot window for ${provider}`}
          tooltip="Afterburn keeps a completed capacity slot reserved for the same session. It is ignored when Max concurrent is Unlimited."
          hint="Reserves a slot for the same session after it finishes. 0 = disabled; Unlimited max concurrency bypasses this capacity hold."
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
          tooltip="Maximum time a request may wait for finite provider capacity before a retryable saturation error. Unlimited capacity normally avoids this queue."
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
          tooltip="Maximum time to wait for upstream response headers. This network deadline remains active in Unlimited mode; 0 uses the provider default."
          hint="Max seconds to wait for upstream response headers. 0 = provider default."
          onChange={(value) => setOverride('headerWaitSeconds', value)}
        />

        {/* Live metrics */}
        {metrics && (
          <div class="toolbar-settings-item-hint" style="margin-top: 4px;">
            {metrics.paused
              ? <PausedProviderStatus metrics={metrics} />
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
  const controlsId = `provider-concurrency-${useId()}`;
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
              aria-controls={expanded && hasConcurrency ? controlsId : undefined}
              onClick={onToggleExpand}
            >
              <CollapsibleChevron open={expanded} size={12} />
            </button>
          )}
        />
      </div>
      {expanded && hasConcurrency && (
        <ProviderConcurrencyControls id={controlsId} provider={provider} prefs={prefs} onSetPrefs={onSetPrefs} metrics={metrics} />
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
