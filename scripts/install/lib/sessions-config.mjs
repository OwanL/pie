// Shared settings.json#sessionDir + legacy-session-import orchestration for the
// pie installers.
//
// install.ps1 (now install.bat) inspects settings.json#sessionDir, rewrites it
// to the canonical "data/outcomes/sessions" store (so `pi` writes session JSONL
// to the repo-local location even when launched from an arbitrary cwd), backs up
// the prior settings.json, and imports legacy session history from the prior
// configured dir (non-recursive) plus the default legacy roots (recursive).
// install.sh runs the simpler `scripts/migrate-local-sessions.mjs` (default
// roots only, no settings.json rewrite). This module encapsulates the Windows
// installer's fuller orchestration so the native install.bat can delegate to it
// (batch cannot parse/rewrite JSON), while install.sh keeps its own simpler
// flow. The file-merge core is scripts/install/lib/sessions.mjs (pure, tested).
//
// `configureSessions` performs real filesystem mutations (settings.json backup +
// rewrite, session file copy/merge) against the repo it is given, so it is
// exercised against a temp repo skeleton in the test rather than via injected
// fs ops. It returns the human-readable progress lines instead of printing them,
// so callers (run.mjs) and tests can assert on them.

import os from 'node:os';
import path from 'node:path';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';

import { readJsonFile, writeJsonFile } from './json.mjs';
import { directoryHasJsonlFiles, mergeLegacySessions } from './sessions.mjs';

/** Canonical machine-local session store, relative to the repo root. */
export const DESIRED_SESSION_DIR = 'data/outcomes/sessions';

/**
 * Resolve a settings.json `sessionDir` value to an absolute path, honouring
 * `~`, `~/`, `~\` home-relative and absolute values. Relative values (other than
 * ~) return null (the installer replaces them with the canonical store rather
 * than guessing a base). Mirrors install.ps1 Resolve-ConfiguredSessionDir.
 * @param {string} value
 * @param {{ homeDir?: string }} [options]
 * @returns {string | null}
 */
export function resolveConfiguredSessionDir(value, { homeDir } = {}) {
  if (!value) return null;
  const home = homeDir ?? os.homedir();
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  if (path.isAbsolute(value)) return value;
  return null;
}

/**
 * Inspect settings.json#sessionDir, rewrite it to the canonical store if needed
 * (backing up the prior file), and migrate (or merge) legacy session history
 * into the checkout-local store. Mirrors install.ps1's session block exactly:
 * default legacy roots are imported recursively; a prior configured sessionDir
 * is imported non-recursively; sources are de-duplicated; a source that resolves
 * to the destination is skipped.
 *
 * @param {{ repoRoot: string, homeDir?: string }} input
 * @returns {{
 *   lines: string[],
 *   newSessions: string,
 *   settingsRewritten: boolean,
 *   migrated: boolean,
 * }}
 */
