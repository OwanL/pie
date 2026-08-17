import type { ExtensionInfo } from './protocol';

/** Display metadata for bundled extensions. The backend-reported loaded
 * extension IDs remain authoritative; unknown/package extensions get fallback
 * metadata so adding one never requires updating this catalog to make it visible.
 *
 * Lives in `shared/` (not `host/session-service/`) because the pure arch
 * reducer (`host/core/`) seeds its initial settings state from it; `core/` may
 * only import from `shared/`. */
export const KNOWN_EXTENSIONS: ExtensionInfo[] = [
  { id: 'subagent', label: 'Subagent', description: 'Delegate tasks to specialized sub-agents' },
  { id: 'safeguard', label: 'Safeguard', description: 'Block dangerous shell commands and file writes' },
  { id: 'cwd-skills', label: 'CWD Skills', description: 'Auto-discover skills from the working directory' },
  { id: 'skill-pruner', label: 'Skill Pruner', description: 'Score and prune skill descriptions by relevance' },
  { id: 'tool-result-pruner', label: 'Tool-result Pruner', description: 'Prune tool output bytes before they enter the model context' },
  { id: 'ask-user', label: 'Ask User', description: 'Ask the user a clarifying question with preset answers' },
  { id: 'session-reviewer', label: 'Session Reviewer', description: 'List, read, and review the currently-open session transcripts' },
  { id: 'session-changes', label: 'Session Changes', description: 'Inspect the files a session changed (manifest + diffs)' },
  { id: 'warm-bash', label: 'Warm Bash', description: 'Speed up the bash tool with a pre-warmed shell pool' },
  { id: 'copilot-model-discovery', label: 'Copilot Model Discovery', description: 'Keep the GitHub Copilot model catalog up to date' },
  { id: 'web-access-compat', label: 'Web Access Compat', description: 'Repair compatibility for the web-access package at startup' },
  { id: 'image-context-guard', label: 'Image Context Guard', description: 'Bound projected image parts to each model request limit' },
  { id: 'pi-web-access', label: 'Web Access', description: 'Search the web and fetch page or video content' },
];

/** Return the bundled extension catalog before a session has published runtime
 * metadata. Session analytics can be empty during cold browse or promotion,
 * but the settings surface must still be usable. Pure: returns a fresh copy. */
export function deriveBundledExtensions(): ExtensionInfo[] {
  return KNOWN_EXTENSIONS.map((extension) => ({ ...extension }));
}
