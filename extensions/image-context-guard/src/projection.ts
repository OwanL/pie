/**
 * Deterministic outgoing-image projection.
 *
 * One guard owns both passes (see the extension README's projection contract):
 *
 *   1. Source-specific bound: reuse the computer-use newest-three screenshot
 *      projection so the latest observation always wins over stale captures.
 *   2. Per-model total bound: traverse the resulting context newest-first and
 *      retain at most `maxImagesPerRequest` image parts regardless of producer
 *      (user attachments, `read`, `computer`, custom tools, subagent turns).
 *
 * The projection is non-destructive: durable session entries are never modified,
 * only the deep-copied outgoing message array returned to the `context` event.
 * One aggregate text notice is appended to the outgoing projection when images
 * are omitted (or when the active model is absent from the generated policy and
 * the conservative fail-safe is in effect). Notices exist only in the outgoing
 * projection, never in durable session history, so repeated requests do not
 * accumulate synthetic notices.
 */

import type { ContextEvent } from '@earendil-works/pi-coding-agent';

import { projectComputerImageContext } from '../../computer-use/src/context.js';
import type { ResolvedImagePolicy } from './policy.js';

type ContextMessage = ContextEvent['messages'][number];

interface ImageContentPart {
  type: 'image';
}

interface ActiveModel {
  provider: string;
  id: string;
}

export interface ProjectionInput {
  policy: ResolvedImagePolicy;
  /** Active provider-qualified identity. Undefined is handled fail-closed by
   *  projecting zero images with an explicit diagnostic. */
  model: ActiveModel | undefined;
}

export interface ProjectionResult {
  messages: ContextMessage[];
  /** Agent-facing notice text, or undefined when no images were omitted and
   *  no fail-safe diagnostic applies. */
  notice: string | undefined;
}

function contentArray(message: ContextMessage): unknown[] | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? content : undefined;
}

function isImagePart(part: unknown): part is ImageContentPart {
  return typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'image';
}

/** Count every image content part across the outgoing context. */
export function countImages(messages: readonly ContextMessage[]): number {
  let count = 0;
  for (const message of messages) {
    const content = contentArray(message);
    if (content) for (const part of content) if (isImagePart(part)) count += 1;
  }
  return count;
}

/**
 * Retain at most `max` image parts, newest-first, across every message. A
 * `max` of zero omits all image parts. Mirrors the computer-use newest-first
 * walk so the two passes compose deterministically: the newest overall images
 * survive the total bound, never a provider-specific subset.
 */
function boundTotalImages(messages: readonly ContextMessage[], max: number): ContextMessage[] {
  if (max < 0) return [...messages];
  let remaining = max;
  const projected = [...messages];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = contentArray(messages[messageIndex]);
    if (!content) continue;

    const removed = new Set<number>();
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      if (!isImagePart(content[partIndex])) continue;
      if (remaining > 0) remaining -= 1;
      else removed.add(partIndex);
    }

    if (removed.size > 0) {
      projected[messageIndex] = {
        ...messages[messageIndex],
        content: content.filter((_part, partIndex) => !removed.has(partIndex)),
      } as ContextMessage;
    }
  }
  return projected;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Notice when the context hook cannot resolve the serving identity. */
function unresolvedModelNotice(omitted: number): string {
  return [
    '[Pie image delivery]',
    `${plural(omitted, 'session image')} ${omitted === 1 ? 'was' : 'were'} omitted because Pie could not resolve the active provider-qualified model's image capability.`,
    'Do not infer their contents. Retry after selecting a model or use available textual evidence.',
  ].join('\n');
}

/** Notice for a text-only active model: every image is omitted. */
function unsupportedInputNotice(provider: string, id: string, omitted: number): string {
  return [
    '[Pie image delivery]',
    `${plural(omitted, 'session image')} ${omitted === 1 ? 'was' : 'were'} omitted because the active model ${provider}/${id} does not accept image input.`,
    'Do not infer their contents. Use textual evidence or delegate to an image-capable subagent.',
  ].join('\n');
}

