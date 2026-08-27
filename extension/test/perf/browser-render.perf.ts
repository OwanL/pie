/**
 * Browser render rig: measures the REAL webview rendering REAL snapshots in
 * real Chromium.
 *
 * The host-pipeline harness (session-host-pipeline.perf.ts, run with
 * PIE_PERF_DUMP_DIR) dumps the exact `state` envelopes the host posts to the
 * webview. This rig replays those envelopes over the browser-server wire
 * protocol against a mock loopback server, while a real Chromium page renders
 * the actual webview bundle (out/webview). Per envelope it reports main-thread
 * long-task time (Long Tasks API), DOM node count, and rendered text length.
 *
 * This is the "real browser timing" measurement the repo explicitly lacked
 * (docs/internal/overnight-reports/2026-07-16.md remaining-risk #1/#5).
 *
 * Run:
 *   PIE_PERF_DUMP_DIR=... npx tsx ./test/perf/session-host-pipeline.perf.ts
 *   npx tsx ./test/perf/browser-render.perf.ts   (from extension/)
 * Not swept by `npm test` (*.perf.ts). Writes ./test/perf/reports/.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

import { chromium, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';

import { EXTENSION_ROOT, HERE, REPO_ROOT } from './backend-probe';
import { PIE_BUILD_ID, WEBVIEW_PROTOCOL_VERSION } from '../../src/shared/protocol';

const PORT = Number(process.env.PIE_PERF_BROWSER_PORT ?? 1998);
const DUMP_DIR = resolve(process.env.PIE_PERF_DUMP_DIR ?? join(process.env.TEMP ?? '/tmp', 'pie-envelopes'));
const ASSETS_DIR = join(EXTENSION_ROOT, 'out', 'webview', 'panel');
const SETTLE_WAIT_MS = 30_000;

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

interface Envelope { name: string; bytes: number; revision: number; text: string }

function loadManifest(): { entry: string; css: string } {
  const manifest = JSON.parse(readFileSync(join(ASSETS_DIR, '.vite', 'manifest.json'), 'utf8')) as Record<string, { file: string; isEntry?: boolean; css?: string[] }>;
  const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
  if (!entry) throw new Error('no entry chunk in webview manifest');
  return { entry: entry.file, css: entry.css?.[0] ?? '' };
}

function loadEnvelopes(): Envelope[] {
  const files = readdirSync(DUMP_DIR).filter((f) => f.endsWith('.json')).sort();
  return files.map((f) => {
    const text = readFileSync(join(DUMP_DIR, f), 'utf8');
    const parsed = JSON.parse(text) as { revision?: number };
    return { name: f, bytes: Buffer.byteLength(text, 'utf8'), revision: parsed.revision ?? 0, text };
  });
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/') {
  const { entry, css } = loadManifest();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="pie-asset-version" content="perf" />
  <meta name="pie-transport" content="browser" />
  <meta name="pie-ws-route" content="/ws" />
  <meta name="pie-view-generation" content="1" />
  <link rel="stylesheet" href="/${css}" />
  <title>pie perf</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="/${entry}"></script>
</body>
</html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  const file = join(ASSETS_DIR, url.replace(/^\/assets\//, 'assets/'));
  try {
    const body = readFileSync(file);
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

interface PageMetrics {
  longTasksMs: number;
  longTaskCount: number;
  domNodes: number;
  textLen: number;
}

interface Stage extends PageMetrics {
  envelope: string;
  bytes: number;
  revision: number;
  settledMs: number;
}

async function main(): Promise<void> {
  const envelopes = loadEnvelopes();
  if (envelopes.length === 0) {
    console.error(`no envelopes in ${DUMP_DIR}; run session-host-pipeline.perf.ts with PIE_PERF_DUMP_DIR first`);
    process.exit(1);
  }
  console.log('pie browser-render rig');
  console.log(`envelopes: ${envelopes.length}`);
  for (const e of envelopes) console.log(`  ${e.name}: rev ${e.revision}, ${fmtBytes(e.bytes)}`);
  console.log(`webview assets: ${ASSETS_DIR}`);

  // Mock host: static HTML + WS replaying the captured envelopes.
  const http = createServer(serveStatic);
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((resolveReady) => http.listen(PORT, '127.0.0.1', () => resolveReady()));
  console.log(`server listening on 127.0.0.1:${PORT}`);

  // Object holder so the loop reads a property (no variable-narrowing noise).
  const socketForReplay: { current: { send(data: string): void } | null } = { current: null };
  const readyPromise = new Promise<void>((resolveReady) => {
    let envelopesSent = 0;
    wss.on('connection', (conn) => {
      const ws = conn;
      socketForReplay.current = ws;
      ws.send(JSON.stringify({
        type: 'rendererHello',
        protocolVersion: WEBVIEW_PROTOCOL_VERSION,
        buildId: PIE_BUILD_ID,
        hostInstanceId: 'perf-host',
        rendererId: 'perf-renderer',
        rendererGeneration: 1,
        viewGeneration: 1,
        assetVersion: 'perf',
      }));
      ws.on('message', (data) => {
        const text = String(data);
        if (text.includes('stateReceived') || text.includes('paintObserved')) {
          console.log(`[client ack] ${text.slice(0, 160)}`);
        }
        let msg: unknown;
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }
        const type = (msg as { type?: string }).type;
        // The real host answers `ready`/`refreshState` with the current
        // snapshot; replicate that by feeding the captured envelopes.
        if (type === 'ready' || type === 'refreshState') {
          if (envelopesSent === 0) {
            envelopesSent += 1;
            ws.send(replayEnvelopes[0].text);
            console.log(`answered ${type} with first envelope (${replayEnvelopes[0].name})`);
          }
          if (type === 'ready') resolveReady();
        }
      });
    });
  });

  // All dumps carry revision 1 (each was built from a fresh sync state).
  // Re-number them 1..N so the client's revision guard accepts the sequence.
  const replayEnvelopes = envelopes.map((envelope, index) => {
    const parsed = JSON.parse(envelope.text) as { revision?: number; protocolVersion?: number; buildId?: string };
    parsed.revision = index + 1;
    parsed.protocolVersion = WEBVIEW_PROTOCOL_VERSION;
    parsed.buildId = PIE_BUILD_ID;
    return { ...envelope, text: JSON.stringify(parsed), revision: index + 1 };
  });

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (error) => console.log(`[pageerror] ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') console.log(`[console.${message.type()}] ${message.text().slice(0, 300)}`);
  });
  await page.addInitScript(() => {
    (window as any).__lt = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          (window as any).__lt.push({ s: entry.startTime, d: entry.duration });
        }
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* older chromium */ }
    // Frame-level visibility: record every WS frame's type.
    const frames: string[] = [];
    (window as any).__frames = frames;
    const NativeWS = window.WebSocket;
    class SpyWS extends NativeWS {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const onmessage = (event: MessageEvent) => {
          let type = '?nonjson';
          try {
            type = (JSON.parse(String(event.data)) as { type?: string }).type ?? '?notype';
          } catch { /* non-JSON */ }
          frames.push(type);
        };
        this.addEventListener('message', onmessage as EventListener);
      }
    }
    (window as unknown as Record<string, unknown>).WebSocket = SpyWS;
  });
  await page.goto(`http://127.0.0.1:${PORT}/`);

  await readyPromise;
  console.log('renderer handshake complete');

  const readMetrics = async (): Promise<PageMetrics> => page.evaluate(() => ({
    longTasksMs: (window as any).__lt.filter((t: { d: number }) => t.d > 50).reduce((a: number, t: { d: number }) => a + t.d, 0),
    longTaskCount: (window as any).__lt.filter((t: { d: number }) => t.d > 50).length,
    domNodes: document.querySelectorAll('*').length,
    textLen: document.body.innerText.length,
  }));

  const stages: Stage[] = [];
  let lastText = -1;
  let lastNodes = 0;
  for (const envelope of replayEnvelopes) {
    const start = performance.now();
    socketForReplay.current?.send(envelope.text);
    console.log(`sent ${envelope.name} (${fmtBytes(envelope.bytes)}), waiting for render settle…`);
    let settled = false;
    while (performance.now() - start < SETTLE_WAIT_MS) {
      await page.waitForTimeout(250);
      const probe = await page.evaluate(() => ({
        text: document.body.innerText.length,
        nodes: document.querySelectorAll('*').length,
      }));
      if (probe.text > 0 && (probe.text !== lastText || probe.nodes !== lastNodes)) {
        lastText = probe.text;
        lastNodes = probe.nodes;
        // Two consecutive stable samples = settled.
        await page.waitForTimeout(500);
        const probe2 = await page.evaluate(() => ({
          text: document.body.innerText.length,
          nodes: document.querySelectorAll('*').length,
        }));
        if (probe2.text === probe.text && probe2.nodes === probe.nodes) { settled = true; break; }
      }
    }
    const metrics = await readMetrics();
    const frames = await page.evaluate(() => (window as any).__frames as string[]);
    console.log(`    ws frames received: ${JSON.stringify(frames)}`);
    const stage: Stage = {
      envelope: envelope.name,
      bytes: envelope.bytes,
      revision: envelope.revision,
      ...metrics,
      settledMs: performance.now() - start,
    };
    stages.push(stage);
    console.log(`  settled in ${fmtMs(stage.settledMs)}: longtask ${fmtMs(metrics.longTasksMs)} (${metrics.longTaskCount}), nodes ${metrics.domNodes}, text ${fmtBytes(metrics.textLen)}`);
    if (!settled) console.log('  WARNING: render did not settle within 30s');
    lastText = await page.evaluate(() => document.body.innerText.length);
  }

  await browser.close();
  http.close();

  console.log('\n=== webview render metrics (real Chromium, per snapshot) ===');
  console.log('envelope'.padEnd(44), 'bytes'.padStart(9), 'longtask'.padStart(10), 'nodes'.padStart(8), 'text'.padStart(10), 'settle'.padStart(10));
  for (const s of stages) {
    console.log(
      s.envelope.slice(0, 44).padEnd(44),
      fmtBytes(s.bytes).padStart(9),
      fmtMs(s.longTasksMs).padStart(10),
      String(s.domNodes).padStart(8),
      fmtBytes(s.textLen).padStart(10),
      fmtMs(s.settledMs).padStart(10),
    );
  }

  const reportsDir = join(HERE, 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(reportsDir, `browser-render-${stamp}.json`);
  writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    gitSha: gitSha(),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    envelopeDir: DUMP_DIR,
    stages,
  }, null, 2));
  console.log(`report written: ${reportPath}`);
}

void main().catch((error) => {
  console.error(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
