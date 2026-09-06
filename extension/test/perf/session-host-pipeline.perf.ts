/**
 * Host-pipeline performance harness with REAL session payloads.
 *
 * Captures authoritative `session.opened` payloads from the real backend
 * (against a copy of the real store), then feeds them through the real host
 * CQRS pipeline exactly as a tab switch does:
 *
 *   dispatch(SessionOpened)  → reducer (row normalization, transcript state)
 *   selectViewState()         → projection to the webview ViewState
 *   buildStateEnvelope()      → snapshot message construction
 *   structuredClone()         → proxy for webview.postMessage clone cost
 *   JSON.stringify()          → wire serialization bytes
 *
 * Complements the synthetic streaming-pipeline.perf.ts with real row shapes
 * (huge tool bodies, subagent transcripts, pruning banners).
 *
 * Run:   npx tsx ./test/perf/session-host-pipeline.perf.ts   (from extension/)
 * Not swept by `npm test` (*.perf.ts). Writes ./test/perf/reports/.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { execSync } from 'node:child_process';

import { produce } from 'immer';

import { createInitialArchState, type ArchState } from '../../src/host/core/arch-state';
import { dispatch } from '../../src/host/core/dispatch';
import { selectViewState } from '../../src/host/core/projection';
import { buildStateEnvelope, createSidebarSyncState } from '../../src/host/sidebar/sync';
import type { Event } from '../../src/host/core/events';
import type { SessionOpenedPayload } from '../../src/shared/protocol';
import { BACKEND_PATH, SESSION_DIR, HERE, REPO_ROOT, copySamplesToTempStore, sampleSessions, spawnBackend, type BackendHandle } from './backend-probe';

function fmtUs(us: number): string {
  if (us >= 1_000_000) return `${(us / 1_000_000).toFixed(2)}s`;
  if (us >= 1000) return `${(us / 1000).toFixed(1)}ms`;
  return `${us.toFixed(0)}us`;
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

function median(arr: number[]): number {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function makeOpenedEvent(sessionPath: string, payload: SessionOpenedPayload): Event {
  return {
    kind: 'SessionOpened',
    sessionPath,
    payload,
    backendGeneration: 1,
    modelWriteFence: 0,
    modelHydrationRevision: 0,
    catalogHydrationRevision: 0,
  } as Event;
}

/** Register the session in state so projection sees an active session. */
function setupSession(state: ArchState, sessionPath: string): ArchState {
  return produce(state, (draft) => {
    draft.sessions.sessions.push({
      path: sessionPath,
      name: 'perf',
      cwd: REPO_ROOT,
      modifiedAt: '2026-01-01T00:00:00Z',
      messageCount: 0,
      isPlaceholder: false,
    });
    if (!draft.sessions.openTabPaths.includes(sessionPath)) draft.sessions.openTabPaths.push(sessionPath);
    draft.sessions.activeSessionPath = sessionPath;
  });
}

interface PipelineResult {
  session: string;
  bytes: number;
  dispatchUs: number;
  projectionUs: number;
  envelopeUs: number;
  cloneUs: number;
  stringifyUs: number;
  viewStateBytes: number;
  messageBytes: number;
}

