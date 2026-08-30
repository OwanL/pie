import type { AskUserInput, ReviewHumanVerificationMetadata } from './types.js';
import { CUSTOM_SENTINEL } from './types.js';

export interface AskPort {
  ui: {
    select(title: string, options: string[], opts?: { timeout?: number; signal?: AbortSignal; toolCallId?: string; allowCustom?: boolean; reviewMeta?: ReviewHumanVerificationMetadata }): Promise<string | undefined>;
    input(title: string, placeholder?: string, opts?: { timeout?: number; signal?: AbortSignal; toolCallId?: string; reviewMeta?: ReviewHumanVerificationMetadata }): Promise<string | undefined>;
  };
  signal?: AbortSignal;
  toolCallId?: string;
}

type AskResult = ReturnType<typeof answered> | ReturnType<typeof cancelled>;

export async function runAsk(input: AskUserInput, port: AskPort): Promise<AskResult> {
  const presetOptions = input.options.filter((option) => option !== CUSTOM_SENTINEL);
  const allowCustom = input.allowCustom !== false || presetOptions.length === 0;
  // Pass the question as the title only. The `context` rationale is rendered
  // separately by the webview (inline ask_user prompt) so it stays visually
  // distinct from the question instead of being mashed into the title and
  // flattened by CSS. The webview reads it from the tool-call input.
  const selectOptions = [...presetOptions];
  if (allowCustom) {
    selectOptions.push(CUSTOM_SENTINEL);
  }

  const picked = await port.ui.select(input.question, selectOptions, buildPromptOptions(port, input, allowCustom));
  if (picked === undefined) {
    return cancelled(input.reviewMeta);
  }

  if (picked !== CUSTOM_SENTINEL) {
    const source = presetOptions.includes(picked) ? 'option' : 'custom';
    return answered(picked, source, input.reviewMeta);
  }

  // Metadata follows the custom-input fallback too, while the bridge still
  // routes both requests through the caller's reviewer session.
  const custom = await port.ui.input('Your answer', undefined, buildPromptOptions(port, input));
  if (!custom?.trim()) {
    return cancelled(input.reviewMeta);
  }

  return answered(custom.trim(), 'custom', input.reviewMeta);
}

function buildPromptOptions(port: AskPort, input: AskUserInput, allowCustom?: boolean) {
  return {
    signal: port.signal,
    ...(allowCustom !== undefined ? { allowCustom } : {}),
    ...(port.toolCallId ? { toolCallId: port.toolCallId } : {}),
    ...(input.reviewMeta ? { reviewMeta: input.reviewMeta } : {}),
  };
}

function answered(answer: string, source: 'option' | 'custom', reviewMeta?: ReviewHumanVerificationMetadata) {
  return {
    content: [{ type: 'text' as const, text: answer }],
    details: { answer, source, cancelled: false, ...(reviewMeta ? { targetSessionId: reviewMeta.targetSessionId } : {}) },
    isError: false as const,
  };
}

function cancelled(reviewMeta?: ReviewHumanVerificationMetadata) {
  return {
    content: [{ type: 'text' as const, text: '[user cancelled the question]' }],
    details: { answer: '', source: 'cancelled' as const, cancelled: true, ...(reviewMeta ? { targetSessionId: reviewMeta.targetSessionId } : {}) },
    isError: false as const,
  };
}