/** Notice for an image-capable model whose configured maximum was exceeded. */
function imageBudgetNotice(provider: string, id: string, max: number, omitted: number): string {
  return [
    '[Pie image budget]',
    `The active model ${provider}/${id} accepts at most ${plural(max, 'image')} per request.`,
    `${plural(omitted, 'older session image')} ${omitted === 1 ? 'was' : 'were'} omitted from this request; durable session history was not changed.`,
    'Use the original artifact path, re-read/re-observe the relevant image, or delegate a focused',
    'inspection with modelRequirements.inputKinds=["image"]. Do not infer omitted image contents.',
  ].join('\n');
}

/** Diagnostic for an image-capable model absent from the generated policy. */
function failSafeNotice(provider: string, id: string, max: number, omitted: number): string {
  const lines = [
    '[Pie image policy]',
    `The active model ${provider}/${id} has no configured maxImagesPerRequest in the generated catalog;`,
    `using a conservative fail-safe of ${plural(max, 'image')} per request.`,
  ];
  if (omitted > 0) {
    lines.push(
      `${plural(omitted, 'older session image')} ${omitted === 1 ? 'was' : 'were'} omitted from this request; durable session history was not changed.`,
    );
  }
  lines.push(
    `Add maxImagesPerRequest to models.yaml for ${provider}/${id} (then run \`npm run sync-models\`).`,
    'Do not infer omitted image contents.',
  );
  return lines.join('\n');
}

/** Append the notice as a transient (outgoing-only) custom message that pi
 *  converts to a user-role turn for the provider request. It is never persisted
 *  to the session because it lives only in the `context` event's deep copy. */
function appendNotice(messages: ContextMessage[], notice: string): ContextMessage[] {
  return [
    ...messages,
    {
      role: 'custom',
      customType: 'pie-image-context',
      content: notice,
      display: false,
      timestamp: Date.now(),
    } as ContextMessage,
  ];
}

/**
 * Project the outgoing context against the active model's image policy.
 *
 * Pass order is fixed: computer newest-three first, then the per-model total
 * bound on the resulting complete context. The notice reports the final omitted
 * count across both passes and distinguishes unsupported input, count
 * exhaustion, and a missing policy (fail-safe).
 */
export function projectImageContext(
  messages: readonly ContextMessage[],
  input: ProjectionInput,
): ProjectionResult {
  const originalCount = countImages(messages);
  if (originalCount === 0) {
    return { messages: [...messages], notice: undefined };
  }

  // Pass 1: source-specific newest-three computer screenshot bound.
  const afterComputerPass = projectComputerImageContext(messages);
  // Pass 2: per-model total bound on the complete context.
  const projected = boundTotalImages(afterComputerPass, input.policy.maxImagesPerRequest);

  const finalCount = countImages(projected);
  const omitted = originalCount - finalCount;

  const { maxImagesPerRequest, configured } = input.policy;
  const model = input.model;

  // A context event should normally carry the active model, but the SDK type
  // permits undefined. Fail closed instead of allowing an unbounded image
  // request through an unresolved provider/model boundary.
  if (!model) {
    const text = unresolvedModelNotice(omitted);
    return { messages: appendNotice(projected, text), notice: text };
  }
  const { provider, id } = model;

  // Fail-safe diagnostic: an image-capable model absent from the generated
  // policy must still be bounded and must announce the gap — never silently
  // send an unbounded (or stale-policy) image context.
  if (!configured) {
    const text = failSafeNotice(provider, id, maxImagesPerRequest, omitted);
    return { messages: appendNotice(projected, text), notice: text };
  }

  if (omitted === 0) {
    return { messages: projected, notice: undefined };
  }

  const text = maxImagesPerRequest === 0
    ? unsupportedInputNotice(provider, id, omitted)
    : imageBudgetNotice(provider, id, maxImagesPerRequest, omitted);
  return { messages: appendNotice(projected, text), notice: text };
}
