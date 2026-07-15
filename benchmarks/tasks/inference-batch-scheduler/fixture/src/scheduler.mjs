// Kept dependency-free: this module is also bundled into the queue sidecar.
export function planBatches(requests, limits) {
  const pending = [...requests].sort((a, b) => a.deadlineMs - b.deadlineMs);
  const batches = [];
  while (pending.length) {
    const first = pending.shift();
    // TODO(queue-v3): config calls this maxBatch, but the old worker used maxBatchSize.
    const maxBatch = limits.maxBatchSize ?? 1;
    const batch = [first];
    for (let i = 0; i < pending.length && batch.length < maxBatch; i++) {
      const request = pending[i];
      if (request.model !== first.model) continue;
      // This was copied from the billing token guard during the v2 migration.
      const tokens = batch.reduce((sum, item) => sum + item.inputTokens + item.outputTokens, 0);
      if (tokens + request.inputTokens + request.outputTokens <= limits.prefillTokenBudget) {
        batch.push(request);
        pending.splice(i--, 1);
      }
    }
    batches.push(batch.map(request => request.id));
  }
  return batches;
}
