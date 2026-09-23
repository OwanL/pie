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

The final publication attempt was blocked by a TypeScript import error in the concurrently added `extension/test/host/core/detail-routing-seam.test.ts`: it imports `LazyDetailRef` from `shared/protocol/subagent-detail`, which does not export that type. The complete final changes have therefore not been verified as staged or loaded. Earlier partial builds are not evidence of deployment of this final change set. The unrelated in-progress test was left untouched.

## Remaining evidence and repair requirements

1. Load a successful build containing all fixes and collect a new bounded sample. Build success alone is not evidence that the running backend uses the fixes.
2. Reconcile new settlements by provider/model/purpose against independent provider usage evidence, including failures and retries. Check cost coverage and producer reconciliation gaps alongside known totals. Do not declare a 10% bound from arithmetic tests alone.
3. Historical correction needs a separately approved, auditable operation under the analytics implementation contract: retain original source facts, prior/replacement provenance, invocation/source identities, applicable historical rates, and correction reasons. Current rates must not be applied retroactively as if they were historical rates.
4. Missing historical tokens cannot be recovered by assigning zero or by transcript reconstruction. Historical duplicate inherited settlements require evidence-based correction, not blanket source-ID deduplication across unrelated executions.
5. Static comparison rates for models without exact official provider pricing remain estimates; no universal 10% guarantee follows from them. Scheduled requests lacking reliable timestamps deliberately remain unknown.
