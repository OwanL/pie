import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  ChatMessage,
  ContextWindowUsage,
  InitialContextEstimate,
  ModelInfo,
  ModelSettings,
  PruningDetails,
  PruningResult,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
  WorkingTimeState,
} from '../../../shared/protocol';
import type { TokenRateIndicatorState } from '../../../shared/token-rate';
import { stripProviderPrefix } from '../../../shared/model-id';
import type {
  ContextWindowBreakdown,
  ContextWindowBreakdownEntry,
  ContextWindowSummary,
} from '../context-window/breakdown';
import { buildContextWindowIndicatorState } from '../context-window/indicator';
import { buildInitialContextBreakdown } from '../context-window/initial-breakdown';
import {
  buildCompletedCostSummaryFromSnapshot,
  extractSubagentCostSummaryFromSnapshot,
  buildLiveSessionCostEstimate,
  buildSessionCostIndicator,
  buildSessionTokenIndicator,
  buildSessionTokenUsageFromSnapshot,
  type TokenPricing,
} from '../session-tabs/token-usage';
import {
  sessionUsageSignature,
  type SessionUsageSnapshot,
} from '../../../shared/session-usage';
import {
  contextBreakdownTranscriptSignature,
  streamingContentSignature,
  systemPromptsSignature,
} from './indicator-signature';
import { resolveComposerModelState } from './model-state';
import { useTokenRateIndicator } from './use-token-rate';
import { useWorkingTimeIndicator } from './use-working-time';
import contextBreakdownWorkerUrl from '../context-window/breakdown-worker?worker&url';
import { documentAllowsContextBreakdownWorker } from '../context-window/worker-policy';

function formatDeferredTokens(tokens: number | null): string {
  return tokens === null ? 'unknown' : tokens.toLocaleString('en-US');
}

/** Cheap first-paint context state. Contributor BPE tokenization is completed
 * off the main thread; exact provider totals remain visible immediately. */
function buildDeferredContextBreakdown(
  contextUsage: ContextWindowUsage | null,
  effectiveContextWindow: number,
): ContextWindowBreakdown {
  const usedTokens = contextUsage?.tokens ?? null;
  const totalWindow = contextUsage?.contextWindow ?? effectiveContextWindow;
  const remainingTokens = usedTokens === null || totalWindow <= 0
    ? null
    : Math.max(totalWindow - usedTokens, 0);
  const summary: ContextWindowSummary = {
    usedTokens,
    usedKind: usedTokens === null ? 'unknown' : 'exact',
    remainingTokens,
    remainingKind: remainingTokens === null ? 'unknown' : 'exact',
    totalWindow,
  };
  const footerEntries: ContextWindowBreakdownEntry[] = [
    { key: 'window.used', label: 'Used', value: formatDeferredTokens(usedTokens), kind: summary.usedKind, tokens: usedTokens },
    { key: 'window.remaining', label: 'Remaining', value: formatDeferredTokens(remainingTokens), kind: summary.remainingKind, tokens: remainingTokens },
    { key: 'window.total', label: 'Total', value: totalWindow > 0 ? formatDeferredTokens(totalWindow) : 'unknown', kind: totalWindow > 0 ? 'exact' : 'unknown', tokens: totalWindow > 0 ? totalWindow : null },
  ];
  const notes = ['Contributor breakdown is being calculated in the background.'];
  return {
    entries: [],
    footerEntries,
    summary,
    notes,
    title: `Context window usage\nUsed: ${formatDeferredTokens(usedTokens)}\nRemaining: ${formatDeferredTokens(remainingTokens)}\nTotal: ${formatDeferredTokens(totalWindow > 0 ? totalWindow : null)}\n\nNote: ${notes[0]}`,
  };
}

