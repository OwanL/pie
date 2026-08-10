import type { ModelInfo, ThinkingLevel } from '../../../shared/protocol';

/** Canonical identity used by every webview model picker. The first slash is
 * the separator so model ids may contain additional slashes. */
export function formatModelSpec(model: Pick<ModelInfo, 'provider' | 'id'>): string {
  return `${model.provider}/${model.id}`;
}

/** Parse a canonical provider-qualified spec while retaining legacy bare ids. */
export function parseModelSpec(spec: string): { provider?: string; id: string } {
  const slash = spec.indexOf('/');
  return slash > 0 && slash < spec.length - 1
    ? { provider: spec.substring(0, slash), id: spec.substring(slash + 1) }
    : { id: spec };
}

/**
 * Filter out models whose provider is toggled off. A provider is disabled when
 * `providerToggles[provider] === false` (absent or `true` → enabled).
 *
 * Used by the settings-menu model pickers (subagent buckets, pruning prepass)
 * so disabled-provider models aren't offered for selection — they're removed
 * from the runtime selection pools anyway, so offering them is misleading. The
 * main toolbar model selector applies its own filter (with a "keep the active
 * model" exception) and does not use this helper.
 */
export function filterEnabledProviders(
  models: ModelInfo[],
  providerToggles: Record<string, boolean>,
): ModelInfo[] {
  return models.filter((m) => providerToggles[m.provider] !== false);
}

/** Exact runtime-supported levels for a provider-qualified model. The fallback
 * only serves older snapshots that predate `thinkingLevels`; production model
 * catalogs always carry the explicit list. */
export function getModelThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
  if (!model) return [];
  if (Array.isArray(model.thinkingLevels) && model.thinkingLevels.length > 0) {
    return [...model.thinkingLevels];
  }
  return model.reasoning
    ? ['off', 'minimal', 'low', 'medium', 'high']
    : ['off'];
}

export function isModelSelectedBySpec(
  model: Pick<ModelInfo, 'provider' | 'id'>,
  selectedSpecs: string[],
  catalog: ModelInfo[],
): boolean {
  if (selectedSpecs.includes(formatModelSpec(model))) return true;
  if (!selectedSpecs.includes(model.id)) return false;

  // A legacy bare id represented one runtime-resolved model. Preserve that
  // behaviour only when the catalog has a single declaration. When providers
  // share an id, keep every exact provider/id option available so the user can
  // replace the ambiguous legacy entry with the provider they actually want.
  return catalog.filter((candidate) => candidate.id === model.id).length === 1;
}

/** Replace the matching legacy bare id when a provider-qualified choice is
 * made. This upgrades old bucket configuration instead of leaving a broad bare
 * id beside a redundant exact provider/id entry. */
export function addProviderQualifiedModelSpec(selectedSpecs: string[], spec: string): string[] {
  const parsed = parseModelSpec(spec);
  if (!parsed.provider) return selectedSpecs.includes(spec) ? selectedSpecs : [...selectedSpecs, spec];
  if (selectedSpecs.includes(spec)) return selectedSpecs;
  return [...selectedSpecs.filter((selected) => selected !== parsed.id), spec];
}

export interface ModelPickerEntry {
  model: ModelInfo;
  /** Display label for the dropdown row — prefixed with ⚠ when the subagent profile warns against the model. */
  label: string;
  /** Compact closed-state label shown in the toolbar after selection. */
  selectedLabel: string;
  /** True for models whose subagent profile carries an eligibility warning. */
  ineligible: boolean;
  /** Tooltip text describing pricing and ineligibility when applicable. */
  title: string;
  /** Token input price per 1M tokens, formatted for display (e.g. "$2.50"). */
  tokenInPrice: string;
  /** Token output price per 1M tokens, formatted for display (e.g. "$10.00"). */
  tokenOutPrice: string;
  /** Whether the model supports image inputs. */
  supportsImages: boolean;
}

/**
 * Strip any leading provider/prefix from a model name for the compact closed-state
 * toolbar label (e.g. "Ollama Cloud: Deepseek V4 pro" → "Deepseek V4 pro").
 * The dropdown itself keeps the full provider-qualified label for disambiguation.
 */
function stripProviderPrefix(name: string): string {
  return name.replace(/^[^:]+:\s*/, '');
}

/**
 * Order models for the picker alphabetically by display name, then id and
 * provider. Subagent eligibility is an annotation, not a hidden second section:
 * keeping warned models in their expected alphabetical position makes the
 * searchable catalog behave consistently across picker surfaces.
 *
 * The returned entries carry display affordances (warning prefix, tooltip) so
 * consumers do not need to re-derive eligibility metadata.
 */
export interface ModelPickerOrderOptions {
  /** Apply subagent eligibility warnings. Disable this for non-subagent
   * pickers: subagent eligibility is not a recommendation about those uses. */
  useSubagentEligibility?: boolean;
}

export function orderModelsForPicker(
  models: ModelInfo[],
  { useSubagentEligibility = true }: ModelPickerOrderOptions = {},
): ModelPickerEntry[] {
  const decorated = models.map((model) => {
    const sub = model.subagent;
    const ineligible = useSubagentEligibility && sub?.eligible === false;
    return {
      model,
      ineligible,
    };
  });

  decorated.sort((a, b) => {
    const byName = a.model.name.localeCompare(b.model.name);
    if (byName !== 0) return byName;
    const byId = a.model.id.localeCompare(b.model.id);
    if (byId !== 0) return byId;
    return a.model.provider.localeCompare(b.model.provider);
  });

  return decorated.map((entry) => {
    const { model, ineligible } = entry;
    const prefix = ineligible ? '⚠ ' : '';

    // Keep one provider-qualified identity without repeating a provider-branded
    // prefix from the catalog name (for example, avoid
    // "github-copilot · Copilot: GPT-5"). The full catalog name remains in the
    // tooltip and searchable model metadata.
    const compactName = stripProviderPrefix(model.name);
    const dropdownLabel = `${prefix}${model.provider} · ${compactName}`;
    const selectedLabel = `${prefix}${compactName}`;

    const titleParts = [model.name];

    const sub = model.subagent;
    if (sub?.pricing && (sub.pricing.input > 0 || sub.pricing.output > 0)) {
      titleParts.push(
        `Pricing: $${sub.pricing.input.toFixed(2)}/M in, $${sub.pricing.output.toFixed(2)}/M out`,
      );
    }

    if (ineligible) {
      const reason = model.subagent?.disabledReason;
      titleParts.push(reason ? `Subagent eligibility warning: ${reason}` : 'Subagent eligibility warning');
    }
    const supportsImages = model.inputKinds.includes('image');

    // Format pricing for display
    let tokenInPrice = '';
    let tokenOutPrice = '';
    if (sub?.pricing) {
      if (sub.pricing.input > 0) tokenInPrice = `$${sub.pricing.input.toFixed(2)}`;
      if (sub.pricing.output > 0) tokenOutPrice = `$${sub.pricing.output.toFixed(2)}`;
    }

    return {
      model,
      ineligible,
      label: dropdownLabel,
      selectedLabel,
      title: titleParts.join('\n'),
      tokenInPrice,
      tokenOutPrice,
      supportsImages,
    };
  });
}
