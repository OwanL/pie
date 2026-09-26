# API-equivalent cost audit, 2026-09-23

## Acceptance status

**The historical analytics totals are not certified within 10% of equivalent API spend.** Source fixes improve new capture; they cannot recover missing usage or silently correct historical settlements. API-equivalent value is not a subscription invoice or incremental account charge.

The canonical activation manifest inspected during this audit records an active generation. Database inspection was read-only, using normalized canonical facts, not transcript or legacy-ledger aggregates. No historical analytics were rewritten.

## Historical evidence

One consistent read snapshot (schema 13, projection revision 103098) contained 61,535 settlement rows:

| Effective cost evidence | Rows |
| --- | ---: |
| Unknown | 36,973 |
| Catalog calculated | 1,741 |
| Reported | 22,821 |

The known-cost subtotal was approximately $277.82; it is **not a complete spend estimate**. Settlement rows are not necessarily unique real provider calls: this audit also identified transcript rehydration/copy capture duplication.

Of the unknown-cost rows, 36,962 were subagent settlements. 20,618 had apparently complete normalized channels. Further producer-scoped investigation separated two causes: child settlements lacking catalog pricing snapshots, and host gap records whose zero placeholders had incorrectly acquired complete-channel status. Counts from subsequent investigation differ because capture continued during the audit.

8,057 reported-cost rows also had a complete catalog calculation: their reported subtotal was $114.09 versus $138.94 calculated. 33 rows differed by more than 10%; these were dated September 14 or undated. The other 14,764 reported rows had no complete calculated comparison. A reported provenance label does not independently establish invoice accuracy, especially for historical SDK estimates.

## Source remedies

- Child-owned subagent settlements receive provider-qualified catalog rate snapshots when usage is complete. The recorder computes cost from those channels and rates.
- Missing token channels stay unknown rather than being promoted from zero placeholders.
- Canonical session-open snapshots retain ancestry bookkeeping but no longer reconstruct provider settlements from transcripts. Legacy migration remains separate.
- Incomplete calculated costs are withheld from the session-usage display.
- Provider mismatches cannot borrow another provider's unique catalog rate. Child pricing cache invalidation and content identity include the historical catalog.
- Required input/output prices and advertised context tiers must be valid; missing billable prices cannot become free pricing. Copilot discovery preserves its previous catalog rather than publishing an incomplete pricing refresh.
- Verified exact Ollama models use current official rates. DeepSeek weekday peak pricing uses observed request intervals; missing times or intervals whose endpoints cross a price band remain unpriced. Models without a published cache-read price cannot price positive cache-read usage as free. See [pricing sources](model-token-pricing-sources.md).
- Aborted auxiliary requests preserve cancellation classification and missing-usage evidence.

Regression coverage exercises capture-to-recorder cost calculation, live settlement versus historical snapshot handling, provider qualification, missing-price rejection, partial-cost display, pricing-cache refresh, scheduled boundaries, and unsupported cached-input pricing.

## Deployment status

The initial final publication attempt was blocked by an unrelated test import. That blocker was subsequently resolved by the coordinated baseline work: commit `18516b32` was pushed and its build staged. Persistent backend startup evidence at **2026-09-23T20:13:53.332Z** shows runtime generation `f1ec94d34cbe29b91c833b63e45d3a2737c126d84cacb1b9cb2905ecbc846ab2` running. Runtime build generation and analytics activation generation are distinct identities; an unchanged analytics generation is expected across runtime updates.

### Post-restart validation

Read-only canonical snapshots restricted to settlements since that startup showed:

- At projection revision **112111**, 51 settlements all had complete normalized channels and calculated costs. An independent per-invocation four-channel calculation, preserving integer tokens and applying context tiers individually, matched all 33 static-rate invocations to floating-point precision. The 18 scheduled-rate invocations were excluded from this independent comparison because the normalized usage view lacks request intervals.
- At projection revision **113620** (2026-09-23T21:05:20Z), all **887 captured settlements** had known costs and complete normalized channels. No repeated non-null source IDs were found among those settlements, including across root sessions.
- At projection revision **113656**, all **24 producer origins contributing fresh settlements** had reconciliation records with no visible sequence gaps. These are separate live snapshots, not one atomic combined result.