export function configureSessions({ repoRoot, homeDir }) {
  const lines = [];
  const home = homeDir ?? os.homedir();
  const outcomesRoot = path.join(repoRoot, 'data', 'outcomes');
  const newSessions = path.join(outcomesRoot, 'sessions');
  const desiredSessionDir = DESIRED_SESSION_DIR;

  // Discover default legacy sources (recursive). Only roots that actually hold
  // session files are worth importing.
  const importSources = [];
  const defaultLegacySessions = path.join(home, '.pi', 'agent', 'sessions');
  const legacyRepoLocalSessions = path.join(repoRoot, 'data', 'sessions');
  const legacyAgentSessions = path.join(repoRoot, 'sessions');
  for (const legacyRoot of [defaultLegacySessions, legacyRepoLocalSessions, legacyAgentSessions]) {
    if (directoryHasJsonlFiles(legacyRoot)) {
      importSources.push({ path: legacyRoot, recursive: true });
    }
  }

  // Inspect / rewrite settings.json#sessionDir.
  const settingsPath = path.join(repoRoot, 'settings.json');
  let settingsRewritten = false;
  if (existsSync(settingsPath)) {
    try {
      const settings = readJsonFile(settingsPath, { fallback: null });
      if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
        const hasSessionDir = Object.prototype.hasOwnProperty.call(settings, 'sessionDir');
        if (hasSessionDir) {
          const configured = String(settings.sessionDir);
          const resolved = resolveConfiguredSessionDir(configured, { homeDir: home });
          const exists = !!(resolved && existsSync(resolved) && statSync(resolved).isDirectory());
          if (configured !== desiredSessionDir) {
            const backup = `${settingsPath}.session-dir.${Date.now()}.bak`;
            copyFileSync(settingsPath, backup);
            settings.sessionDir = desiredSessionDir;
            // BOM-less UTF-8, 2-space indent, no trailing newline: matches the
            // git-tracked settings.json style and the shared json.mjs writer used
            // by repair-settings, so a second run is a no-op.
            writeJsonFile(settingsPath, settings, { trailingNewline: false });
            settingsRewritten = true;
            lines.push(`==> Updated sessionDir in settings.json to '${desiredSessionDir}'`);
            lines.push(`==> Backed up the previous settings.json to ${backup}`);
            if (exists && resolved !== newSessions) {
              importSources.push({ path: resolved, recursive: false });
              lines.push(`==> Will import legacy session history from configured sessionDir '${resolved}'`);
            } else if (resolved && resolved === newSessions) {
              lines.push(`==> sessionDir already points at '${desiredSessionDir}'`);
            } else if (!resolved) {
              lines.push(`WARN: The previous sessionDir value '${configured}' could not be resolved safely, so it was replaced with '${desiredSessionDir}'.`);
            } else {
              lines.push(`==> configured sessionDir '${resolved}' has no session files to import`);
            }
          }
        } else {
          const backup = `${settingsPath}.session-dir.${Date.now()}.bak`;
          copyFileSync(settingsPath, backup);
          settings.sessionDir = desiredSessionDir;
          writeJsonFile(settingsPath, settings, { trailingNewline: false });
          settingsRewritten = true;
          lines.push(`==> Added sessionDir to settings.json so PI uses '${desiredSessionDir}'`);
          lines.push(`==> Backed up the previous settings.json to ${backup}`);
        }
      }
    } catch (error) {
      lines.push(`WARN: Failed to inspect settings.json for sessionDir overrides: ${error && error.message ? error.message : error}`);
    }
  }

  // De-duplicate / normalize import sources by resolved path + recursiveness,
  // skipping non-directories (matches install.ps1's normalization loop).
  const seen = new Set();
  const normalized = [];
  for (const source of importSources) {
    if (!existsSync(source.path) || !statSync(source.path).isDirectory()) continue;
    const resolvedSource = path.resolve(source.path);
    const key = `${resolvedSource}|${source.recursive}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ path: resolvedSource, recursive: source.recursive });
  }

  // Run the migration. The verb ("Migrating" vs "Merging") reflects whether the
  // destination already holds sessions; install.ps1 recomputes this after each
  // source import, so we do too.
  const resolvedNewSessions = path.resolve(newSessions);
  let hasRepoSessions = directoryHasJsonlFiles(newSessions);
  let migrated = false;
  if (normalized.length > 0) {
    mkdirSync(outcomesRoot, { recursive: true });
    for (const source of normalized) {
      if (source.path === resolvedNewSessions) {
        lines.push(`==> session history already points at '${newSessions}' - skipping migration`);
        continue;
      }
      const verb = hasRepoSessions ? 'Merging' : 'Migrating';
      lines.push(`==> ${verb} session history from '${source.path}' into '${newSessions}'`);
      mkdirSync(newSessions, { recursive: true });
      const { perSource } = mergeLegacySessions({
        sources: [{ path: source.path, recursive: source.recursive }],
        destination: newSessions,
      });
      // Per-source report mirrors scripts/migrate-local-sessions.mjs (explicit
      // form) so install.bat's output matches install.ps1's per-import lines.
      const r = perSource[0].result;
      lines.push(
        `==> Imported ${r.copied} new session file(s); refreshed ${r.updated} newer file(s); ` +
        `preserved ${r.conflicts} conflicting backup file(s); skipped ${r.identical} identical file(s) ` +
        `from ${source.path}`,
      );
      hasRepoSessions = directoryHasJsonlFiles(newSessions);
    }
    migrated = true;
  } else if (hasRepoSessions) {
    lines.push(`==> session history already present in the local data/outcomes/sessions directory - no legacy migration needed`);
  } else {
    lines.push(`==> No existing session history found to migrate`);
  }

  return { lines, newSessions, settingsRewritten, migrated };
}
