/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';
import type { ProxyGatewaySettings, ProxyProviderUpstream, ProxySettings, ProxySettingsUpdate } from '../../../shared/protocol';
import { CollapsibleChevron } from '../components/chevron';
import type { OnAddProxyProvider, OnSetProxySettings } from './settings-menu-types';

interface ProxySectionProps {
  proxySettings: ProxySettings;
  onSetProxySettings: OnSetProxySettings;
  onAddProxyProvider: OnAddProxyProvider;
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
      role="checkbox"
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

/** Common LiteLLM provider types offered as autocomplete for the Add Provider
 *  form's "LiteLLM provider" field. The user can still type any value. */
const COMMON_LITELLM_PROVIDERS = [
  'openai',
  'anthropic',
  'azure',
  'mistral',
  'cohere',
  'gemini',
  'groq',
  'together_ai',
  'huggingface',
  'openrouter',
  'vertex_ai',
  'bedrock',
  'custom',
];

/** Collapsible "Add provider" form. Collects the deterministic fields the host
 *  owns (name, API base, API key, LiteLLM provider type, max concurrent) and
 *  submits them via `onAddProxyProvider`. The host stores the key safely in
 *  proxy/.env, writes `proxy.providers.<name>` to settings.json, runs sync-models,
 *  and restarts the proxy. The model catalog (models.yaml) is added separately
 *  via the add-provider skill — until then the new provider is "pending" and
 *  routes nothing. */
function AddProviderForm({ onAddProxyProvider }: { onAddProxyProvider: OnAddProxyProvider }) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState('');
  const [apiBase, setApiBase] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [litellmProvider, setLitellmProvider] = useState('openai');
  const [maxConcurrent, setMaxConcurrent] = useState(4);

  const canSubmit = name.trim() !== '' && apiBase.trim() !== '' && apiKey.trim() !== '' && litellmProvider.trim() !== '';

  const submit = () => {
    if (!canSubmit) return;
    onAddProxyProvider({
      name: name.trim(),
      apiBase: apiBase.trim(),
      apiKey: apiKey.trim(),
      litellmProvider: litellmProvider.trim(),
      maxConcurrentRequests: maxConcurrent,
    });
    // Reset + collapse — the new provider appears as an editable ProviderGroup
    // above (optimistic apply) and a notice explains the next step.
    setName('');
    setApiBase('');
    setApiKey('');
    setLitellmProvider('openai');
    setMaxConcurrent(4);
    setExpanded(false);
  };

  return (
    <div class="toolbar-settings-ext-group">
      <div class="toolbar-settings-ext-row">
        <span class="toolbar-settings-item-label">Add provider</span>
        <button
          class={`toolbar-settings-ext-chevron${expanded ? ' expanded' : ''}`}
          type="button"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} add provider form`}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <CollapsibleChevron open={expanded} size={12} />
        </button>
      </div>
      {expanded && (
        <div class="toolbar-settings-ext-settings">
          <TextRow
            label="Name"
            value={name}
            ariaLabel="new provider name"
            onCommit={setName}
          />
          <TextRow
            label="API base"
            value={apiBase}
            ariaLabel="new provider API base URL"
            onCommit={setApiBase}
          />
          <div class="toolbar-settings-item toolbar-settings-mode-row">
            <span class="toolbar-settings-item-label">API key</span>
            <input
              type="password"
              class="toolbar-settings-select"
              value={apiKey}
              spellcheck={false}
              placeholder="stored in proxy/.env (gitignored)"
              aria-label="new provider API key"
              onChange={(e) => setApiKey((e.target as HTMLInputElement).value)}
            />
          </div>
          <div class="toolbar-settings-item toolbar-settings-mode-row">
            <span class="toolbar-settings-item-label">LiteLLM provider</span>
            <input
              type="text"
              class="toolbar-settings-select"
              value={litellmProvider}
              list="litellm-provider-options"
              spellcheck={false}
              aria-label="new provider LiteLLM provider type"
              onChange={(e) => setLitellmProvider((e.target as HTMLInputElement).value)}
            />
            <datalist id="litellm-provider-options">
              {COMMON_LITELLM_PROVIDERS.map((p) => <option value={p} />)}
            </datalist>
          </div>
          <StepperRow
            label="Max concurrent"
            value={maxConcurrent}
            min={1}
            ariaLabel="new provider max concurrent requests"
            onCommit={setMaxConcurrent}
          />
          <div class="toolbar-settings-item toolbar-settings-mode-row">
            <button
              type="button"
              class="toolbar-settings-stepper-btn"
              disabled={!canSubmit}
              aria-label="Add provider"
              onClick={submit}
            >Add provider</button>
          </div>
          <div class="toolbar-settings-item-hint">
            The key is written to proxy/.env (gitignored) as <code>{'<NAME>_API_KEY'}</code> and referenced by an env var — never stored in settings.json or models.yaml. Models aren't wired by this form: run the <code>add-provider</code> skill afterward to add the models.yaml catalog + populate the model list so the provider routes traffic.
          </div>
        </div>
      )}
    </div>
  );
}

export function ProxySection({ proxySettings, onSetProxySettings, onAddProxyProvider }: ProxySectionProps) {
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
        {Object.entries(proxySettings.providers).map(([name, provider]) => (
          <ProviderGroup key={name} name={name} provider={provider} onSetProxySettings={onSetProxySettings} />
        ))}
        <AddProviderForm onAddProxyProvider={onAddProxyProvider} />
        <div class="toolbar-settings-item-hint">
          Changes regenerate the proxy config and restart the LiteLLM proxy. In-flight proxied requests may be interrupted. The master key is pie-managed (auto-generated). Use "Add provider" to add a new proxied upstream (its model catalog is wired separately via the add-provider skill).
        </div>
      </div>
    </div>
  );
}