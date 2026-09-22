import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type {
  ChatMessage,
  CanonicalActivityView,
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
import type {
  ContextWindowBreakdown,
  ContextWindowBreakdownEntry,
  ContextWindowSummary,
} from '../context-window/breakdown';
import { buildContextWindowIndicatorState } from '../context-window/indicator';
import { buildInitialContextBreakdown } from '../context-window/initial-breakdown';
import {
  buildCanonicalSessionActivitySummary,
  buildCompletedCostSummaryFromSnapshot,
  extractSubagentCostSummaryFromSnapshot,
  buildLiveSessionCostEstimate,
  buildSessionCostIndicator,
  buildSessionTokenUsageFromSnapshot,
  canonicalActivitySignature,
  createTokenPricingResolver,
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
  canonicalActivityBySession,
  canonicalActivityBySessionTruncated,
  canonicalRootSessionId,
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
  /** Optional host canonical activity/facet cache read for visible sessions.
   *  Absent under legacy analytics authority — nothing canonical renders. */
  canonicalActivityBySession?: Record<string, CanonicalActivityView>;
  canonicalActivityBySessionTruncated?: boolean;
  /** The active session's stable root identity from current view session
   *  metadata (host-owned `SessionSummary.sessionId`, null when unavailable or
   *  an identity fallback). Canonical entries bind to it; without it nothing
   *  canonical renders — identity is never inferred from the pathname. */
  canonicalRootSessionId?: string | null;
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
    // is explicit unknown; transcript rows are never substituted. Pending
    // provider observations are a bounded handoff overlay, not durable rows.
    () => {
      if (!sessionUsage) return { samples: [], authority: 'unknown' as const };
      const durableIds = new Set<string>();
      for (const sample of sessionUsage.samples) {
        if (sample.canonicalInvocationId) durableIds.add(sample.canonicalInvocationId);
        durableIds.add(sample.sourceId);
      }
      // A matched pending row can remain in the transport briefly as a
      // handoff marker while its runtime message is still streaming. It must
      // suppress the live estimator, but it must not be counted beside the
      // already-visible canonical row.
      const pending = (sessionUsage.pendingSamples ?? []).filter((sample) => (
        !sample.canonicalInvocationId || !durableIds.has(sample.canonicalInvocationId)
      ));
      return pending.length === 0
        ? sessionUsage
        : { ...sessionUsage, samples: [...sessionUsage.samples, ...pending] };
    },
    [sessionPath, durableUsageSig],
  );
  const sessionTokenUsage = useMemo(
    () => buildSessionTokenUsageFromSnapshot(effectiveSessionUsage),
    [effectiveSessionUsage],
  );
  const liveOutputTokens = sessionPath === null || sessionPath === undefined
    ? undefined
    : tokenRateBySession[sessionPath]?.liveOutputTokens;
  const pendingStreamingMessageIds = useMemo(
    () => sessionUsage?.pendingSamples
      ?.map((sample) => sample.provisionalMessageId)
      .filter((messageId): messageId is string => Boolean(messageId)),
    [durableUsageSig],
  );
  const liveCostEstimate = useMemo(
    () => buildLiveSessionCostEstimate(
      transcript,
      contextUsage,
      busy,
      liveOutputTokens,
      pendingStreamingMessageIds,
    ),
    [sessionPath, busy, contextUsage?.tokens, liveStreamSig, liveOutputTokens, durableUsageSig],
  );

  // Stable pricing resolver so the completed-cost memo doesn't see a fresh
  // function ref every snapshot. Provider-qualified ids are normalized by the
  // shared resolver used by transcript display as well.
  const resolvePricing = useMemo(
    () => createTokenPricingResolver(availableModels),
    [availableModels],
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

  // The canonical activity/facet read is a host-bounded optional snapshot field;
  // sign it so equal-content structured clones keep the memoized summary and the
  // tooltip props stay reference-stable across streaming snapshots. The active
  // session's stable root identity is part of the signature: address/root changes
  // can never reuse a valid memo.
  const canonicalActivitySig = useMemo(
    () => canonicalActivitySignature(
      sessionPath,
      canonicalRootSessionId ?? null,
      canonicalActivityBySession,
      canonicalActivityBySessionTruncated,
    ),
    [sessionPath, canonicalRootSessionId, canonicalActivityBySession, canonicalActivityBySessionTruncated],
  );
  const canonicalActivitySummary = useMemo(
    () => buildCanonicalSessionActivitySummary(
      sessionPath,
      canonicalRootSessionId ?? null,
      canonicalActivityBySession,
      canonicalActivityBySessionTruncated,
    ),
    // Signature-gated like `durableUsageSig`: recompute only when a displayed
    // canonical input changes (live ViewState updates and session switches).
    [canonicalActivitySig],
  );

  return {
    selectedModel,
    selectedProvider,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning,
    supportsImageInputs,
    contextBreakdown,
    contextIndicator,
    sessionCostIndicator,
    canonicalActivitySummary,
    tokenRateIndicator,
    workingTimeIndicator,
  };
}
