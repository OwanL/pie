export function actionDurationMs(action) {
  return action.kind === 'wait' || action.kind === 'move' || action.kind === 'drag' ? (action.durationMs ?? 0) : 0;
}

export function estimateSequenceDuration(sequence) {
  let elapsedMs = 0;
  for (const step of sequence.actions) elapsedMs = Math.max(elapsedMs, step.atMs) + actionDurationMs(step.action);
  return elapsedMs;
}

export function abortError() {
  const error = new Error('Computer request was cancelled.');
  error.code = 'CANCELLED';
  return error;
}

export function abortableSleep(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { signal?.removeEventListener('abort', cancelled); resolve(); }
    function cancelled() { clearTimeout(timer); signal?.removeEventListener('abort', cancelled); reject(abortError()); }
    signal?.addEventListener('abort', cancelled, { once: true });
  });
}

export const monotonicClock = { now: () => performance.now(), sleep: abortableSleep };

export async function runTimedSequence(sequence, executeAction, options = {}) {
  const clock = options.clock ?? monotonicClock;
  const signal = options.signal;
  const start = clock.now();
  const trace = [];
  for (let index = 0; index < sequence.actions.length; index += 1) {
    const step = sequence.actions[index];
    if (signal?.aborted) throw abortError();
    const remaining = start + step.atMs - clock.now();
    if (remaining > 0) await clock.sleep(remaining, signal);
    if (signal?.aborted) throw abortError();
    const begun = clock.now() - start;
    const item = { index, atMs: step.atMs, startedAtMs: begun, kind: step.action.kind };
    try {
      await executeAction(step.action, { signal, sequenceStart: start, scheduledAtMs: step.atMs });
      item.completedAtMs = clock.now() - start;
      item.status = 'ok'; trace.push(item);
    } catch (error) {
      item.completedAtMs = clock.now() - start;
      item.status = 'error'; item.error = error instanceof Error ? error.message : String(error); trace.push(item);
      error.sequenceTrace = trace;
      throw error;
    }
  }
  return trace;
}
