/**
 * Pie's centralized appended system prompt.
 *
 * `APPEND_SYSTEM.md` is authored at
 * `<agentDir>/harness/agent-instructions/APPEND_SYSTEM.md` instead of the
 * previous `<agentDir>` root. Pi's resource loader natively discovers
 * `<agentDir>/APPEND_SYSTEM.md` as the global append, and that same fallback
 * also applied to subagent resource loaders: a subagent created with empty
 * role instructions fell back to native discovery and inherited the
 * maintainer's main append. Relocating the file out of the agentDir root
 * removes it from every native discovery path; main-session loaders attach it
 * explicitly through `centralAppendSystemPromptOverride` while subagent
 * loaders (`harness/tools/subagent/runner.ts`) never receive the override.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** AgentDir-relative location of the centralized appended prompt. */
export const CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH = path.join(
  'harness',
  'agent-instructions',
  'APPEND_SYSTEM.md',
);

/** Read the centralized appended prompt. Returns `undefined` when the file is
 *  absent, unreadable, or blank, so a broken relocation fails open to the
 *  previous no-Pie-append behavior instead of breaking session startup. */
export function readCentralAppendSystemPrompt(agentDir: string): string | undefined {
  if (typeof agentDir !== 'string' || !agentDir.trim()) return undefined;
  const filePath = path.join(agentDir, CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the resource-loader `appendSystemPromptOverride` that attaches the
 * centralized append to main sessions, or `undefined` when the file is absent
 * so loaders keep Pi's exact native behavior.
 *
 * Pi natively resolves at most one append file: a trusted project's
 * `.pi/APPEND_SYSTEM.md` wins over the global agentDir file. The override
 * preserves that single-file precedence — natively discovered appends are
 * kept verbatim and the centralized append is only added when nothing was
 * discovered.
 */
export function centralAppendSystemPromptOverride(
  agentDir: string,
): ((base: string[]) => string[]) | undefined {
  const content = readCentralAppendSystemPrompt(agentDir);
  if (content === undefined) return undefined;
  return (base: string[]) => (base.length > 0 ? base : [content]);
}