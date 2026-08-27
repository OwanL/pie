import { attachJsonlLineReader } from '../shared/jsonl';
import { toErrorMessage } from '../shared/error-message';
import { SessionSnapshotTooLargeError } from '../shared/transcript-window';
import {
  COLD_BROWSE_HELPER_MAX_FRAME_BYTES,
  COLD_BROWSE_HELPER_PROTOCOL_VERSION,
  type ColdBrowseHelperInputFrame,
  type ColdBrowseHelperOutputFrame,
} from './cold-browse-helper-protocol';
import { ColdBrowseHelperRuntime } from './cold-browse-helper-runtime';
import { loadSdk } from './sdk';

const PARENT_WATCHDOG_INTERVAL_MS = 1_000;

async function main(): Promise<void> {
  let runtime: ColdBrowseHelperRuntime | undefined;
  let initialized = false;
  let shuttingDown = false;
  let stopParentWatchdog: (() => void) | undefined;
  let queue = Promise.resolve();

  const disposeRuntime = (): void => {
    runtime?.dispose();
    runtime = undefined;
  };

  const stop = (): void => {
    stopParentWatchdog?.();
    stopParentWatchdog = undefined;
    disposeRuntime();
  };

  const fatal = (error: unknown): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    stop();
    process.stderr.write(`[pie-cold-browse-helper] ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
    process.stdin.pause();
  };

  const handle = async (frame: ColdBrowseHelperInputFrame): Promise<void> => {
    if (frame.kind === 'initialize') {
      if (initialized) throw new Error('Cold browse helper received duplicate initialization.');
      if (!Number.isSafeInteger(frame.parentPid) || frame.parentPid <= 0) {
        throw new Error('Cold browse helper requires a positive parent PID.');
      }
      // Cover the SDK import/validation window too: if the coordinator dies
      // while initialization is hung, the helper must not survive it.
      stopParentWatchdog = startParentProcessWatchdog(frame.parentPid, () => {
        shuttingDown = true;
        disposeRuntime();
        process.exit(0);
      });
      // `cold-worker` is the read-only barrier branch: it validates the exact
      // coordinator identity before importing SessionManager and never calls
      // the coordinator patch/ensure path.
      const sdk = await loadSdk(frame.sdkPath, {
        mode: 'cold-worker',
        patchIdentity: frame.sdkPatchIdentity,
      });
      runtime = new ColdBrowseHelperRuntime({
        sdk,
        startupCwd: frame.startupCwd,
        maxSourceBytes: frame.maxSourceBytes,
        maxEntries: frame.maxEntries,
      });
      initialized = true;
      await writeOutput({
        protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
        kind: 'ready',
      });
      return;
    }
    if (!initialized || !runtime) throw new Error('Cold browse helper request arrived before initialization.');
    if (frame.kind === 'shutdown') {
      shuttingDown = true;
      // Keep the parent watchdog armed until stdin actually closes. An ack is
      // not proof that the child has released every SDK/process handle.
      disposeRuntime();
      await writeOutput({
        protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
        kind: 'shutdown-complete',
      });
      return;
    }

    try {
      const response = await runtime.execute(frame.payload);
      await writeOutput({
        protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
        kind: 'response',
        requestId: frame.requestId,
        ok: true,
        fingerprint: response.fingerprint,
        result: response.result,
      });
    } catch (error) {
      const fingerprint = frame.payload.operation === 'invalidate'
        ? undefined
        : frame.payload.fence.fingerprint;
      await writeOutput({
        protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
        kind: 'response',
        requestId: frame.requestId,
        ok: false,
        fingerprint,
        error: {
          code: error instanceof SessionSnapshotTooLargeError
            ? error.code
            : toErrorMessage(error).startsWith('COLD_BROWSE_FINGERPRINT_CHANGED:')
              ? 'FINGERPRINT_CHANGED'
              : 'BROWSE_FAILED',
          message: toErrorMessage(error),
          ...(error instanceof SessionSnapshotTooLargeError ? { data: error.data } : {}),
        },
      });
    }
  };

  const detach = attachJsonlLineReader(process.stdin, (line) => {
    if (shuttingDown) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      fatal(new Error(`Malformed cold browse helper JSONL: ${toErrorMessage(error)}`));
      return;
    }
    const frame = parseInputFrame(value);
    if (!frame) {
      fatal(new Error('Cold browse helper received an invalid protocol frame.'));
      return;
    }
    queue = queue.then(async () => await handle(frame));
    void queue.catch(fatal);
  }, {
    maxLineBytes: COLD_BROWSE_HELPER_MAX_FRAME_BYTES - 1,
    emitTrailingLineOnEnd: false,
    onOverflow: () => fatal(new Error('Cold browse helper request exceeded its frame limit.')),
    onIncomplete: () => fatal(new Error('Cold browse helper request ended mid-frame.')),
  });
  process.stdin.once('end', () => {
    void queue.finally(() => {
      detach();
      stop();
    });
  });
}

async function writeOutput(frame: ColdBrowseHelperOutputFrame): Promise<void> {
  let wire = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(wire, 'utf8') > COLD_BROWSE_HELPER_MAX_FRAME_BYTES) {
    if (frame.kind !== 'response' || !frame.ok) {
      throw new Error('Cold browse helper control response exceeded its frame limit.');
    }
    wire = `${JSON.stringify({
      protocolVersion: COLD_BROWSE_HELPER_PROTOCOL_VERSION,
      kind: 'response',
      requestId: frame.requestId,
      ok: false,
      error: {
        code: 'RESPONSE_TOO_LARGE',
        message: 'Cold browse helper response exceeded its bounded IPC frame.',
      },
    })}\n`;
  }
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(wire, (error) => error ? reject(error) : resolve());
  });
}

function parseInputFrame(value: unknown): ColdBrowseHelperInputFrame | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const frame = value as Record<string, unknown>;
  if (frame.protocolVersion !== COLD_BROWSE_HELPER_PROTOCOL_VERSION || typeof frame.kind !== 'string') return undefined;
  if (frame.kind === 'shutdown') return value as ColdBrowseHelperInputFrame;
  if (frame.kind === 'initialize') {
    return typeof frame.sdkPath === 'string'
      && typeof frame.startupCwd === 'string'
      && typeof frame.parentPid === 'number'
      && !!frame.sdkPatchIdentity
      && typeof frame.sdkPatchIdentity === 'object'
      ? value as ColdBrowseHelperInputFrame
      : undefined;
  }
  if (frame.kind !== 'request' || typeof frame.requestId !== 'string'
      || !frame.payload || typeof frame.payload !== 'object' || Array.isArray(frame.payload)) return undefined;
  const operation = (frame.payload as Record<string, unknown>).operation;
  return operation === 'open' || operation === 'page' || operation === 'detail' || operation === 'invalidate'
    ? value as ColdBrowseHelperInputFrame
    : undefined;
}

export function isParentProcessAlive(parentPid: number): boolean {
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function startParentProcessWatchdog(
  parentPid: number,
  onParentMissing: () => void,
  intervalMs = PARENT_WATCHDOG_INTERVAL_MS,
): () => void {
  const watchdog = setInterval(() => {
    if (!isParentProcessAlive(parentPid)) onParentMissing();
  }, intervalMs);
  watchdog.unref?.();
  return () => clearInterval(watchdog);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`[pie-cold-browse-helper] ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
