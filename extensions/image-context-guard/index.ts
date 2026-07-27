/**
 * image-context-guard — deterministic outgoing-image projection.
 *
 * One of three context-lean layers (see AGENTS.md § Context-lean layers):
 * history compaction (pi), skill pruning (skill-pruner), and tool-result
 * pruning (tool-result-pruner). This extension is a fourth, request-safety
 * layer: it bounds the image parts projected into each provider request to the
 * active provider-qualified model's configured `maxImagesPerRequest` so
 * accumulated session images never reach a provider request limit.
 *
 * Hooks the `context` event (the only layer that sees the complete accumulated
 * message context immediately before each LLM call) and, non-destructively:
 *
 *   1. applies the computer-use newest-three screenshot bound (reused helper);
 *   2. applies the active model's total image bound, newest-first; and
 *   3. appends one bounded text notice describing any omission.
 *
 * The guard replaces computer-use's standalone `context` registration so a
 * single deterministic handler owns both passes (two independently ordered
 * handlers must not enforce overlapping limits). Durable session history is
 * never modified; only the deep-copied outgoing message array is projected.
 *
 * Toggle off via PIE_EXTENSION_TOGGLES_JSON { "image-context-guard": false },
 * the same global toggle computer-use / tool-result-pruner honor.
 *
 * The request-safety wiring lives in src/handler.ts (pure, unit-tested); this
 * module is the thin shim that supplies the agent dir (via `getAgentDir()`)
 * and the active model (via `ctx.model`).
 *
 * See this extension's README.md for the full contract.
 */

import type { ContextEvent, ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { projectContextHandler } from './src/handler.js';
import { loadImagePolicy } from './src/policy.js';

function disabled(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as Record<string, unknown>)['image-context-guard'] === false;
  } catch {
    return false;
  }
}

export default function registerImageContextGuard(pi: ExtensionAPI): void {
  pi.on('context', (event: ContextEvent, ctx) => {
    if (disabled()) return undefined;
    return projectContextHandler(event.messages, ctx.model, loadImagePolicy(getAgentDir()));
  });
}
