import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  currentChildToolRuntimeOwner,
  type ChildToolRuntimeOwner,
} from '../../agent-processes/lib/process-lifecycle/child-tool-runtime-owner.js';
import { artifactDirectory, childArtifactDirectory } from './artifacts.js';
import { buildToolError, buildToolResult, modelAcceptsImages } from './result.js';
import {
  desktopCoordinator,
  childRuntimeOwnerLabel,
  type DesktopCoordinator,
  type DesktopRuntimeIdentity,
  type DesktopScope,
} from './desktop-ownership.js';
import {
  installProcessTeardown, potentialHeldForAction, potentialHeldForSequence, runtimeRegistry,
  type RuntimeClient,
} from './runtime-client.js';
import { computerSchema } from './schema.js';
import { estimateSequenceDuration } from './sequence.mjs';
import type { ComputerParams, ComputerSequence } from './types.js';
import { sequenceUsesTargetCoordinates, validateComputerParams, validateRevisionForActions, validateSequence } from './validation.js';

interface ComputerToolContext {
  model?: { input?: string[] };
  sessionManager?: {
    getSessionFile?: () => string | undefined;
    getSessionName?: () => string | undefined;
  };
}

interface RuntimeAccess {
  get(sessionPath: string): Promise<RuntimeClient>;
  peek(sessionPath: string): Promise<RuntimeClient | undefined>;
  shutdownSession(sessionPath: string): Promise<void>;
  getForChild(owner: ChildToolRuntimeOwner): RuntimeClient;
  peekForChild(owner: ChildToolRuntimeOwner): RuntimeClient | undefined;
  shutdownChild(owner: ChildToolRuntimeOwner): Promise<void>;
}

