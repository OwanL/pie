# Atlas queue replay

Small extraction of the queue scheduler used for offline incident replay. Run `npm test` and `npm run benchmark`.

`planBatches(requests, limits)` receives requests with required `id`, `model`, `inputTokens`, `outputTokens`, `arrivalMs`, `priority`, and `deadlineMs` fields. Every request must appear exactly once in the returned ID batches.

> Historical note: workers batch up to **8** requests and enforce a combined input/output token ceiling. This predates the prefill/decode split and may not describe the current sidecar.

Generated replay summaries under `generated/` are checked in for the operations dashboard; do not hand-edit them.
