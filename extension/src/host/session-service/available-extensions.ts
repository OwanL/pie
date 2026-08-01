import type { ExtensionInfo } from '../../shared/protocol';

/** Display metadata for bundled extensions. The backend-reported loaded
 * extension IDs remain authoritative; unknown/package extensions get fallback
 * metadata so adding one never requires updating this catalog to make it visible. */
const KNOWN_EXTENSIONS: ExtensionInfo[] = [
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

function extensionLabel(id: string): string {
  return id
    .replace(/^@/, '')
    .split(/[/-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Build menu entries from the extensions the backend actually loaded. */
export function deriveAvailableExtensions(activeExtensionIds: string[]): ExtensionInfo[] {
  const activeIds = new Set(activeExtensionIds.map((id) => id.trim()).filter(Boolean));
  const known = KNOWN_EXTENSIONS.filter((extension) => activeIds.delete(extension.id));
  const unknown = [...activeIds].sort().map((id) => ({
    id,
    label: extensionLabel(id),
    description: 'Loaded pi extension',
  }));
  return [...known, ...unknown];
}
