import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { artifactDirectory } from './src/artifacts.js';
import { projectComputerImageContext } from './src/context.js';
import { buildToolError, buildToolResult, modelAcceptsImages } from './src/result.js';
import {
  installProcessTeardown, potentialHeldForAction, potentialHeldForSequence, runtimeRegistry,
} from './src/runtime-client.js';
import { computerSchema } from './src/schema.js';
import { estimateSequenceDuration } from './src/sequence.mjs';
import type { ComputerParams, ComputerSequence } from './src/types.js';
import { sequenceUsesTargetCoordinates, validateComputerParams, validateRevisionForActions, validateSequence } from './src/validation.js';

interface ComputerToolContext {
  model?: { input?: string[] };
  sessionManager: { getSessionFile(): string | undefined };
}

function disabled(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try { return (JSON.parse(raw) as Record<string, unknown>)['computer-use'] === false; }
  catch { return false; }
}

async function sequenceFromArtifact(filePath: string): Promise<ComputerSequence> {
  const bytes = await readFile(filePath);
  if (bytes.length > 1024 * 1024) throw Object.assign(new Error('Sequence artifact exceeds 1 MiB.'), { code: 'OVERSIZED_SEQUENCE' });
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw Object.assign(new Error('Sequence artifact is not valid JSON.'), { code: 'MALFORMED_SEQUENCE' }); }
  validateSequence(value);
  return value;
}

function errorShape(error: unknown): { code: string; message: string; retryable: boolean; artifacts?: { sequencePath?: string; tracePath?: string } } {
  const value = error as { code?: unknown; message?: unknown; retryable?: unknown; artifacts?: { sequencePath?: string; tracePath?: string } };
  return {
    code: typeof value?.code === 'string' ? value.code : 'COMPUTER_ERROR',
    message: typeof value?.message === 'string' ? value.message : String(error),
    retryable: value?.retryable === true,
    ...(value?.artifacts ? { artifacts: value.artifacts } : {}),
  };
}

function cleanupFailure(cleanupError: unknown, originalError: unknown): Error {
  const cleanup = errorShape(cleanupError); const original = errorShape(originalError);
  return Object.assign(
    new Error(`Input cleanup failed [${cleanup.code}]: ${cleanup.message}; original failure [${original.code}]: ${original.message}`, { cause: cleanupError }),
    {
      code: 'RELEASE_FAILED', retryable: true,
      ...(cleanup.artifacts ?? original.artifacts ? { artifacts: cleanup.artifacts ?? original.artifacts } : {}),
      originalCause: originalError,
    },
  );
}

export default function registerComputerUse(pi: ExtensionAPI) {
  installProcessTeardown();

  pi.registerTool({
    name: 'computer',
    label: 'Computer',
    description: 'Open, observe, and operate the visible Windows desktop through screenshots, accessibility references, universal keyboard/mouse actions, and deterministic timed sequences. Observations are bounded and full PNG/sequence/trace evidence is saved as session artifacts.',
    promptSnippet: 'Observe and operate visible applications with screenshot-relative coordinates or revision-scoped semantic references.',
    promptGuidelines: [
      'Use computer observe before acting; screenshot coordinates are target-relative by default, and semantic references are valid only for the latest observation revision.',
      'Prefer an exact window session for safe application work. A desktop session is an intentional global exception: its actions affect the current desktop/foreground without HWND binding.',
      'Use computer run_sequence for timing-sensitive or simultaneous input, and verify visible postconditions with a fresh observation.',
    ],
    executionMode: 'sequential',
    parameters: computerSchema,

    async execute(
      _toolCallId: string,
      rawParams: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ComputerToolContext,
    ) {
      let sessionPath: string | undefined;
      let params: ComputerParams | undefined;
      let client: Awaited<ReturnType<typeof runtimeRegistry.get>> | undefined;
      try {
        if (disabled()) throw Object.assign(new Error('The computer-use extension is disabled.'), { code: 'EXTENSION_DISABLED' });
        validateComputerParams(rawParams); params = rawParams;
        sessionPath = ctx?.sessionManager?.getSessionFile();
        if (!sessionPath) throw Object.assign(new Error('A persistent pie session path is required for computer runtime ownership and artifacts.'), { code: 'SESSION_PATH_REQUIRED' });
        client = await runtimeRegistry.get(sessionPath);
        let result;
        if (params.action === 'open') {
          await client.releaseAllHeldKnown();
          const sessionId = params.sessionId ?? `computer-${randomUUID()}`;
          const artifactDir = await artifactDirectory(sessionPath, sessionId);
          result = await client.request('open', { ...params, sessionId, artifactDir }, { signal, sessionId, allowNeedsReopen: true, timeoutMs: 30000 });
          client.markReopened();
        } else if (params.action === 'observe') {
          result = await client.request('observe', params, { signal, sessionId: params.sessionId, timeoutMs: 30000 });
        } else if (params.action === 'act') {
          result = await client.request('act', params, { signal, sessionId: params.sessionId, potential: potentialHeldForAction(params.input), timeoutMs: params.input.kind === 'wait' ? params.input.durationMs + 30000 : 30000 });
        } else if (params.action === 'run_sequence') {
          const potentialSequence = params.sequence ?? await sequenceFromArtifact(params.sequencePath!);
          validateRevisionForActions(sequenceUsesTargetCoordinates(potentialSequence), params.revision);
          result = await client.request('run_sequence', params, { signal, sessionId: params.sessionId, potential: potentialHeldForSequence(potentialSequence), timeoutMs: estimateSequenceDuration(potentialSequence) + 30000 });
        } else {
          await client.releaseAllHeldKnown();
          result = await client.request('close', params, { signal, sessionId: params.sessionId, timeoutMs: 30000, allowNeedsReopen: true });
        }
        return await buildToolResult(params.action, result, params.action === 'observe' && modelAcceptsImages(ctx.model));
      } catch (error) {
        if (sessionPath) {
          try {
            const cleanupClient = client ?? await runtimeRegistry.peek(sessionPath);
            await cleanupClient?.releaseAllHeldKnown();
          } catch (cleanupError) {
            throw buildToolError(cleanupFailure(cleanupError, error));
          }
        }
        throw buildToolError(error);
      }
    },
  } as any);

  pi.on('context', (event) => ({ messages: projectComputerImageContext(event.messages) }));

  pi.on('session_shutdown', async (_event: unknown, ctx: ComputerToolContext) => {
    const sessionPath = ctx?.sessionManager?.getSessionFile();
    if (sessionPath) await runtimeRegistry.shutdownSession(sessionPath);
  });
}
