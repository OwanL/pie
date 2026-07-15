import type { ModelInfo } from '../../../shared/protocol';

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

export interface ModelPickerEntry {
  model: ModelInfo;
  /** Display label for the dropdown row — prefixed with ⚠ when ineligible as subagent. */
  label: string;
  /** Compact closed-state label shown in the toolbar after selection. */
  selectedLabel: string;
  /** True for models that are explicitly ineligible as subagent targets. */
  ineligible: boolean;
  /** Tooltip text describing rating + ineligibility reason when applicable. */
  title: string;
  /** Token input price per 1M tokens, formatted for display (e.g. "$2.50"). */
  tokenInPrice: string;
  /** Token output price per 1M tokens, formatted for display (e.g. "$10.00"). */
  tokenOutPrice: string;
  /** Whether the model supports image inputs. */
  supportsImages: boolean;
}

const RATING_MAX = 20;

/**
 * Strip any leading provider/prefix from a model name for the compact closed-state
 * toolbar label (e.g. "Ollama Cloud: Deepseek V4 pro" → "Deepseek V4 pro").
 * The dropdown itself keeps the full provider-qualified label for disambiguation.
 */
function stripProviderPrefix(name: string): string {
  return name.replace(/^[^:]+:\s*/, '');
}

/**
 * Order models for the picker:
 *   1. Eligible / unprofiled first, then ineligible (subagent-disabled).
 *   2. Within each group, sort by normalized cost descending (most expensive first).
 *   3. Tiebreak by aggregate subagent rating descending, then display name, then id.
 *
 * Unprofiled models (no normalizedCost) sort to the bottom of the eligible group
 * with cost=0 fallback since their pricing is unknown/typically free.
 * Models without a subagent profile also fall back to cost=0.
 *
 * The returned entries carry display affordances (warning prefix, tooltip) so the
 * toolbar can render without re-deriving rating logic.
 */
export interface ModelPickerOrderOptions {
  /** Apply subagent eligibility warnings/demotion. Disable this for the parent
   * chat picker: subagent eligibility is not a recommendation about chat use. */
  useSubagentEligibility?: boolean;
}

export function orderModelsForPicker(
  models: ModelInfo[],
  { useSubagentEligibility = true }: ModelPickerOrderOptions = {},
): ModelPickerEntry[] {
  const decorated = models.map((model, index) => {
    const sub = model.subagent;
    const ineligible = useSubagentEligibility && sub?.eligible === false;
    const aggregate = sub?.aggregate;
    const cost = sub?.normalizedCost;
    return {
      model,
      index,
      ineligible,
      aggregate: typeof aggregate === 'number' ? aggregate : -1,
      hasProfile: sub !== undefined,
      cost: typeof cost === 'number' ? cost : 0,
    };
  });

  decorated.sort((a, b) => {
    if (a.ineligible !== b.ineligible) return a.ineligible ? 1 : -1;
    if (a.cost !== b.cost) return b.cost - a.cost;
    if (a.aggregate !== b.aggregate) return b.aggregate - a.aggregate;
    const byName = a.model.name.localeCompare(b.model.name);
    if (byName !== 0) return byName;
    return a.model.id.localeCompare(b.model.id);
  });

  return decorated.map((entry) => {
    const { model, ineligible, aggregate, hasProfile } = entry;
    const ratingText = hasProfile && aggregate >= 0 ? `${aggregate}/${RATING_MAX}` : 'unrated';
    const prefix = ineligible ? '⚠ ' : '';

    // Prefix the dropdown label with the provider id so models that exist under
    // multiple providers (e.g. gpt-5.5 under both github-copilot and openai-codex)
    // are unambiguous in the picker. The closed toolbar trigger keeps the compact
    // stripped name (see selectedLabel below).
    const dropdownLabel = `${prefix}${model.provider} · ${model.name}`;
    const selectedLabel = `${prefix}${stripProviderPrefix(model.name)}`;

    const titleParts = [`${model.name} — rating ${ratingText}`];

    // Add cost info when available
    const sub = model.subagent;
    if (sub?.normalizedCost !== undefined && sub.normalizedCost > 0) {
      titleParts.push(`Cost: ${sub.normalizedCost.toFixed(1)} (${RATING_MAX} scale)`);
    }
    if (sub?.pricing && (sub.pricing.input > 0 || sub.pricing.output > 0)) {
      titleParts.push(
        `Pricing: $${sub.pricing.input.toFixed(2)}/M in, $${sub.pricing.output.toFixed(2)}/M out`,
      );
    }

    if (ineligible) {
      const reason = model.subagent?.disabledReason;
      titleParts.push(reason ? `Disabled for subagent use: ${reason}` : 'Disabled for subagent use');
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
