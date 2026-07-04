/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';
import type { ProxyGatewaySettings, ProxyProviderUpstream, ProxySettings, ProxySettingsUpdate } from '../../../shared/protocol';
import { CollapsibleChevron } from '../components/chevron';
import type { OnSetProxySettings } from './settings-menu-types';

interface ProxySectionProps {
  proxySettings: ProxySettings;
  onSetProxySettings: OnSetProxySettings;
}

/** A labeled row with a text <input>, reusing the select control styling. */
function TextRow({
  label,
  value,
  ariaLabel,
  onCommit,
}: {
  label: string;
  value: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  return (
    <div class="toolbar-settings-item toolbar-settings-mode-row">
      <span class="toolbar-settings-item-label">{label}</span>
      <input
        type="text"
        class="toolbar-settings-select"
        value={value}
        spellcheck={false}
        aria-label={ariaLabel}
        onChange={(e) => onCommit((e.target as HTMLInputElement).value)}
      />
    </div>
  );
}

/** A numeric stepper row (− value +), mirroring the pruning skill/tool limits. */
function StepperRow({
  label,
  value,
  min,
  ariaLabel,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  ariaLabel: string;
  onCommit: (next: number) => void;
}) {
  return (
    <div class="toolbar-settings-item toolbar-settings-stepper-row">
      <span class="toolbar-settings-item-label">{label}</span>
      <div class="toolbar-settings-stepper">
        <button
          type="button"
          class="toolbar-settings-stepper-btn"
          aria-label={`Decrease ${ariaLabel}`}
          disabled={value <= min}
          onClick={() => onCommit(Math.max(min, value - 1))}
        >−</button>
        <span class="toolbar-settings-stepper-value">{value}</span>
        <button
          type="button"
          class="toolbar-settings-stepper-btn"
          aria-label={`Increase ${ariaLabel}`}
          onClick={() => onCommit(value + 1)}
        >+</button>
      </div>
    </div>
  );
}

/** A boolean toggle rendered as a check-item, mirroring ProviderItem. */
function BoolRow({
  label,
  checked,
  ariaLabel,
  onToggle,
}: {
  label: string;
  checked: boolean;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      class={`toolbar-settings-item${checked ? ' checked' : ''}`}
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={onToggle}
    >
      <span class="toolbar-settings-item-check" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
          <polyline points="2.5,6.5 5,9 10.5,3.5" />
        </svg>
      </span>
      <span class="toolbar-settings-item-label">{label}</span>
    </button>
  );
}

function ProviderGroup({
  name,
  provider,
  onSetProxySettings,
}: {
  name: string;
  provider: ProxyProviderUpstream;
  onSetProxySettings: OnSetProxySettings;
}) {
  const [expanded, setExpanded] = useState(false);
  const update = (partial: Partial<ProxyProviderUpstream>) =>
    onSetProxySettings({ providers: { [name]: partial } });

  return (
    <div class="toolbar-settings-ext-group">
      <div class="toolbar-settings-ext-row">
        <span class="toolbar-settings-item-label">{name}</span>
        <button
          class={`toolbar-settings-ext-chevron${expanded ? ' expanded' : ''}`}
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${name} upstream settings`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <CollapsibleChevron open={expanded} size={12} />
        </button>
      </div>
      {expanded && (
        <div class="toolbar-settings-ext-settings">
          <TextRow
            label="API base"
            value={provider.apiBase}
            ariaLabel={`${name} API base`}
            onCommit={(apiBase) => update({ apiBase })}
          />
          <TextRow
            label="API key env"
            value={provider.apiKeyEnv}
            ariaLabel={`${name} API key env var`}
            onCommit={(apiKeyEnv) => update({ apiKeyEnv })}
          />
          <TextRow
            label="LiteLLM provider"
            value={provider.litellmProvider}
            ariaLabel={`${name} LiteLLM provider`}
            onCommit={(litellmProvider) => update({ litellmProvider })}
          />
          <StepperRow
            label="Max concurrent"
            value={provider.maxConcurrentRequests}
            min={1}
            ariaLabel={`${name} max concurrent requests`}
            onCommit={(maxConcurrentRequests) => update({ maxConcurrentRequests })}
          />
          {/* Read-only advanced fields — tied to the model catalog, not editable here. */}
          <div class="toolbar-settings-item toolbar-settings-mode-row">
            <span class="toolbar-settings-item-label">Model info id</span>
            <span class="toolbar-settings-stepper-value">{provider.litellmModelInfoId}</span>
          </div>
          <div class="toolbar-settings-item toolbar-settings-mode-row">
            <span class="toolbar-settings-item-label">Model list order</span>
            <span class="toolbar-settings-stepper-value">{provider.modelListOrder.length} models</span>
          </div>
          <div class="toolbar-settings-item toolbar-settings-mode-row">
            <span class="toolbar-settings-item-label">Aliases</span>
            <span class="toolbar-settings-stepper-value">{Object.keys(provider.alias).length}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProxySection({ proxySettings, onSetProxySettings }: ProxySectionProps) {
  const { gateway } = proxySettings;
  const setGateway = (partial: ProxySettingsUpdate['gateway']) =>
    onSetProxySettings({ gateway: partial });

  return (
    <div key="proxy" class="toolbar-settings-section">
      <div class="toolbar-settings-section-label">Proxy</div>
      <div class="toolbar-settings-list">
        <StepperRow
          label="Retries"
          value={gateway.routerSettings.numRetries}
          min={0}
          ariaLabel="proxy router retries"
          onCommit={(numRetries) => setGateway({ routerSettings: { ...gateway.routerSettings, numRetries } })}
        />
        <StepperRow
          label="Timeout (s)"
          value={gateway.routerSettings.timeout}
          min={1}
          ariaLabel="proxy router timeout"
          onCommit={(timeout) => setGateway({ routerSettings: { ...gateway.routerSettings, timeout } })}
        />
        <BoolRow
          label="Retry after header"
          checked={gateway.routerSettings.retryAfter}
          ariaLabel="proxy router retry-after"
          onToggle={() => setGateway({ routerSettings: { ...gateway.routerSettings, retryAfter: !gateway.routerSettings.retryAfter } })}
        />
        <BoolRow
          label="Drop unknown params"
          checked={gateway.litellmSettings.dropParams}
          ariaLabel="proxy litellm drop params"
          onToggle={() => setGateway({ litellmSettings: { dropParams: !gateway.litellmSettings.dropParams } })}
        />
        <TextRow
          label="Master key env"
          value={gateway.generalSettings.masterKeyEnv}
          ariaLabel="proxy master key env var"
          onCommit={(masterKeyEnv) => setGateway({ generalSettings: { masterKeyEnv } })}
        />
        {Object.entries(proxySettings.providers).map(([name, provider]) => (
          <ProviderGroup key={name} name={name} provider={provider} onSetProxySettings={onSetProxySettings} />
        ))}
        <div class="toolbar-settings-item-hint">
          Changes regenerate the proxy config and restart the LiteLLM proxy. In-flight umans requests may be interrupted.
        </div>
      </div>
    </div>
  );
}