This establishes improved captured-row coverage, not independent invoice reconciliation or proof that no provider request went unobserved before capture. Historical reconciliation gaps remain separate from this fresh sample.

### Follow-up timing defect

Inspection of fresh scheduled-price observations found equal start/end stamps. The pinned SDK creates the assistant timestamp before its request and reuses it on the final message: it is not a completion timestamp. Subagent capture had incorrectly treated it as one. Host conversation capture also used it as settlement time, then inferred a start by subtracting duration. These errors can choose the wrong peak/off-peak band at a boundary even though the arithmetic is correct.

The follow-up host fix captures the actual terminal-event clock and carries independent start evidence; scheduled pricing no longer synthesizes missing intervals from duration or legacy prepass aggregate timestamps. Successful auxiliary calls now forward their already-measured start explicitly. Focused regression tests cover repeated SDK timestamps and peak-boundary crossings. After migration commit `8691b480`, the equivalent `tools/subagent/runner.ts` fix was applied: completion is measured at the actual terminal event, while a missing request start stays unknown. Its regression passes identical SDK creation timestamps on both events and verifies that an actual boundary-crossing interval remains unpriced.

The complete follow-up passed the full fast suite and build. Runtime `ea221d9a04a22c67f868b29b9be9eea88d1c98a814a383c6c120456b46d6d527` was subsequently verified running from backend startup evidence at **2026-09-23T21:49:05.494Z**. A post-restart smoke sample contained 12 subagent invocations with positive measured intervals (3,877–48,753 ms), no repeated source IDs, and no visible gaps for its contributing producer origins. The default affected-test launcher hit Windows `spawn ENAMETOOLONG`; the full-suite runner avoided that argument-list limit and completed successfully. That launcher issue is separate from analytics correctness.

### Equivalent API spend verification after loading the fix

At projection revision **115786**, filtering source settlement time at or after **2026-09-23T21:49:05.494Z** gives **265 invocations: 264 priced and one cancelled invocation with unknown usage**. Independent four-channel arithmetic with per-invocation context tiers reproduces the catalog-calculated sum **$7.87472112**, with only floating-point noise per row. Complete rows conserve provider totals and normalized channels. No scheduled-price model occurs in this sample.

Official current model/pricing pages were checked for the sampled OpenAI, GitHub Copilot, and Ollama models. One discrepancy was found: Copilot `gpt-6-luna` base cache-write is configured as $0.12/M, versus published $0.125/M. The sample has **89,170** affected cache-write tokens, all below the long-context threshold. Correcting that component yields **$7.87516697**, a difference of **$0.00044585 (0.00566%)**. Ollama GLM cache-write usage is explicitly zero throughout its 83 sampled invocations, so its unpublished write rate does not affect this comparison.

Sources: https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing ; https://developers.openai.com/api/docs/models/gpt-6-astra ; https://developers.openai.com/api/docs/models/gpt-6-luna ; https://ollama.com/pricing . These are current equivalent per-token prices, not subscription invoice amounts or historical rate evidence.

**Result: the captured, priced post-restart sample is within the requested 10% of published equivalent API pricing.** This does not bound the cancelled invocation's missing usage or prove that every upstream request was captured. The 89 undated settlements in the frozen store were all committed before this restart and are not part of the fresh sample. Historical totals remain uncertified. No database records were changed; the small catalog discrepancy is recorded here, not silently repaired retroactively.

## Remaining evidence and repair requirements

1. Deployment and the bounded fresh equivalent-price comparison above are complete; an invoice is not required for that comparison.
2. A universal total-spend bound still requires coverage evidence for missing usage and unobserved requests. Do not extend the priced-sample result to unknown costs, unexercised scheduled models, or historical totals.
3. Historical correction needs a separately approved, auditable operation under the analytics implementation contract: retain original source facts, prior/replacement provenance, invocation/source identities, applicable historical rates, and correction reasons. Current rates must not be applied retroactively as if they were historical rates.
4. Missing historical tokens cannot be recovered by assigning zero or by transcript reconstruction. Historical duplicate inherited settlements require evidence-based correction, not blanket source-ID deduplication across unrelated executions.
5. Static comparison rates for models without exact official provider pricing remain estimates; no universal 10% guarantee follows from them. Scheduled requests lacking reliable timestamps deliberately remain unknown.
