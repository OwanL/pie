import { getAgentDir, type BeforeAgentStartEvent, type ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { rewritePieHarnessPrompt } from '../shared/pie-harness-prompt.js';

/** Give every session using this config the pie identity without replacing
 * pi's dynamically generated tool snippets, guidelines, or context sections. */
export default function registerHarnessPrompt(pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  pi.on('before_agent_start', (event: BeforeAgentStartEvent) => ({
    systemPrompt: rewritePieHarnessPrompt(event.systemPrompt, agentDir),
  }));
}