async function main(): Promise<void> {
  console.log('pie host-pipeline perf harness (real session.opened payloads)');
  console.log(`session dir: ${SESSION_DIR}`);
  console.log(`backend: ${BACKEND_PATH}`);
  const samples = sampleSessions();
  const { storeDir, copies } = copySamplesToTempStore(samples);

  const results: PipelineResult[] = [];
  let backend: BackendHandle | undefined;
  try {
    backend = await spawnBackend(storeDir);
    const openedPayload = (): SessionOpenedPayload | undefined =>
      backend?.lastEvent.get('session.opened') as SessionOpenedPayload | undefined;

    for (const sample of copies) {
      const trials: Omit<PipelineResult, 'session' | 'bytes'>[] = [];
      for (let trial = 0; trial < 6; trial++) {
        if (trial === 0) {
          await backend.request<unknown>('session.open', { sessionPath: sample.path, transcript: 'tail' });
        }
        const payload = openedPayload();
        if (!payload) throw new Error(`no session.opened payload for ${sample.name}`);
        const event = makeOpenedEvent(sample.path, payload);

        const base = setupSession(createInitialArchState(), sample.path);
        const readyState = { ...base, backendReady: true };

        const t0 = performance.now();
        const { state } = dispatch(readyState, event);
        const t1 = performance.now();

        const t2 = performance.now();
        const viewState = selectViewState(state);
        const t3 = performance.now();

        const syncState = createSidebarSyncState('perf-host');
        const t4 = performance.now();
        const built = buildStateEnvelope(syncState, viewState, true);
        const t5 = performance.now();

        // Dump the first trial's built envelope for the browser-render rig.
        if (trial === 0 && process.env.PIE_PERF_DUMP_DIR) {
          const dumpDir = process.env.PIE_PERF_DUMP_DIR;
          mkdirSync(dumpDir, { recursive: true });
          writeFileSync(join(dumpDir, `${sample.name}.json`), JSON.stringify(built.message));
        }

        let cloneMs = 0;
        if (built.message) {
          const c0 = performance.now();
          structuredClone(built.message);
          cloneMs = performance.now() - c0;
        }
        const t6 = performance.now();
        const messageJson = built.message ? JSON.stringify(built.message) : '';
        const t7 = performance.now();

        if (trial > 0) {
          if (process.env.PIE_PERF_DEBUG) {
            console.log(`  [debug] sample=${sample.name.slice(0, 24)} trial=${trial} dispatch=${((t1 - t0) * 1000).toFixed(1)}us proj=${((t3 - t2) * 1000).toFixed(1)}us env=${((t5 - t4) * 1000).toFixed(1)}us clone=${(cloneMs * 1000).toFixed(1)}us str=${((t7 - t6) * 1000).toFixed(1)}us`);
          }
          trials.push({
            dispatchUs: (t1 - t0) * 1000,
            projectionUs: (t3 - t2) * 1000,
            envelopeUs: (t5 - t4) * 1000,
            cloneUs: cloneMs * 1000,
            stringifyUs: (t7 - t6) * 1000,
            viewStateBytes: Buffer.byteLength(JSON.stringify(viewState), 'utf8'),
            messageBytes: Buffer.byteLength(messageJson, 'utf8'),
          });
        }
      }

      const pick = (k: keyof Omit<PipelineResult, 'session' | 'bytes'>): number =>
        median(trials.map((t) => t[k] as number));
      const row: PipelineResult = {
        session: sample.name,
        bytes: sample.bytes,
        dispatchUs: pick('dispatchUs'),
        projectionUs: pick('projectionUs'),
        envelopeUs: pick('envelopeUs'),
        cloneUs: pick('cloneUs'),
        stringifyUs: pick('stringifyUs'),
        viewStateBytes: pick('viewStateBytes'),
        messageBytes: pick('messageBytes'),
      };
      results.push(row);
      console.log(
        `${sample.name.slice(0, 40).padEnd(42)} ${fmtBytes(sample.bytes).padStart(8)} → ` +
        `dispatch ${fmtUs(row.dispatchUs).padStart(8)} proj ${fmtUs(row.projectionUs).padStart(8)} env ${fmtUs(row.envelopeUs).padStart(8)} ` +
        `clone ${fmtUs(row.cloneUs).padStart(8)} str ${fmtUs(row.stringifyUs).padStart(8)} | VS ${fmtBytes(row.viewStateBytes).padStart(8)} msg ${fmtBytes(row.messageBytes).padStart(8)}`,
      );
    }
  } finally {
    if (backend) await backend.stop();
    rmSync(storeDir, { recursive: true, force: true });
  }

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
  const reportPath = join(reportsDir, `session-host-pipeline-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nreport written: ${reportPath}`);
}

void main();
