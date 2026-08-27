/**
 * Session-store performance harness for pie.
 *
 * Spawns the REAL backend process (out/backend.js, coordinator role) and times
 * the cold session RPCs the GUI performs on startup and tab switches:
 *
 *   session.list (first request + same-process repeat + process restart),
 *   session.open (projection-cache miss + metadata-only cache hit),
 *   session.preload, session.loadTranscriptPage (latest + a backward walk)
 *
 * This measures pi's session handling end to end: the SQLite metadata index,
 * the SDK SessionManager single-read open seam, pie's bounded manager-free
 * browse-projection cache, snapshot envelope build, and stdio serialization.
 * A raw JSONL parse-rate section afterwards gives the floor for attribution.
 *
 * SAFETY: transcript-read-only, not filesystem-write-free. All open/preload/
 * page runs use a throwaway COPY of sampled sessions, and write RPC methods
 * fail fast (see backend-probe WRITE_METHOD_BLOCKLIST). session.list reads the
 * real transcript store but may create/update its rebuildable
 * `.pie-session-index-v*.sqlite` sidecar beside that store. It never writes a
 * real transcript JSONL.
 *
 * Run:   npx tsx ./test/perf/session-store.perf.ts   (from extension/)
 * Not swept by `npm test` (*.perf.ts). Writes ./test/perf/reports/.
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';

import {
  BACKEND_PATH,
  SDK_PATH,
  SESSION_DIR,
  HERE,
  REPO_ROOT,
  copySamplesToTempStore,
  sampleSessions,
  spawnBackend,
  type BackendHandle,
  type Sample,
} from './backend-probe';

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

function fmtBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MiB` : `${(bytes / 1024).toFixed(0)}KiB`;
}

function gitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8', cwd: REPO_ROOT }).trim();
  } catch {
    return 'unknown';
  }
}

interface ParseFloor {
  path: string;
  bytes: number;
  lines: number;
  parseMs: number;
  mibPerSec: number;
}

interface CatalogProgressEvent {
  sessions?: unknown[];
  sessionCatalogProgress?: {
    complete?: boolean;
    processed?: number;
    total?: number;
  };
}

async function waitForCatalogCompletion(
  backend: BackendHandle,
  initialCount: number,
): Promise<{
  supported: boolean;
  reconcileMs?: number;
  maxPingMs?: number;
  finalCount: number;
  progress?: CatalogProgressEvent['sessionCatalogProgress'];
}> {
  const startedAt = performance.now();
  let maxPingMs = 0;
  let finalCount = initialCount;
  let observedProgress = false;
  while (performance.now() - startedAt < 300_000) {
    const payload = backend.lastEvent.get('session.list.changed') as CatalogProgressEvent | undefined;
    const progress = payload?.sessionCatalogProgress;
    if (progress) {
      observedProgress = true;
      finalCount = payload?.sessions?.length ?? finalCount;
      if (progress.complete === true) {
        return {
          supported: true,
          reconcileMs: performance.now() - startedAt,
          maxPingMs,
          finalCount,
          progress,
        };
      }
    } else if (performance.now() - startedAt > 1_000) {
      return { supported: false, finalCount };
    }
    const ping = await backend.request<unknown>('app.ping', {});
    maxPingMs = Math.max(maxPingMs, ping.ms);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`session catalog did not complete within 300s (progress observed: ${observedProgress})`);
}

function rawParseFloor(sample: Sample): ParseFloor {
  const text = readFileSync(sample.path, 'utf8');
  const lines = text.split('\n');
  const t0 = performance.now();
  let count = 0;
  for (const line of lines) {
    if (line.trim()) { JSON.parse(line); count += 1; }
  }
  const parseMs = performance.now() - t0;
  return {
    path: sample.name,
    bytes: sample.bytes,
    lines: count,
    parseMs,
    mibPerSec: (sample.bytes / 1024 / 1024) / (parseMs / 1000),
  };
}

async function main(): Promise<void> {
  console.log('pie session-store perf harness (transcript-read-only; opens run on a copy of the store)');
  console.log('note: session.list may create/update a rebuildable SQLite index sidecar beside the real store');
  console.log(`session dir: ${SESSION_DIR}`);
  console.log(`backend: ${BACKEND_PATH}`);
  const samples = sampleSessions();
  console.log(`sampled sessions: ${samples.length}`);

  const results: Record<string, unknown> = {};
  const { storeDir, copies } = copySamplesToTempStore(samples);

  // Phase A: session.list against the REAL store. Transcript JSONLs are only
  // read, but the operational metadata sidecar may be created or updated.
  let backend: BackendHandle | undefined;
  try {
    backend = await spawnBackend(SESSION_DIR);
    results['backendReadyMsRealStoreFirstStart'] = backend.readyMs;
    console.log(`backend first start ready in ${fmtMs(backend.readyMs)} (real store)`);
    const listFirstRequest = await backend.request<unknown[]>('session.list', {});
    const listSameProcessRepeat = await backend.request<unknown[]>('session.list', {});
    const backgroundCompletion = await waitForCatalogCompletion(backend, listSameProcessRepeat.result.length);
    const listAfterBackground = backgroundCompletion.supported
      ? await backend.request<unknown[]>('session.list', {})
      : undefined;
    results['listFirstStart'] = {
      firstRequestMs: listFirstRequest.ms,
      firstRequestBytes: JSON.stringify(listFirstRequest.result).length,
      firstRequestCount: listFirstRequest.result.length,
      sameProcessRepeatMs: listSameProcessRepeat.ms,
      sameProcessRepeatBytes: JSON.stringify(listSameProcessRepeat.result).length,
      sameProcessRepeatCount: listSameProcessRepeat.result.length,
      backgroundCompletion,
      ...(listAfterBackground ? {
        completeSnapshotMs: listAfterBackground.ms,
        completeSnapshotBytes: JSON.stringify(listAfterBackground.result).length,
        completeSnapshotCount: listAfterBackground.result.length,
      } : {}),
    };
    console.log(`session.list first request: ${fmtMs(listFirstRequest.ms)} (${listFirstRequest.result.length} sessions)`);
    console.log(`session.list same-process repeat: ${fmtMs(listSameProcessRepeat.ms)} (${listSameProcessRepeat.result.length} sessions)`);
    if (backgroundCompletion.supported) {
      console.log(`session.list background reconciliation: ${fmtMs(backgroundCompletion.reconcileMs!)} (${backgroundCompletion.finalCount} sessions), max concurrent ping ${fmtMs(backgroundCompletion.maxPingMs!)}`);
      console.log(`session.list complete snapshot: ${fmtMs(listAfterBackground!.ms)} (${listAfterBackground!.result.length} sessions)`);
    }
  } finally {
    if (backend) await backend.stop();
    backend = undefined;
  }

  // A fresh backend against the same authority exercises durable-sidecar
  // reuse. This remains transcript-read-only. On a newly-created index, the
  // snapshot reflects whatever background reconciliation durably completed
  // before the first backend stopped; counts are recorded so a partial
  // progressive bootstrap cannot be mistaken for a fully reconciled index.
  try {
    backend = await spawnBackend(SESSION_DIR);
    results['backendReadyMsRealStoreRestart'] = backend.readyMs;
    console.log(`backend restart ready in ${fmtMs(backend.readyMs)} (real store)`);
    const listRestartFirstRequest = await backend.request<unknown[]>('session.list', {});
    const listRestartSameProcessRepeat = await backend.request<unknown[]>('session.list', {});
    results['listRestart'] = {
      persistentSnapshotFirstRequestMs: listRestartFirstRequest.ms,
      persistentSnapshotFirstRequestBytes: JSON.stringify(listRestartFirstRequest.result).length,
      persistentSnapshotFirstRequestCount: listRestartFirstRequest.result.length,
      sameProcessRepeatMs: listRestartSameProcessRepeat.ms,
      sameProcessRepeatBytes: JSON.stringify(listRestartSameProcessRepeat.result).length,
      sameProcessRepeatCount: listRestartSameProcessRepeat.result.length,
      caveat: 'A just-created sidecar may contain only the progressive bootstrap portion that completed before restart.',
    };
    console.log(`session.list restarted process / persistent snapshot: ${fmtMs(listRestartFirstRequest.ms)} (${listRestartFirstRequest.result.length} sessions)`);
    console.log(`session.list restarted process / same-process repeat: ${fmtMs(listRestartSameProcessRepeat.ms)} (${listRestartSameProcessRepeat.result.length} sessions)`);
  } finally {
    if (backend) await backend.stop();
    backend = undefined;
  }

  // Phase B: opens/pages against the throwaway copy.
  try {
    backend = await spawnBackend(storeDir);
    results['backendReadyMsCopyStore'] = backend.readyMs;
    console.log(`backend ready in ${fmtMs(backend.readyMs)} (copy store)`);

    const openedPayload = (): { transcript?: unknown[] } | undefined =>
      backend?.lastEvent.get('session.opened') as { transcript?: unknown[] } | undefined;

    for (const sample of copies) {
      const short = sample.name.slice(0, 40);
      // Full authoritative snapshot on a browse-projection cache miss.
      const openTailPending = backend.request<unknown>('session.open', { sessionPath: sample.path, transcript: 'tail' });
      // Give the backend enough time to enter the cold miss, then probe an
      // unrelated UI control-plane request from the parent process. This
      // measures responsiveness, not just eventual open throughput.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      const concurrentPing = await backend.request<unknown>('app.ping', {});
      const openTail = await openTailPending;
      const tailPayload = openedPayload();
      const tailBytes = JSON.stringify(tailPayload ?? {}).length;
      const tailRows = tailPayload?.transcript?.length ?? null;
      console.log(`open tail  ${short.padEnd(42)} ${fmtBytes(sample.bytes).padStart(8)} → ${fmtBytes(tailBytes).padStart(8)} (${tailRows ?? '?'} rows) in ${fmtMs(openTail.ms)}`);

      // Metadata-only response from the same durable browse-projection cache
      // entry. `skip` controls payload shape; the cache hit avoids SDK reopen.
      const openSkip = await backend.request<unknown>('session.open', { sessionPath: sample.path, transcript: 'skip' });
      const skipBytes = JSON.stringify(openedPayload() ?? {}).length;

      const preload = await backend.request<unknown>('session.preload', { sessionPath: sample.path });
      const page = await backend.request<{ transcript?: unknown[] }>('session.loadTranscriptPage', { sessionPath: sample.path, direction: 'latest' });
      results[sample.name] = {
        openTailCacheMissMs: openTail.ms,
        coldMissConcurrentPingMs: concurrentPing.ms,
        openTailBytes: tailBytes,
        openTailRows: tailRows,
        openSkipCacheHitMs: openSkip.ms,
        openSkipBytes: skipBytes,
        preloadCacheHitMs: preload.ms,
        pageLatestCacheHitMs: page.ms,
      };
      console.log(`cold-miss ping ${short.padEnd(38)} ${fmtMs(concurrentPing.ms)}; cache hits skip ${fmtMs(openSkip.ms)}, preload ${fmtMs(preload.ms)}, page ${fmtMs(page.ms)}`);
    }

    // Paging walk on the largest sample (simulates scrolling back through history)
    const largest = copies[copies.length - 1];
    if (largest) {
      const pageTimes: number[] = [];
      let loadedStart: number | undefined;
      let loadedEnd: number | undefined;
      let totalRows = 0;
      let pages = 0;
      for (let i = 0; i < 25; i++) {
        const page = await backend.request<{ transcript?: unknown[]; transcriptWindow?: { loadedStart?: number; loadedEnd?: number } }>('session.loadTranscriptPage', {
          sessionPath: largest.path,
          direction: 'older',
          loadedStart,
          loadedEnd,
        });
        pageTimes.push(page.ms);
        totalRows += page.result.transcript?.length ?? 0;
        pages += 1;
        loadedStart = page.result.transcriptWindow?.loadedStart;
        loadedEnd = page.result.transcriptWindow?.loadedEnd;
        if (loadedStart !== undefined && loadedEnd !== undefined && loadedStart <= 0) break;
      }
      const pagingWalk = {
        session: largest.name,
        pages,
        totalRows,
        totalMs: pageTimes.reduce((a, b) => a + b, 0),
        maxPageMs: Math.max(...pageTimes),
        avgPageMs: pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length,
      };
      results['pagingWalk'] = pagingWalk;
      console.log(`paging walk on ${largest.name}: ${pages} pages, ${totalRows} rows, total ${fmtMs(pagingWalk.totalMs)}, avg ${fmtMs(pagingWalk.avgPageMs)}, max ${fmtMs(pagingWalk.maxPageMs)}`);
    }
  } finally {
    if (backend) await backend.stop();
    rmSync(storeDir, { recursive: true, force: true });
  }

  // Raw parse floor for the same files
  const floors = samples.map(rawParseFloor);
  results.rawParseFloor = floors;
  console.log('\n=== raw JSONL parse floor (SDK read+parse lower bound) ===');
  console.log('session'.padEnd(42), 'bytes'.padStart(10), 'lines'.padStart(8), 'parse'.padStart(10), 'rate'.padStart(10));
  for (const f of floors) {
    console.log(f.path.slice(0, 42).padEnd(42), fmtBytes(f.bytes).padStart(10), String(f.lines).padStart(8), fmtMs(f.parseMs).padStart(10), `${f.mibPerSec.toFixed(1)}MiB/s`.padStart(10));
  }

  // Write JSON report
  const reportsDir = join(HERE, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report = {
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    sessionDir: SESSION_DIR,
    results,
  };
  const reportPath = join(reportsDir, `session-store-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written: ${reportPath}`);
}

void main();
