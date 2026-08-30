// Timing reporter: records per-test and per-process durations to JSONL, and
// emits the __PI_TEST_SUMMARY__ line the fast runner's mergeReports expects.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const out = `${process.env.TIMING_OUTPUT ?? path.join(os.tmpdir(), 'pie-test-timings.jsonl')}.${process.pid}`;
const startedAt = performance.now();

export default async function* consume(iterable) {
  const tests = [];
  for await (const event of iterable) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      tests.push({
        name: event.data.name,
        file: event.data.file ?? '',
        dur: event.data.details?.duration_ms ?? event.data.duration ?? 0,
        failed: event.type === 'test:fail',
      });
    }
  }
  appendFileSync(out, `${JSON.stringify({ type: 'global', durationMs: performance.now() - startedAt, tests })}\n`);
  const failed = tests.filter((t) => t.failed);
  process.stdout.write(`__PI_TEST_SUMMARY__${JSON.stringify({
    summary: { success: failed.length === 0, counts: { tests: tests.length, failed: failed.length, passed: tests.length - failed.length, cancelled: 0, skipped: 0, todo: 0, topLevel: 0, suites: 0 }, durationMs: performance.now() - startedAt },
    coverage: null,
    failures: failed.map((t) => ({ name: t.name, file: t.file, message: 'failed' })),
  })}\n`);
}