export function useComposerIndicators({
  activeModelId,
  activeProvider,
  activeThinkingLevel,
  modelSettings,
  availableModels,
  contextUsage,
  initialContextEstimate,
  systemPrompts,
  transcript,
  transcriptWindow,
  sessionUsage,
  pruningResult,
  busy,
  sessionPath,
  tokenRateBySession,
  workingTimeBySession,
}: {
  activeModelId?: string;
  activeProvider?: string;
  activeThinkingLevel?: ThinkingLevel;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  contextUsage: ContextWindowUsage | null;
  initialContextEstimate: InitialContextEstimate | null;
  systemPrompts: SystemPromptEntry[];
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  sessionUsage?: SessionUsageSnapshot | null;
  pruningResult: PruningResult | null;
  busy: boolean;
  sessionPath: string | null;
  tokenRateBySession: Record<string, TokenRateIndicatorState>;
  workingTimeBySession: Record<string, WorkingTimeState>;
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

  const effectiveContextWindow = contextUsage?.contextWindow
    ?? selectedModelInfo?.contextWindow
    ?? initialContextEstimate?.contextWindow
    ?? 0;
  const fallbackPricing = selectedModelInfo?.subagent?.pricing;

  // ── Bounded fingerprints that gate the O(transcript) walks below. The host
  //    posts a structured-cloned ViewState ~7×/sec while streaming, so the
  //    transcript array (and every nested object) is a fresh reference on each
  //    snapshot even when byte-identical. These signatures keep key material
  //    bounded and change whenever a guarded result could change. Live/durable
  //    records use lengths or revisions; legacy body-only records use hashes.
  //
  //    NOTE: `transcript` is intentionally NOT reference-stabilised upstream;
  //    the signatures here provide the correctness boundary without retaining
  //    large prompt/tool bodies in React memo keys.
  //    `availableModels` IS now reference-stabilised upstream
  //    (`pickStableModelList` in `use-host-sync`), so the model-state and
  //    pricing-by-model-id memos above correctly key on the `availableModels`
  //    ref: pre-fix that ref was fresh every snapshot (recomputing both memos
  //    every tick); post-fix it is stable across snapshots whose model list
  //    didn't change, so those memos now skip their work as intended.
  const sysPromptsSig = useMemo(() => systemPromptsSignature(systemPrompts), [systemPrompts]);
  // This digest covers every transcript field read by the breakdown builder,
  // including generic tool inputs/results and their live seq revisions. It is
  // deliberately fixed-size even when a transcript contains large previews.
  const breakdownTranscriptSig = useMemo(
    () => contextBreakdownTranscriptSignature(transcript),
    [transcript],
  );
  const liveStreamSig = useMemo(() => streamingContentSignature(transcript), [transcript]);

  const breakdownKey = `${sessionPath ?? ''}\0${contextUsage?.tokens ?? ''}\0${contextUsage?.contextWindow ?? ''}\0${initialContextEstimate?.tokens ?? ''}\0${initialContextEstimate?.contextWindow ?? ''}\0${effectiveContextWindow}\0${sysPromptsSig}\0${breakdownTranscriptSig}\0${transcriptWindow.isPartial ? 1 : 0}`;
  const deferredBreakdown = useMemo(
    () => effectiveContextWindow <= 0
      ? null
      : buildDeferredContextBreakdown(contextUsage, effectiveContextWindow),
    // This is only the cheap, immediately renderable provider-total shell. The
    // full contributor signatures above gate the background worker separately.
    [contextUsage?.tokens, contextUsage?.contextWindow, effectiveContextWindow],
  );
  const [computedBreakdown, setComputedBreakdown] = useState<{
    key: string;
    value: ContextWindowBreakdown;
  } | null>(null);
  const breakdownWorkerRef = useRef<Worker | null>(null);
  const breakdownRequestIdRef = useRef(0);

  // `breakdownKey` is the deliberate primitive/signature dependency: host
  // snapshots are structured-cloned, so their object identities change even
  // when the breakdown inputs do not.
  useEffect(() => {
    if (effectiveContextWindow <= 0 || initialContextEstimate) return;
    const requestId = ++breakdownRequestIdRef.current;
    let cancelled = false;
    const options = {
      contextUsage,
      effectiveContextWindow,
      systemPrompts,
      transcript,
      isPartial: transcriptWindow.isPartial,
    };
    const complete = (value: ContextWindowBreakdown) => {
      if (!cancelled && requestId === breakdownRequestIdRef.current) {
        setComputedBreakdown({ key: breakdownKey, value });
      }
    };
    const computeOnMainThreadFallback = () => {
      void import('../context-window/breakdown').then(({ buildContextWindowBreakdown }) => {
        complete(buildContextWindowBreakdown(options));
      });
    };

    if (typeof Worker === 'undefined' || !documentAllowsContextBreakdownWorker()) {
      computeOnMainThreadFallback();
      return () => { cancelled = true; };
    }

    let worker = breakdownWorkerRef.current;
    try {
      const relativeWorkerUrl = contextBreakdownWorkerUrl.replace(/^\/assets\//, './');
      worker ??= new Worker(new URL(relativeWorkerUrl, import.meta.url), {
        type: 'module',
        name: 'pie-context-breakdown',
      });
      breakdownWorkerRef.current = worker;
    } catch {
      computeOnMainThreadFallback();
      return () => { cancelled = true; };
    }

    const onMessage = (event: MessageEvent<{ id: number; breakdown?: ContextWindowBreakdown }>) => {
      if (event.data.id !== requestId) return;
      if (event.data.breakdown) complete(event.data.breakdown);
      else computeOnMainThreadFallback();
    };
    const onError = () => {
      if (cancelled || requestId !== breakdownRequestIdRef.current) return;
      worker?.terminate();
      if (breakdownWorkerRef.current === worker) breakdownWorkerRef.current = null;
      computeOnMainThreadFallback();
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError, { once: true });
    worker.postMessage({ id: requestId, options });
    return () => {
      cancelled = true;
      worker?.removeEventListener('message', onMessage);
      worker?.removeEventListener('error', onError);
    };
  }, [breakdownKey]);

  useEffect(() => () => {
    breakdownWorkerRef.current?.terminate();
    breakdownWorkerRef.current = null;
  }, []);

  const initialBreakdown = useMemo(
    () => initialContextEstimate
      ? buildInitialContextBreakdown(initialContextEstimate, effectiveContextWindow)
      : null,
    [initialContextEstimate?.tokens, initialContextEstimate?.contextWindow, effectiveContextWindow],
  );
  const contextBreakdown = effectiveContextWindow <= 0
    ? null
    : initialBreakdown
      ?? (computedBreakdown?.key === breakdownKey
        ? computedBreakdown.value
        : deferredBreakdown);
  const contextIndicator = useMemo(() => (
    contextBreakdown
      ? buildContextWindowIndicatorState(contextBreakdown.summary)
      : null
  ), [contextBreakdown]);
  // `sessionUsage` is structured-cloned with every host snapshot. Fingerprint
  // its flat samples so equal-content clones do not reopen the recursive
  // transcript/subagent accounting walk on every streaming tick.
  const durableUsageSig = useMemo(() => sessionUsageSignature(sessionUsage), [sessionUsage]);
  const effectiveSessionUsage = useMemo(
    // Ledger state is the sole steady-state authority. An old/unavailable host
    // is explicit unknown; transcript rows are never promoted into accounting.
    () => sessionUsage ?? { samples: [], authority: 'unknown' as const },
    [sessionPath, durableUsageSig],
  );
  const sessionTokenUsage = useMemo(
    () => buildSessionTokenUsageFromSnapshot(effectiveSessionUsage),
    [effectiveSessionUsage],
  );
  const sessionTokenIndicator = useMemo(
    () => buildSessionTokenIndicator(sessionTokenUsage),
    [sessionTokenUsage],
  );
  const liveCostEstimate = useMemo(
    () => buildLiveSessionCostEstimate(transcript, contextUsage, busy),
    [sessionPath, busy, contextUsage?.tokens, liveStreamSig],
  );

  // Stable pricing resolver so the completed-cost memo doesn't see a fresh
  // function ref every snapshot. Provider-qualified ids (subagent/child usage
  // records e.g. `ollama/glm-5.2:cloud`) are normalized to their bare id so
  // the registry key (`provider\u0000id`) matches; without this the lookup
  // misses and child cost falls back to zero/unpriced.
  const resolvePricing = useMemo(
    () => (modelId: string, provider?: string) => {
      const bareId = stripProviderPrefix(modelId);
      return provider
        ? modelPricing.byProviderAndId.get(`${provider}\u0000${bareId}`)
        : modelPricing.uniqueById.get(bareId);
    },
    [modelPricing],
  );

  // The O(transcript) completed-cost summary and subagent direct-cost walk are
  // memoized SEPARATELY from the live cost estimate. Their results are stable
  // while only the streaming message grows (no new usage, no new completed
  // subagent calls), but the live estimate grows every delta — so keying the
  // final cost indicator on these memoized refs keeps the per-delta recompute
  // O(1) (arithmetic + formatting) instead of re-walking the transcript.
  const completedCostSummary = useMemo(
    () => buildCompletedCostSummaryFromSnapshot(effectiveSessionUsage, fallbackPricing, resolvePricing),
    [effectiveSessionUsage, fallbackPricing, resolvePricing],
  );
  const subagentCostSummary = useMemo(
    () => extractSubagentCostSummaryFromSnapshot(effectiveSessionUsage, resolvePricing),
    [effectiveSessionUsage, resolvePricing],
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
      effectiveSessionUsage,
    ),
    [sessionTokenUsage, fallbackPricing, selectedModelInfo?.name, completedCostSummary, subagentCostSummary, pruningResult, resolvePricing, liveCostEstimate, selectedModel, selectedProvider, effectiveSessionUsage],
  );

  const tokenRateIndicator = useTokenRateIndicator({ sessionPath, tokenRateBySession });
  const workingTimeIndicator = useWorkingTimeIndicator({ sessionPath, workingTimeBySession });

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
    workingTimeIndicator,
  };
}
