import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { runAsk } from './src/ask.js';
import { askUserSchema } from './src/types.js';
import { ASK_USER_TOOL_NAME, isAutonomousModeEnabled } from '../../shared/autonomous-mode.js';

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
  // Main pie sessions also have a backend-level guard. This hook covers
  // in-process subagent sessions, which share the runtime preference but do not
  // pass through BackendServer's SessionContext setup.
  let removedByAutonomousMode = false;
  pi.on('before_agent_start', () => {
    const active = pi.getActiveTools();
    if (isAutonomousModeEnabled()) {
      if (active.includes(ASK_USER_TOOL_NAME)) {
        removedByAutonomousMode = true;
        pi.setActiveTools(active.filter((name) => name !== ASK_USER_TOOL_NAME));
      }
      return;
    }
    if (removedByAutonomousMode && !isDisabledByToggle()) {
      const configured = pi.getAllTools().some((tool) => tool.name === ASK_USER_TOOL_NAME);
      if (configured && !active.includes(ASK_USER_TOOL_NAME)) {
        pi.setActiveTools([...active, ASK_USER_TOOL_NAME]);
      }
    }
    removedByAutonomousMode = false;
  });

  pi.registerTool({
    name: ASK_USER_TOOL_NAME,
    label: 'Ask user',
    description: 'Ask one clarifying question with preset answers and an optional free-form reply.',
    promptSnippet: 'Ask the user a clarifying question and wait for their reply.',
    promptGuidelines: [
      'Use ask_user for material ambiguity, preferably with 2–4 options; never use it for status updates or needless permission.',
    ],
    parameters: askUserSchema,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      if (isAutonomousModeEnabled()) {
        return {
          content: [{ type: 'text' as const, text: 'ask_user is unavailable while autonomous mode is active.' }],
          details: { disabled: true, autonomousMode: true },
          isError: true as const,
        };
      }
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
