import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
const readFd = Number(args.get('--ipc-read-fd'));
const writeFd = Number(args.get('--ipc-write-fd'));
const input = new Socket({ fd: readFd, readable: true, writable: false });
const output = new Socket({ fd: writeFd, readable: false, writable: true });
const identity = {
  ipcVersion: 1,
  coordinatorGeneration: Number(args.get('--coordinator-generation')),
  workerId: args.get('--worker-id'),
  workerGeneration: Number(args.get('--worker-generation')),
  workerPid: process.pid,
  rootSessionPath: args.get('--root-session-path') ?? args.get('--session-path'),
  leasePath: args.get('--lease-path') ?? args.get('--session-path'),
  leaseRevision: Number(args.get('--lease-revision') ?? 1),
  sessionPath: args.get('--root-session-path') ?? args.get('--session-path'),
};
const mode = process.env.PIE_WORKER_FIXTURE_MODE ?? 'noise';
let seq = 1;
const send = (frame, callback) => output.write(`${JSON.stringify({ ...identity, seq: seq++, ...frame })}\n`, callback);
const sendWithoutDelimiter = (frame, callback) => output.write(JSON.stringify({ ...identity, seq: seq++, ...frame }), callback);

const writeRawOversize = async () => {
  // Deliberately bypass the bounded sender and write more than the production
  // 32 MiB cap directly to the inherited worker→coordinator descriptor. The
  // receiver must discard this through LF without JSON.parse ever seeing it.
  const chunk = 'x'.repeat(64 * 1024);
  for (let index = 0; index < 513; index += 1) {
    if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
  }
  output.write('\n');
};

const spawnDescendantAfterReady = () => {
  setTimeout(() => {
    const descendant = spawn(process.execPath, [fileURLToPath(new URL('./phase2-worker-grandchild.mjs', import.meta.url))], {
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    });
    const marker = process.env.PIE_WORKER_DESCENDANT_MARKER;
    if (marker && descendant.pid) writeFileSync(marker, String(descendant.pid));
    if (mode === 'crash-descendant') process.exit(23);
  }, 100);
};

let buffered = '';
input.setEncoding('utf8');
input.on('data', (chunk) => {
  buffered += chunk;
  while (true) {
    const newline = buffered.indexOf('\n');
    if (newline < 0) return;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    let frame;
    try { frame = JSON.parse(line); } catch { process.exit(2); }
    if (frame?.kind === 'bootstrap') {
      if (mode === 'malformed') {
        output.write('{definitely-not-json}\n');
        continue;
      }
      if (mode === 'gap') {
        seq = 2;
        send({ kind: 'ready', runtimeMetadata: { mode: 'phase2', startedAt: Date.now() } });
        continue;
      }
      if (mode === 'oversize') {
        send({ kind: 'fatal', error: { code: 'INTERNAL_ERROR', phase: 'ipc', message: 'x'.repeat(300 * 1024) } });
        continue;
      }
      if (mode === 'raw-fd-oversize') {
        void writeRawOversize();
        continue;
      }
      if (mode === 'close') {
        output.end();
        continue;
      }
      if (mode === 'close-exit1') {
        output.end(() => setImmediate(() => process.exit(1)));
        continue;
      }
      if (mode === 'eof-ready') {
        sendWithoutDelimiter({ kind: 'ready', runtimeMetadata: { mode: 'phase2', startedAt: Date.now() } }, () => output.end());
        continue;
      }
      if (mode === 'noise') {
        process.stdout.write('{"ipcVersion":1,"kind":"fatal"}\npartial-stdout-');
        process.stdout.write('x'.repeat(4096) + 'STDOUT-END');
        process.stderr.write('{"kind":"response","ok":true}\npartial-stderr-');
        process.stderr.write('y'.repeat(4096) + 'STDERR-END');
      }
      send({ kind: 'ready', runtimeMetadata: { mode: 'phase2', startedAt: Date.now() } }, () => {
        if (mode === 'descendant' || mode === 'crash-descendant') spawnDescendantAfterReady();
        if (mode === 'phase4') {
          send({
            kind: 'provider.acquire',
            requestId: 'fixture-provider-acquire',
            request: { provider: 'fixture', model: 'fixture-model', turnId: 'turn-1', attemptId: 'attempt-1' },
          });
        }
      });
      continue;
    }
    if (frame?.kind === 'runtime.promote') {
      send({ kind: 'runtime.ready', requestId: frame.requestId, runtimeMetadata: { mode: 'phase4', startedAt: Date.now() } });
    } else if (frame?.kind === 'runtime.command') {
      send({ kind: 'response', requestId: frame.requestId, ok: true, result: { kind: 'runtime.command', payload: { acceptedOperation: frame.operation } } });
    } else if (frame?.kind === 'sync') {
      send({ kind: 'sync.ack', requestId: frame.requestId, domain: frame.domain, revision: frame.revision });
    } else if (frame?.kind === 'provider.granted') {
      send({ kind: 'runtime.event', event: 'operational-error', payload: { code: 'FIXTURE_LEASE', message: frame.lease.leaseId } });
    } else if (frame?.kind === 'command') {
      if (mode === 'stale') {
        output.write(`${JSON.stringify({ ...identity, seq: seq - 1, kind: 'heartbeat', heartbeat: { phase: 'ready', lastEventSeq: 0, lastDetailRevision: 0, eventLoopDelayMs: 0 } })}\n`);
      }
      const responseFrame = {
        kind: 'response',
        requestId: mode === 'unknown-response' ? 'unknown-request' : frame.requestId,
        ok: true,
        result: { kind: mode === 'mismatched-response' ? 'interrupted' : 'pong' },
      };
      if (mode === 'eof-response') sendWithoutDelimiter(responseFrame, () => output.end());
      else send(responseFrame);
    } else if (frame?.kind === 'interrupt') {
      send({ kind: 'response', requestId: frame.requestId, ok: true, result: { kind: 'interrupted' } });
    } else if (frame?.kind === 'shutdown') {
      send({ kind: 'response', requestId: frame.requestId, ok: true, result: { kind: 'shutting-down' } });
      setTimeout(() => process.exit(0), 25);
    }
  }
});

setInterval(() => undefined, 1_000).unref();
