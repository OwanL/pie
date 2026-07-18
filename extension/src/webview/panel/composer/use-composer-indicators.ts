import { useMemo } from 'preact/hooks';

import type {
  ChatMessage,
  ContextWindowUsage,
  ModelInfo,
  ModelSettings,
  PruningDetails,
  PruningResult,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../../shared/protocol';
import type { TokenRateIndicatorState } from '../../../shared/token-rate';
import { buildContextWindowBreakdown } from '../context-window/breakdown';
import { buildContextWindowIndicatorState } from '../context-window/indicator';
import {
  buildCompletedCostSummary,
  extractSubagentCostSummary,
  buildLiveSessionCostEstimate,
  buildSessionCostIndicator,
  buildSessionTokenIndicator,
  buildSessionTokenUsage,
  type TokenPricing,
} from '../session-tabs/token-usage';
import {
  streamingContentSignature,
  subagentCostSignature,
  subagentToolCallRevision,
  systemPromptsSignature,
  transcriptUsageSignature,
} from './indicator-signature';
import { resolveComposerModelState } from './model-state';
import { useTokenRateIndicator } from './use-token-rate';

export function useComposerIndicators({
  activeModelId,
  activeProvider,
  activeThinkingLevel,
  modelSettings,
  availableModels,
  contextUsage,
  systemPrompts,
  transcript,
  transcriptWindow,
  pruningResult,
  busy,
  sessionPath,
  tokenRateBySession,
}: {
  activeModelId?: string;
  activeProvider?: string;
  activeThinkingLevel?: ThinkingLevel;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  contextUsage: ContextWindowUsage | null;
  systemPrompts: SystemPromptEntry[];
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  pruningResult: PruningResult | null;
  busy: boolean;
  sessionPath: string | null;
  tokenRateBySession: Record<string, TokenRateIndicatorState>;
}) {
  const {
    selectedModel,
    selectedProvider,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning,
  } = useMemo(() => resolveComposerModelState({
    activeModelId,
    activeProvider,
    activeThinkingLevel,
    modelSettings,
    availableModels,
  }), [activeModelId, activeProvider, activeThinkingLevel, modelSettings?.defaultModel, modelSettings?.defaultProvider, modelSettings?.defaultThinkingLevel, availableModels]);

  const modelPricing = useMemo(() => {
    const byProviderAndId = new Map<string, TokenPricing>();
    const uniqueById = new Map<string, TokenPricing>();
    const seenIds = new Set<string>();
    for (const model of availableModels) {
      const pricing = model.subagent?.pricing;
      if (pricing) byProviderAndId.set(`${model.provider}\0${model.id}`, pricing);
      if (seenIds.has(model.id)) {
        uniqueById.delete(model.id);
      } else {
        seenIds.add(model.id);
        if (pricing) uniqueById.set(model.id, pricing);
      }
    }
    return { byProviderAndId, uniqueById };
  }, [availableModels]);

  const supportsImageInputs = selectedModelInfo?.inputKinds.includes('image') ?? false;

  const effectiveContextWindow = contextUsage?.contextWindow ?? selectedModelInfo?.contextWindow ?? 0;
  const fallbackPricing = selectedModelInfo?.subagent?.pricing;

  // ── Cheap fingerprints (recomputed each snapshot, but O(1)/O(small)) that
  //    gate the O(transcript) walks below so they bail when only the streaming
  //    message grew. The host posts a structured-cloned ViewState ~7×/sec
  //    while streaming, so the transcript array (and every nested object) is a
  //    fresh reference on every snapshot even when byte-identical — keying a
  //    memo on the transcript ref would re-walk the whole transcript every
  //    tick. These signatures change iff the walk's result could change. See
  //    `indicator-signature.ts` for the correctness contract.
  //
  //    NOTE: `transcript` is intentionally NOT reference-stabilised upstream
  //    (its shape changes every snapshot while streaming, and a faithful
  //    content compare would be O(n) per tick) — hence the signatures here.
  //    `availableModels` IS now reference-stabilised upstream
  //    (`pickStableModelList` in `use-host-sync`), so the model-state and
  //    pricing-by-model-id memos above correctly key on the `availableModels`
  //    ref: pre-fix that ref was fresh every snapshot (recomputing both memos
  //    every tick); post-fix it is stable across snapshots whose model list
  //    didn't change, so those memos now skip their work as intended.
  const usageSig = useMemo(() => transcriptUsageSignature(transcript), [transcript]);
  const sysPromptsSig = useMemo(() => systemPromptsSignature(systemPrompts), [systemPrompts]);
  // When a live context-usage token count is reported, the breakdown's
  // used/remaining values come from the snapshot (not the growing transcript
  // estimate), so the streaming fingerprint is intentionally excluded → the
  // breakdown stays stable while only the streaming prose grows. When no token
  // count is reported, the fingerprint tracks the growing estimate so the
  // breakdown legitimately recomputes.
  const breakdownStreamSig = useMemo(
    () => (contextUsage?.tokens == null ? streamingContentSignature(transcript) : ''),
    [transcript, contextUsage?.tokens],
  );
  // Cheap O(toolCalls) revision that gates the O(result-tree)
  // `subagentCostSignature` walk. The host posts a structured-cloned transcript
  // ~7×/sec while streaming (fresh refs even when byte-identical), so keying the
  // fingerprint memo on the `transcript` ref would re-walk the multi-megabyte
  // subagent preview on every snapshot. The revision is built from each tool
  // call's monotonic `seq` (advances on every structural preview change,
  // including nested completions) and is stable while only streaming prose
  // grows — so the fingerprint memo skips its recursive walk on unchanged
  // snapshots without weakening correctness for nested completion changes.
  const subagentRev = useMemo(() => subagentToolCallRevision(transcript), [transcript]);
  const subagentSig = useMemo(() => subagentCostSignature(transcript), [subagentRev]);
  const liveStreamSig = useMemo(() => streamingContentSignature(transcript), [transcript]);

  const contextBreakdown = useMemo(
    () => effectiveContextWindow <= 0
      ? null
      : buildContextWindowBreakdown({
          contextUsage,
          effectiveContextWindow,
          systemPrompts,
          transcript,
          isPartial: transcriptWindow.isPartial,
        }),
    // Primitive/signature deps — NOT the raw object refs, which are fresh every
    // structured-cloned snapshot. Stable while the breakdown's content is
    // stable (e.g. contextUsage.tokens reported + only the streaming prose grew).
    // `subagentSig` (length + last-message tool-call transitions) captures
    // appends/removes and a read_file/skill tool call completing on the
    // streaming message even when contextUsage.tokens is reported, so the
    // breakdown's contributor rows don't go stale.
    [sessionPath, contextUsage?.tokens, contextUsage?.contextWindow, effectiveContextWindow, sysPromptsSig, breakdownStreamSig, subagentSig, transcriptWindow.isPartial],
  );
  const contextIndicator = useMemo(() => (
    contextBreakdown
      ? buildContextWindowIndicatorState(contextBreakdown.summary)
      : null
  ), [contextBreakdown]);
  const sessionTokenUsage = useMemo(() => buildSessionTokenUsage(transcript), [sessionPath, usageSig]);
  const sessionTokenIndicator = useMemo(
    () => buildSessionTokenIndicator(sessionTokenUsage),
    [sessionTokenUsage],
  );
  const liveCostEstimate = useMemo(
    () => buildLiveSessionCostEstimate(transcript, contextUsage, busy),
    [sessionPath, busy, contextUsage?.tokens, liveStreamSig],
  );

  // Stable pricing resolver so the completed-cost memo doesn't see a fresh
  // function ref every snapshot.
  const resolvePricing = useMemo(
    () => (modelId: string, provider?: string) => provider
      ? modelPricing.byProviderAndId.get(`${provider}\0${modelId}`)
      : modelPricing.uniqueById.get(modelId),
    [modelPricing],
  );

  // The O(transcript) completed-cost summary and subagent direct-cost walk are
  // memoized SEPARATELY from the live cost estimate. Their results are stable
  // while only the streaming message grows (no new usage, no new completed
  // subagent calls), but the live estimate grows every delta — so keying the
  // final cost indicator on these memoized refs keeps the per-delta recompute
  // O(1) (arithmetic + formatting) instead of re-walking the transcript.
  const completedCostSummary = useMemo(
    () => buildCompletedCostSummary(sessionTokenUsage, transcript, fallbackPricing, resolvePricing),
    [sessionTokenUsage, fallbackPricing, resolvePricing],
  );
  const subagentCostSummary = useMemo(
    () => extractSubagentCostSummary(transcript),
    [sessionPath, subagentSig],
  );
  const sessionCostIndicator = useMemo(
    () => buildSessionCostIndicator(
      sessionTokenUsage,
      fallbackPricing,
      selectedModelInfo?.name,
      completedCostSummary,
      subagentCostSummary,
      (pruningResult?.details as PruningDetails | undefined),
      resolvePricing,
      liveCostEstimate,
      selectedModel,
      selectedProvider,
    ),
    [sessionTokenUsage, fallbackPricing, selectedModelInfo?.name, completedCostSummary, subagentCostSummary, pruningResult, resolvePricing, liveCostEstimate, selectedModel, selectedProvider],
  );

  const tokenRateIndicator = useTokenRateIndicator({ sessionPath, tokenRateBySession });

  return {
    selectedModel,
    selectedProvider,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning,
    supportsImageInputs,
    contextBreakdown,
    contextIndicator,
    sessionTokenIndicator,
    sessionCostIndicator,
    tokenRateIndicator,
  };
}
