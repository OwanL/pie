/** Main-session additions only. Child loaders deliberately do not use this policy. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getInstructionResourcePaths, type InstructionResourceRootOptions } from '../resource-roots.js';

export const CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH = path.join(
  'harness', 'agent-instructions', 'APPEND_SYSTEM.md',
);

function readPrompt(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

export function readCentralAppendSystemPrompt(agentDir: string): string | undefined {
  if (typeof agentDir !== 'string' || !agentDir.trim()) return undefined;
  return readPrompt(path.join(agentDir, CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH));
}

export interface MainAppendSystemPromptOptions extends InstructionResourceRootOptions {
  /** The loader's exact project directory; no ancestor or unrelated project scanning. */
  cwd?: string;
  /** Explicit default-file override, primarily for source fixtures. */
  defaultPromptPath?: string;
  /** Must match the loader's trust state. Current main loaders use native trusted defaults. */
  isProjectTrusted?: () => boolean;
}

function fileIdentity(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Compose bundled → legacy authored user → personal → native eligible project additions. Native discovery
 * remains responsible for reading the selected project append and for SYSTEM.md.
 * File identity, never prompt content, removes duplicate source/default routes.
 * This does not change explicit base replacement or downstream prompt-entry toggles.
 */
export function centralAppendSystemPromptOverride(
  agentDir: string,
  options: MainAppendSystemPromptOptions = {},
): (base: string[]) => string[] {
  const defaultPath = options.defaultPromptPath
    ?? getInstructionResourcePaths(options).appendSystemPath;
  const legacyUserPath = path.join(agentDir, CENTRAL_APPEND_SYSTEM_PROMPT_RELATIVE_PATH);
  const personalPath = path.join(agentDir, 'APPEND_SYSTEM.md');
  return (base) => {
    const projectPath = options.cwd && path.join(options.cwd, '.pi', 'APPEND_SYSTEM.md');
    const nativePath = projectPath
      && (options.isProjectTrusted?.() ?? true)
      && fs.existsSync(projectPath)
      ? projectPath : personalPath;
    const nativeIdentity = fileIdentity(nativePath);
    const seen = new Set<string>();
    const additions: string[] = [];
    for (const filePath of [defaultPath, legacyUserPath, personalPath, nativePath]) {
      const identity = fileIdentity(filePath);
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (identity === nativeIdentity) {
        additions.push(...base);
      } else {
        const content = readPrompt(filePath);
        if (content !== undefined) additions.push(content);
      }
    }
    return additions;
  };
}
