import type { ModelInfo } from '../catalog/model-contract';
import { resolveModelThinkingLevels } from '../catalog/model-catalog';
import type { RuntimeSnapshot } from './contracts';

/** Public catalog whitelist. Private headers and credential policies never enter model info. */
export function projectProviderRuntimeModels(
  snapshot: RuntimeSnapshot,
  available?: readonly { provider: string; id: string }[],
): ModelInfo[] {
  const admitted = available && new Set(available.map(model => JSON.stringify([model.provider, model.id])));
  return snapshot.models.filter(row => row.enabled && row.visible && row.model && !row.rejection
    && (!admitted || admitted.has(JSON.stringify([row.providerId, row.id])))).map(row => {
      const model = row.model!;
      return {
        id: model.id, provider: model.provider, name: model.name, reasoning: model.reasoning,
        thinkingLevels: resolveModelThinkingLevels(model as unknown as Record<string, unknown>),
        inputKinds: [...model.input], contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        subagent: { eligible: row.subagentEligible, pricing: {
          input: model.cost.input, output: model.cost.output,
          cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite,
        } },
      };
    });
}
