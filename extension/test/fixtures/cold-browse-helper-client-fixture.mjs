import readline from 'node:readline';

const mode = process.argv[2] ?? 'success';
const protocolVersion = 1;
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let delayedQueue = Promise.resolve();

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

lines.on('line', (line) => {
  const frame = JSON.parse(line);
  if (frame.kind === 'initialize') {
    if (mode === 'hang-ready') return;
    send({ protocolVersion, kind: 'ready' });
    return;
  }
  if (frame.kind === 'shutdown') {
    send({ protocolVersion, kind: 'shutdown-complete' });
    if (mode === 'sticky-shutdown') {
      setInterval(() => undefined, 1_000);
      return;
    }
    process.exit(0);
  }
  if (frame.kind !== 'request') return;
  if (mode === 'crash') process.exit(7);
  if (mode === 'wrong-correlation') {
    send({
      protocolVersion,
      kind: 'response',
      requestId: `${frame.requestId}-wrong`,
      ok: true,
      fingerprint: frame.payload.fence?.fingerprint,
      result: operationResult(frame.payload),
    });
    return;
  }
  if (mode === 'error') {
    send({
      protocolVersion,
      kind: 'response',
      requestId: frame.requestId,
      ok: false,
      error: { code: 'FIXTURE_ERROR', message: 'fixture operation failed' },
    });
    return;
  }
  if (mode === 'oversized') {
    send({
      protocolVersion,
      kind: 'response',
      requestId: frame.requestId,
      ok: false,
      fingerprint: frame.payload.fence?.fingerprint,
      error: {
        code: 'SESSION_SNAPSHOT_TOO_LARGE',
        message: 'fixture snapshot too large',
        data: { bytes: 2_000, maxBytes: 1_000, requiredMessageId: 'required' },
      },
    });
    return;
  }
  if (mode === 'fingerprint-changed' || mode === 'fingerprint-changed-wrong-fence') {
    send({
      protocolVersion,
      kind: 'response',
      requestId: frame.requestId,
      ok: false,
      fingerprint: mode === 'fingerprint-changed-wrong-fence'
        ? `${frame.payload.fence?.fingerprint}-wrong`
        : frame.payload.fence?.fingerprint,
      error: {
        code: 'FINGERPRINT_CHANGED',
        message: 'fixture durable fingerprint changed',
      },
    });
    return;
  }
  if (mode === 'delayed') {
    delayedQueue = delayedQueue.then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      sendSuccess(frame);
    });
    return;
  }
  sendSuccess(frame);
});

function sendSuccess(frame) {
  send({
    protocolVersion,
    kind: 'response',
    requestId: frame.requestId,
    ok: true,
    fingerprint: mode === 'stale-fingerprint'
      ? `${frame.payload.fence?.fingerprint}-stale`
      : frame.payload.fence?.fingerprint,
    result: operationResult(frame.payload),
  });
}

function operationResult(payload) {
  if (payload.operation === 'invalidate') return { invalidated: true };
  if (payload.operation === 'open') {
    return {
      session: { path: payload.fence.sessionPath },
      transcript: [],
      transcriptWindow: {},
      busy: false,
      fixturePid: process.pid,
    };
  }
  if (payload.operation === 'page') {
    return {
      sessionPath: payload.fence.sessionPath,
      transcript: [],
      transcriptWindow: {},
      busy: false,
    };
  }
  return {
    sessionPath: payload.fence.sessionPath,
    key: payload.ref.key,
    status: 'unavailable',
    message: 'fixture',
  };
}
