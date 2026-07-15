export function evaluatePlan(requests, limits, batches) {
  const byId = new Map(requests.map(r => [r.id, r]));
  const seen = new Set(); let now = 0, useful = 0, possible = 0, computeMs = 0;
  for (const request of requests) possible += request.priority * (request.inputTokens + request.outputTokens);
  for (const ids of batches) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > limits.maxBatch) return invalid("batch_size");
    const batch = ids.map(id => byId.get(id));
    if (batch.some(r => !r) || new Set(batch.map(r => r.model)).size !== 1) return invalid("unknown_or_mixed_model");
    if (batch.some(r => seen.has(r.id))) return invalid("duplicate_request");
    const prefill = batch.reduce((n, r) => n + r.inputTokens, 0);
    if (prefill > limits.prefillTokenBudget) return invalid("prefill_budget");
    batch.forEach(r => seen.add(r.id));
    now = Math.max(now, ...batch.map(r => r.arrivalMs));
    const maxInput = Math.max(...batch.map(r => r.inputTokens));
    const maxOutput = Math.max(...batch.map(r => r.outputTokens));
    const duration = limits.setupMs + maxInput * limits.prefillMsPerToken + maxOutput * limits.decodeMsPerToken * (1 + (batch.length - 1) * 0.18);
    now += duration; computeMs += duration;
    for (const r of batch) if (now <= r.deadlineMs) useful += r.priority * (r.inputTokens + r.outputTokens);
  }
  if (seen.size !== requests.length) return invalid("missing_request");
  const deadlineUtility = possible ? useful / possible : 1;
  const serialMs = requests.reduce((n,r)=>n+limits.setupMs+r.inputTokens*limits.prefillMsPerToken+r.outputTokens*limits.decodeMsPerToken,0);
  const computeEfficiency = Math.min(1, serialMs / Math.max(1, computeMs * limits.maxBatch));
  return {valid:true, quality:0.82*deadlineUtility+0.18*computeEfficiency, metrics:{deadlineUtility,computeEfficiency,computeMs}};
}
function invalid(reason){return{valid:false,quality:0,metrics:{reason}};}
