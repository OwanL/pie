import * as path from 'node:path';

/**
 * Resolve the settings.json path from PI_CODING_AGENT_DIR.
 * Returns null if the env var is not set.
 */
export function resolveSettingsPath(): string | null {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (!agentDir) {
    return null;
  }
  return path.join(agentDir, 'settings.json');
}
