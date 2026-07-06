import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { runAsk } from './src/ask.js';
import { askUserSchema } from './src/types.js';

/** Honor the host's per-extension toggle (PIE_EXTENSION_TOGGLES_JSON, keyed by
 *  extension id). Mirrors skill-pruner's isExtensionDisabledByToggle so the
 *  Settings → Extensions checkbox actually disables this tool at runtime. */
function isDisabledByToggle(): boolean {
  const raw = process.env['PIE_EXTENSION_TOGGLES_JSON'];
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed['ask-user'] === false;
  } catch {
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'ask_user',
    label: 'Ask user',
    description:
      'Ask the user a clarifying question with a few preset answers and an optional free-form reply. ' +
      'Use when uncertain about intent, scope, trade-offs, or when a decision has material impact on direction. ' +
      'Prefer asking early over guessing wrong and reworking.',
    promptSnippet:
      'Ask the user a clarifying question; pauses the agent until the user picks an option or types a reply.',
    promptGuidelines: [
      'Use ask_user proactively when uncertain about intent, scope, or trade-offs — ambiguity resolved early saves rework.',
      'Prefer offering 2–4 concrete options over open-ended questions, but allow free-form when the decision needs it.',
      'Never use ask_user for status updates or to ask permission for already-described actions — just do them.',
    ],
    parameters: askUserSchema,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (isDisabledByToggle()) {
        return {
          content: [{ type: 'text' as const, text: 'The ask-user extension is disabled. Enable it in Settings → Extensions to ask the user clarifying questions.' }],
          details: { disabled: true },
          isError: true as const,
        };
      }
      return runAsk(params, { ui: ctx.ui as import('./src/ask.js').AskPort['ui'], signal, toolCallId });
    },
  });
}
