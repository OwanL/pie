/**
 * Pure context-handler core, extracted from index.ts so the request-safety
 * wiring (model + policy + projection -> outgoing messages) is unit-testable
 * without resolving the SDK package or touching the filesystem. index.ts is a
 * thin shim that supplies the agent dir (via `getAgentDir()`) and the active
 * model (via `ctx.model`).
 */

import type { ContextEvent } from '@earendil-works/pi-coding-agent';

import type { ResolvedImagePolicy } from './policy.js';
import { resolveImagePolicy } from './policy.js';
import { countImages, projectImageContext } from './projection.js';

type ContextMessage = ContextEvent['messages'][number];

/** Minimal view of the active provider-qualified model the guard binds to. */
export interface ActiveModel {
  provider: string;
  id: string;
  input: unknown;
}

export interface ContextHandlerResult {
  messages: ContextMessage[];
}

/**
 * Bound the outgoing image context for the active model. Returns undefined
 * when the projection is a no-op (no images, or no omission and no fail-safe
 * diagnostic), so the `context` event leaves pi's messages untouched.
 */
export function projectContextHandler(
  messages: readonly ContextMessage[],
  model: ActiveModel | undefined,
  policy: Map<string, number>,
): ContextHandlerResult | undefined {
  // Short-circuit: most LLM calls carry no images, so skip the policy lookup
  // and projection entirely. This keeps the guard out of the hot path.
  if (countImages(messages) === 0) return undefined;

  // The SDK type permits an undefined active model even though a provider call
  // should normally have one. Fail closed at zero images in that state rather
  // than allowing an unresolved request through without a provider-qualified
  // policy.
  const resolved: ResolvedImagePolicy = model
    ? resolveImagePolicy(model.provider, model.id, model.input, policy)
    : { maxImagesPerRequest: 0, configured: true };
  const result = projectImageContext(messages, {
    policy: resolved,
    model: model ? { provider: model.provider, id: model.id } : undefined,
  });
  if (!result.notice) return undefined;
  return { messages: result.messages };
}
