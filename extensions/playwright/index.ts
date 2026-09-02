import { randomUUID } from 'node:crypto';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { artifactDirectory } from './src/artifacts.js';
import { buildToolError, buildToolResult, modelAcceptsImages } from './src/result.js';
import { playwrightSchema } from './src/schema.js';
import { installProcessTeardown, runtimeRegistry } from './src/runtime-client.js';
import {
  DEFAULT_NAVIGATION_TIMEOUT_MS, DEFAULT_RUN_CODE_TIMEOUT_MS, MAX_TIMEOUT_MS,
  type ActParams, type OpenParams, type PlaywrightParams, type RunCodeParams,
} from './src/types.js';
import { validatePlaywrightParams } from './src/validation.js';

interface PlaywrightToolContext {
  model?: { input?: string[] };
  sessionManager: { getSessionFile(): string | undefined };
}

function disabled(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try { return (JSON.parse(raw) as Record<string, unknown>)['playwright'] === false; }
  catch { return false; }
}

function deadlineMs(params: PlaywrightParams): number {
  // The parent deadline is the disaster backstop on top of the sidecar's own
  // Playwright-level timeouts (which always win the race and produce typed
  // errors). The margin covers launch, observation, and screenshot work. A
  // sidecar that misses the parent deadline is force-terminated. When the
  // caller did not pin a timeout, use the hard public maximum so customized
  // per-session sidecar timeouts are never clipped by the backstop.
  const margin = 20_000;
  if (params.action === 'open') {
    const open = params as OpenParams;
    return (open.url !== undefined ? (open.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS) : 30_000) + margin;
  }
  if (params.action === 'observe') return 60_000 + margin;
  if (params.action === 'act') return ((params as ActParams).timeoutMs ?? MAX_TIMEOUT_MS) + margin;
  if (params.action === 'run_code') return ((params as RunCodeParams).timeout ?? DEFAULT_RUN_CODE_TIMEOUT_MS) + margin;
  return 60_000 + margin; // close
}

export default function registerPlaywright(pi: ExtensionAPI) {
  installProcessTeardown();

  pi.registerTool({
    name: 'playwright',
    label: 'Playwright',
    description:
      'Automate rendered web pages in an isolated, headless, Playwright-pinned Chromium: open pages, observe bounded AI accessibility snapshots with revision-checked [ref=eN] references, act (navigate/click/fill/type/press/select/check/hover/focus/upload/wait/tabs), run bounded Playwright run_code for uncommon APIs, export/import storage state, save downloads, and take explicit opt-in screenshots. '
      + 'State is an isolated BrowserContext per playwright session inside a session-owned sidecar; the user\'s visible browsers are never attached or affected. '
      + 'Prefer raw headless interfaces (HTTP, CLI, MCP, web fetch) when rendering is unnecessary; use the computer tool only for surfaces outside the page boundary (browser chrome, native dialogs, desktop apps).',
    promptSnippet: 'Operate rendered web pages in an isolated headless Chromium via revision-checked accessibility refs; observe first, screenshot only on request.',
    promptGuidelines: [
      'Prefer raw headless interfaces (HTTP, CLI, MCP) when rendered browser behavior is unnecessary; use playwright when work requires a DOM, JavaScript execution, accessibility state, or rendering; use computer only for browser chrome, native dialogs, or other surfaces outside the page boundary.',
      'Use playwright observe before acting and target elements by ref from the latest observation revision of that page. Playwright refs go in the ref field with their revision, never in selectors. A stale ref fails closed with STALE_REF — call playwright observe again instead of retrying.',
      'Playwright invalidates previous refs after every state-changing action and returns a fresh bounded observation by default (observation.mode "none" opts out for deliberate repetitive work).',
      'Request playwright screenshots only for visual evidence; they are explicit opt-in and are also written as session artifacts. Text-only models receive the artifact path instead of an inline image.',
      'Verify a page-visible postcondition after playwright actions (URL, text, selector, or a run_code assertion) instead of assuming an accepted action succeeded.',
      'Use playwright run_code as the trusted escape hatch for uncommon Playwright APIs, assertions, and atomic multi-step probes; prefer playwright typed actions for ordinary work. Playwright storage state (cookies/local storage/IndexedDB) is explicit artifact-based import/export; session storage is unsupported.',
    ],
    executionMode: 'sequential',
    parameters: playwrightSchema,

    async execute(
      _toolCallId: string,
      rawParams: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: PlaywrightToolContext,
    ) {
      try {
        if (disabled()) throw Object.assign(new Error('The playwright extension is disabled.'), { code: 'EXTENSION_DISABLED' });
        validatePlaywrightParams(rawParams);
        const params = rawParams;
        const sessionPath = ctx?.sessionManager?.getSessionFile();
        if (!sessionPath) throw Object.assign(new Error('A persistent pie session path is required for playwright runtime ownership and artifacts.'), { code: 'SESSION_PATH_REQUIRED' });
        const client = await runtimeRegistry.get(sessionPath);
        const timeoutMs = deadlineMs(params);

        let result;
        if (params.action === 'open') {
          const sessionId = params.sessionId ?? `pw-${randomUUID()}`;
          const artifactDir = await artifactDirectory(sessionPath, sessionId);
          result = await client.request('open', { ...params, sessionId, artifactDir }, { signal, sessionId, timeoutMs, allowNeedsReopen: true });
          client.markReopened();
        } else if (params.action === 'observe') {
          result = await client.request('observe', params, { signal, sessionId: params.sessionId, timeoutMs });
        } else if (params.action === 'act') {
          result = await client.request('act', params, { signal, sessionId: params.sessionId, timeoutMs });
        } else if (params.action === 'run_code') {
          result = await client.request('run_code', params, { signal, sessionId: params.sessionId, timeoutMs });
        } else {
          result = await client.request('close', params, { signal, sessionId: params.sessionId, timeoutMs, allowNeedsReopen: true });
        }
        const wantsImage = result?.screenshot !== undefined;
        return await buildToolResult(params.action, result, wantsImage && modelAcceptsImages(ctx.model));
      } catch (error) {
        throw buildToolError(error);
      }
    },
  } as any);

  pi.on('session_shutdown', async (_event: unknown, ctx: PlaywrightToolContext) => {
    const sessionPath = ctx?.sessionManager?.getSessionFile();
    if (sessionPath) await runtimeRegistry.shutdownSession(sessionPath);
  });
}