interface ComputerUseDependencies {
  desktopCoordinator?: DesktopCoordinator;
  runtimeRegistry?: RuntimeAccess;
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

function sessionOwnerLabel(ctx: ComputerToolContext, sessionPath: string): string {
  const title = ctx.sessionManager?.getSessionName?.()?.trim();
  const basename = path.basename(sessionPath, path.extname(sessionPath));
  return title ? `Pie session “${title}”` : `Pie session “${basename || 'untitled'}”`;
}

async function peekRuntime(registry: RuntimeAccess, runtime: DesktopRuntimeIdentity): Promise<RuntimeClient | undefined> {
  return runtime.kind === 'child' ? registry.peekForChild(runtime.owner) : await registry.peek(runtime.sessionPath);
}

async function releaseRuntime(registry: RuntimeAccess, runtime: DesktopRuntimeIdentity): Promise<void> {
  const client = await peekRuntime(registry, runtime);
  if (!client) return;
  await client.releaseAllHeldKnown();
  if (client.hasHeldInput) {
    throw Object.assign(new Error('Held keyboard or pointer input remains unresolved after release.'), { code: 'RELEASE_FAILED', retryable: true });
  }
}

async function shutdownRuntime(registry: RuntimeAccess, runtime: DesktopRuntimeIdentity): Promise<void> {
  const client = await peekRuntime(registry, runtime);
  if (client) await client.releaseAllHeldKnown();
  if (client?.hasHeldInput) {
    throw Object.assign(new Error('Held keyboard or pointer input remains unresolved; the computer sidecar was not safely closed.'), { code: 'RELEASE_FAILED', retryable: true });
  }
  if (runtime.kind === 'child') await registry.shutdownChild(runtime.owner);
  else await registry.shutdownSession(runtime.sessionPath);
  if (client?.hasHeldInput) {
    throw Object.assign(new Error('Computer sidecar shutdown did not confirm that all held input was released.'), { code: 'RELEASE_FAILED', retryable: true });
  }
}

function primarySessionPath(ctx: ComputerToolContext): string | undefined {
  return ctx.sessionManager?.getSessionFile?.();
}

function reportLifecycleCleanupFailure(boundary: string, error: unknown): void {
  const value = error as { code?: unknown; message?: unknown };
  console.error(JSON.stringify({
    source: 'pie:computer-use',
    event: `${boundary}_cleanup_blocked`,
    code: typeof value?.code === 'string' ? value.code : 'DESKTOP_CLEANUP_BLOCKED',
    message: typeof value?.message === 'string' ? value.message : String(error),
  }));
}

export default function registerComputer(pi: ExtensionAPI, dependencies: ComputerUseDependencies = {}) {
  const coordinator = dependencies.desktopCoordinator ?? desktopCoordinator;
  const registry = dependencies.runtimeRegistry ?? runtimeRegistry;
  if (!dependencies.desktopCoordinator && !dependencies.runtimeRegistry) {
    installProcessTeardown(async () => {
      await coordinator.shutdownAll(async (runtime) => await shutdownRuntime(registry, runtime));
    });
  }

  pi.registerTool({
    name: 'computer',
    label: 'Computer',
    description: 'Open, observe, and operate the visible Windows desktop through screenshots, accessibility references, universal keyboard/mouse actions, and deterministic timed sequences. Observations are bounded and full PNG/sequence/trace evidence is saved as session artifacts.',
    promptSnippet: 'Observe and operate visible applications with screenshot-relative coordinates or revision-scoped semantic references.',
    promptGuidelines: [
      'Use computer observe before acting; screenshot coordinates are target-relative by default, and semantic references are valid only for the latest observation revision.',
      'Route in-page browser work (DOM, page content, forms, rendered web apps) to the playwright tool; use computer only for browser chrome, native dialogs, and other desktop surfaces outside the page boundary.',
      'Prefer an exact window session for safe application work; exact-window input safely reacquires and proves its PID/HWND when foreground was stolen. A desktop session is a global exception: observe immediately before every action and pass that revision, because input is refused if foreground changed.',
      'open and run_sequence accept optional screenshot/tree/state to perform an inline observation (initial or trailing) exactly like observe, combining target registration/execution with grounding in one call.',
      'For path launches, pass a native executable (.exe) or a bare name/shortcut that resolves to one; shell wrappers and scripts cannot be correlated by PID/HWND and are rejected with an actionable error.',
      'A vanished exact HWND rebinds automatically only to one unique replacement window with the same PID and process identity, invalidating old semantic refs; if no unique replacement exists, re-open the target.',
      'For repeatable visible probes, prefer stable labels/roles/menu actions over positional control indexes or incidental node names; run a focused scenario before replaying a full viewport/configuration matrix.',
      'After an action opens a native dialog or another window, discover/open that new exact foreground target before continuing; do not keep typing through the parent target.',
      'Use computer run_sequence for timing-sensitive or simultaneous input, and verify visible postconditions with a fresh observation.',
      'Computer use is globally exclusive across Pie agents/processes; if DESKTOP_BUSY, do not retry or take over—report the named owner.'
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
      let params: ComputerParams | undefined;
      let sequenceForRun: ComputerSequence | undefined;
      let client: RuntimeClient | undefined;
      try {
        if (disabled()) throw Object.assign(new Error('The computer-use extension is disabled.'), { code: 'EXTENSION_DISABLED' });
        validateComputerParams(rawParams); params = rawParams;
        if (params.action === 'run_sequence') {
          sequenceForRun = params.sequence ?? await sequenceFromArtifact(params.sequencePath!);
          validateRevisionForActions(sequenceUsesTargetCoordinates(sequenceForRun), params.revision);
        }

        const childOwner = currentChildToolRuntimeOwner();
        let scope: DesktopScope;
        if (childOwner) {
          scope = coordinator.child(
            childOwner,
            `Sub-agent “${childRuntimeOwnerLabel(childOwner)}”`,
            async (runtime) => await shutdownRuntime(registry, runtime),
          );
        } else {
          const persistentPath = primarySessionPath(ctx);
          if (!persistentPath) throw Object.assign(new Error('A persistent pie session path is required for primary computer runtime ownership and artifacts.'), { code: 'SESSION_PATH_REQUIRED' });
          scope = coordinator.primary(persistentPath, sessionOwnerLabel(ctx, persistentPath));
        }

        return await coordinator.run(
          scope,
          async (runtime) => {
            try {
              client = runtime.kind === 'child'
                ? registry.getForChild(runtime.owner)
                : await registry.get(runtime.sessionPath);
              let result;
              if (params!.action === 'open') {
                await client.releaseAllHeldKnown();
                const sessionId = params!.sessionId ?? `computer-${randomUUID()}`;
                const artifactDir = runtime.kind === 'child'
                  ? await childArtifactDirectory(runtime.owner.id, sessionId)
                  : await artifactDirectory(runtime.sessionPath, sessionId);
                const observesInline = params!.screenshot === true || params!.tree === true || params!.state === true;
                result = await client.request('open', { ...params, sessionId, artifactDir }, { signal, sessionId, allowNeedsReopen: true, timeoutMs: observesInline ? 60000 : 30000 });
                client.markReopened();
              } else if (params!.action === 'observe') {
                result = await client.request('observe', params, { signal, sessionId: params!.sessionId, timeoutMs: 30000 });
              } else if (params!.action === 'act') {
                result = await client.request('act', params, { signal, sessionId: params!.sessionId, potential: potentialHeldForAction(params!.input), timeoutMs: params!.input.kind === 'wait' ? params!.input.durationMs + 30000 : 30000 });
              } else if (params!.action === 'run_sequence') {
                const potentialSequence = sequenceForRun!;
                const observesInline = params!.screenshot === true || params!.tree === true || params!.state === true;
                result = await client.request('run_sequence', params, { signal, sessionId: params!.sessionId, potential: potentialHeldForSequence(potentialSequence), timeoutMs: estimateSequenceDuration(potentialSequence) + (observesInline ? 60000 : 30000) });
              } else {
                await client.releaseAllHeldKnown();
                result = await client.request('close', params, { signal, sessionId: params!.sessionId, timeoutMs: 30000, allowNeedsReopen: true });
              }
              return await buildToolResult(params!.action, result, (params!.action === 'observe' || params!.action === 'open' || params!.action === 'run_sequence') && modelAcceptsImages(ctx.model));
            } catch (error) {
              try {
                const cleanupClient = client ?? await peekRuntime(registry, runtime);
                await cleanupClient?.releaseAllHeldKnown();
              } catch (cleanupError) {
                throw cleanupFailure(cleanupError, error);
              }
              throw error;
            }
          },
        );
      } catch (error) {
        throw buildToolError(error);
      }
    },
  } as any);

  pi.on('agent_start', async (_event: unknown, ctx: ComputerToolContext) => {
    const sessionPath = primarySessionPath(ctx);
    if (sessionPath) coordinator.beginPrimary(sessionPath, sessionOwnerLabel(ctx, sessionPath));
  });

  pi.on('agent_settled', async (_event: unknown, ctx: ComputerToolContext) => {
    const sessionPath = primarySessionPath(ctx);
    if (!sessionPath) return;
    const scope = coordinator.findPrimary(sessionPath);
    if (!scope) return;
    try { await coordinator.settle(scope, async (runtime) => await releaseRuntime(registry, runtime)); }
    catch (error) {
      reportLifecycleCleanupFailure('agent_settled', error);
      throw error;
    }
  });

  pi.on('session_shutdown', async (_event: unknown, ctx: ComputerToolContext) => {
    const sessionPath = primarySessionPath(ctx);
    if (!sessionPath) return;
    const scope = coordinator.findPrimary(sessionPath);
    try {
      if (scope) await coordinator.shutdown(scope, async (runtime) => await shutdownRuntime(registry, runtime));
      else await shutdownRuntime(registry, { kind: 'persistent', sessionPath: path.resolve(sessionPath) });
    } catch (error) {
      reportLifecycleCleanupFailure('session_shutdown', error);
      throw error;
    }
  });
}
