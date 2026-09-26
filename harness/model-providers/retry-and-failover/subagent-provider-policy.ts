/**
 * Effective subagent provider policy shared by the pie worker host (tool
 * visibility) and the in-process subagent extension (stale-execution guard).
 *
 * The webview's subagent provider toggle surface is the union of:
 * - providers referenced by the configured subagent buckets (canonical
 *   `provider/id` assignments contribute their provider prefix; legacy bare
 *   ids are resolved against the available model catalog),
 * - providers with an explicit default entry, and
 * - providers with an explicit per-session toggle entry (kept visible so a
 *   route is never lost while a session's model catalog is stale).
 *
 * A session counts as "don't use subagents" when the surface is non-empty and
 * every provider on it resolves to disabled under the standard precedence
 * (session override → default → enabled). The worker host removes the
 * subagent tool from the session's model-visible active tools while this
 * holds and restores it when any provider is re-enabled.
 *
 * An empty surface — no buckets and no toggle entries — is "unspecified":
 * subagents stay enabled and empty buckets keep falling back to the parent's
 * active model (the default-enabled provider semantics).
 */

/** Tool name the pie subagent extension registers. */
export const SUBAGENT_TOOL_NAME = 'subagent';

/** One bucket assignment (`ChatPrefs.subagentBuckets` entry shape). */
export interface SubagentProviderPolicyBucketEntry {
  model?: unknown;
}

/** Per-bucket assignment lists (`ChatPrefs.subagentBuckets` shape). Values may
 *  arrive from untrusted/legacy mirrors, so every field is validated here. */
export interface SubagentProviderPolicyBuckets {
  small?: unknown;
  medium?: unknown;
  frontier?: unknown;
}

export interface SubagentProviderPolicyInput {
  /** User-configured bucket assignments. */
  buckets?: SubagentProviderPolicyBuckets | undefined;
  /** Default provider enablement; entries must be booleans. */
  defaults?: Record<string, unknown> | undefined;
  /** Overrides resolved for ONE session; entries must be booleans. */
  sessionToggles?: Record<string, unknown> | undefined;
  /** Available catalog used to resolve legacy bare-id bucket entries. */
  availableModels?: ReadonlyArray<{ id?: unknown; provider?: unknown }> | undefined;
}

function addBooleanMapKeys(target: Set<string>, map: Record<string, unknown> | undefined): void {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return;
  for (const [provider, enabled] of Object.entries(map)) {
    if (provider && typeof enabled === 'boolean') target.add(provider);
  }
}

function addBucketProviders(
  target: Set<string>,
  entries: unknown,
  availableModels: ReadonlyArray<{ id?: unknown; provider?: unknown }>,
): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const spec = (entry as SubagentProviderPolicyBucketEntry).model;
    if (typeof spec !== 'string') continue;
    const slash = spec.indexOf('/');
    // A qualified assignment is itself authoritative configuration: keep its
    // provider even when the model is absent from the available snapshot
    // (mirrors the webview surface).
    if (slash > 0 && slash < spec.length - 1) {
      target.add(spec.substring(0, slash));
      continue;
    }
    for (const model of availableModels) {
      if (model && model.id === spec && typeof model.provider === 'string') {
        target.add(model.provider);
      }
    }
  }
}

/** Whether the effective subagent provider policy disables every provider on
 *  the toggle surface. False when the surface is empty (unspecified/default
 *  enabled) or when any provider remains effectively enabled. Never throws on
 *  malformed input: unrecognized shapes are ignored so a stale or partial
 *  mirror can never silently disable the subagent tool. */
export function subagentProvidersAllDisabled(input: SubagentProviderPolicyInput): boolean {
  const providers = new Set<string>();
  const availableModels = input.availableModels ?? [];
  const buckets = input.buckets;
  if (buckets && typeof buckets === 'object' && !Array.isArray(buckets)) {
    for (const key of ['small', 'medium', 'frontier'] as const) {
      addBucketProviders(providers, buckets[key], availableModels);
    }
  }
  addBooleanMapKeys(providers, input.defaults);
  addBooleanMapKeys(providers, input.sessionToggles);
  if (providers.size === 0) return false;

  for (const provider of providers) {
    const sessionValue = input.sessionToggles?.[provider];
    const effective = typeof sessionValue === 'boolean'
      ? sessionValue
      : typeof input.defaults?.[provider] === 'boolean'
        ? input.defaults[provider]
        : true;
    if (effective !== false) return false;
  }
  return true;
}