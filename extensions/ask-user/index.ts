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
    description: 'Ask one clarifying question with preset answers and an optional free-form reply.',
    promptSnippet: 'Ask the user a clarifying question and wait for their reply.',
    promptGuidelines: [
      'Use ask_user for material ambiguity, preferably with 2–4 options; never use it for status updates or needless permission.',
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
