import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { WorkerJsonObject } from '../../../lib/rpc/worker-protocol.js';
import type { SourceArtifactSdkModule, SourceSdkLoadMode } from '../../../lib/sdk-integration/sdk.js';
import { loadSdk } from '../../../lib/sdk-integration/sdk.js';
import {
  parseSdkRuntimeSelection,
  sdkRuntimeLoadMode,
  sdkRuntimeSdkPath,
  verifySdkRuntimeSelection,
  type SdkRuntimeSelection,
} from '../../../lib/sdk-integration/sdk-runtime-selection.js';
import { WorkerRuntimeHost, type WorkerRuntimePromotionPayload } from '../../worker-runtime-host.js';

interface SourceRuntimeChildInput {
  sdkRuntime: SdkRuntimeSelection;
  cwd: string;
  agentDir: string;
  sessionDir: string;
  prepareOnly?: boolean;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('Source runtime child requires an isolated fixture configuration.');
  const input = JSON.parse(await fs.readFile(inputPath, 'utf8')) as SourceRuntimeChildInput;
  const selection = parseSdkRuntimeSelection(input.sdkRuntime);
  const verified = await verifySdkRuntimeSelection(sdkRuntimeSdkPath(selection), selection);
  if (verified.kind !== 'source-artifact') throw new Error('Source runtime child requires a source-artifact selection.');
  const sdkPath = verified.descriptor.sdkPath;
  const mode = sdkRuntimeLoadMode(verified, 'full');
  if (mode.mode !== 'source-artifact') throw new Error('Source runtime child requires a source-artifact selection.');
  const sdk = await loadSdk(sdkPath, {
    ...(mode as SourceSdkLoadMode),
    surface: 'full',
  }) as SourceArtifactSdkModule;

  await fs.mkdir(input.agentDir, { recursive: true });
  await fs.mkdir(input.sessionDir, { recursive: true });
  await fs.writeFile(path.join(input.agentDir, 'settings.json'), '{}\n', 'utf8');
  const sessionManager = sdk.SessionManager.create(input.cwd, input.sessionDir);
  const sessionPath = sessionManager.getSessionFile();
  if (!sessionPath) throw new Error('Source SDK did not create a durable session path.');
  const canonicalSessionPath = await fs.realpath(sessionPath);
  if (input.prepareOnly) {
    process.stdout.write(`${JSON.stringify({
      kind: 'source-runtime-session-ready',
      sdkVersion: sdk.VERSION,
      sessionPath: canonicalSessionPath,
    })}\n`);
    return;
  }
  const workerId = 'source-runtime-worker';
  const frames: Array<{ kind: string; event?: string; payload?: unknown }> = [];
  const server = {
    sendFrame(frame: { kind: string; event?: string; payload?: unknown }) {
      frames.push(frame);
      return true;
    },
    sendLiveSemanticFrame(payload: WorkerJsonObject) {
      frames.push({ kind: 'runtime.event', event: 'live.semantic', payload });
      return true;
    },
    sendRuntimeReportFrame(payload: unknown) {
      frames.push({ kind: 'runtime.report', payload });
      return true;
    },
    sendDetailFrame() { return true; },
    onDetailDrain() { return () => undefined; },
    requestFrame: async () => { throw new Error('Offline source fixture must not request a provider endpoint.'); },
    failRuntime(error: Error) { throw error; },
  };
  const host = new WorkerRuntimeHost({
    server: server as never,
    owner: { coordinatorGeneration: 41, workerId, workerGeneration: 1 },
    sdkRuntime: verified,
  });
  const modifiedAt = new Date(0).toISOString();
  const payload: WorkerRuntimePromotionPayload = {
    sdkPath,
    sdkRuntime: verified,
    agentDir: input.agentDir,
    startupCwd: input.cwd,
    sessionDir: input.sessionDir,
    sessionPath: canonicalSessionPath,
    creationReason: 'resume',
    writeLease: {
      coordinatorGeneration: 41,
      workerId,
      workerGeneration: 1,
      canonicalSessionPath,
      ownershipRevision: 1,
      nonce: 'source-runtime-test-lease',
    },
    openedPayload: {
      session: { path: canonicalSessionPath, name: 'Source runtime fixture', cwd: input.cwd, modifiedAt, messageCount: 0 },
      transcript: [],
      transcriptWindow: {
        totalCount: 0, loadedStart: 0, loadedEnd: 0, hasOlder: false, hasNewer: false,
        isPartial: false, hasUserMessages: false,
      },
      busy: false,
    } as WorkerRuntimePromotionPayload['openedPayload'],
    modelSettings: { defaultModel: '', defaultThinkingLevel: 'high' },
  };

  try {
    await host.promote(payload);
    const opened = frames.find((frame) => frame.kind === 'runtime.event' && frame.event === 'session.opened');
    if (!opened) throw new Error('Source SDK promotion did not publish session.opened.');
    const commandResult = await host.command('models.list', {
      params: { sessionPath: canonicalSessionPath },
    }, 'source-runtime-model-list');
    process.stdout.write(`${JSON.stringify({
      kind: 'source-runtime-ready',
      sdkVersion: sdk.VERSION,
      sessionPath: canonicalSessionPath,
      commandCompleted: commandResult !== undefined,
      openedEvent: opened.event,
    })}\n`);
  } finally {
    await host.dispose();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
