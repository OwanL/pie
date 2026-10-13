/**
 * Session-scoped MCP server overrides.
 *
 * The pinned `pi-mcp-adapter` reads MCP config only at session start and
 * merges a fixed set of files (config discovery is project/user scoped), so a
 * server disablement that applies to one session only cannot use the project
 * `.pi/mcp.json` layer every session shares. The adapter does accept a
 * `--mcp-config <path>` argv override, which replaces ONLY the highest
 * precedence discovery layer (the Pi-agent-dir `mcp.json`); lower layers
 * (`~/.config/mcp/mcp.json`, `.agents/*`, `.mcp.json`, `.pi/mcp.json`) still
 * merge beneath it.
 *
 * pie exploits that seam for per-session toggles: each session gets a
 * sibling override file (`<sessionPath>.mcp-overrides.json`) containing the
 * agent-dir definitions (so replacing that layer does not drop them) plus one
 * `{ disabled: true }` flag entry per session disable. Enabling removes the
 * session flag; it never overrides a global/project disable. Explicit metadata
 * separates session disables from copied agent-dir definitions.
 *
 * Lifecycle: the host owns the desired set (per-session UI state) and pushes
 * it through `mcp.setSessionServerEnabled`; the backend writes/deletes the
 * file and recycles the session's worker when the toggle should apply
 * immediately (the adapter re-reads config at every session start). The file is
 * passed to the adapter only while it exists, so host state loss (webview/host
 * restart before the next spawn) falls back to the global config untouched.
 */
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';

import { atomicWriteText } from '../../../lib/temporary-files/atomic-write';
import { toErrorMessage } from '../../../lib/structured-logging/error-message';

/** Sibling artifact per durable session file. Same lifecycle spaces as the
 *  session — forgotten/cleaned with it, never global. */
export function sessionMcpOverridePath(sessionPath: string): string {
  if (!sessionPath || typeof sessionPath !== 'string') throw new Error('Session path must be a non-empty string.');
  const trimmed = path.basename(sessionPath).replace(/\.(jsonl|json)$/i, '') || 'session';
  return path.join(path.dirname(sessionPath), `${trimmed}.mcp-overrides.json`);
}

/** Desired per-session server state: only `true` entries disable a server.
 * `false` means remove the session disable, never force-enable a server. */
export type SessionMcpOverrides = Record<string, boolean>;

export function normalizeSessionMcpOverrides(overrides: SessionMcpOverrides): SessionMcpOverrides {
  return Object.fromEntries(Object.entries(overrides).filter(([name, disabled]) => name.length > 0 && disabled === true));
}

/** Read the persisted override set for a session (null = none). */
export async function readSessionMcpOverrides(sessionPath: string): Promise<SessionMcpOverrides | null> {
  const overridePath = sessionMcpOverridePath(sessionPath);
  const raw = await fs.readFile(overridePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const metadata = (parsed as { sessionOverrides?: unknown }).sessionOverrides;
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const overrides = normalizeSessionMcpOverrides(metadata as SessionMcpOverrides);
    return Object.keys(overrides).length > 0 ? overrides : null;
  }
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null;
  const overrides: SessionMcpOverrides = {};
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || !('disabled' in (entry as Record<string, unknown>))) continue;
    // Legacy artifacts have no metadata: only flag-only entries can be
    // identified as session overrides rather than copied server definitions.
    if (Object.keys(entry).length === 1 && (entry as { disabled?: unknown }).disabled === true) overrides[name] = true;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

/** Resolve the adapter input synchronously at worker spawn. Legacy artifacts
 * can contain force-enables, including on copied definitions whose intent is
 * unknowable. Remove those flags conservatively, preserving definitions and
 * disables rather than guessing a migration that could enable more servers.
 * Modern metadata-bearing artifacts are produced by the disable-only writer.
 * Errors must stop spawn: never pass an unsanitized legacy file to the adapter. */
export function sessionMcpConfigPathFor(sessionPath: string): string | undefined {
  const overridePath = sessionMcpOverridePath(sessionPath);
  let raw: string;
  try {
    raw = fsSync.readFileSync(overridePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid MCP session config artifact.');
  if (parsed.sessionOverrides && typeof parsed.sessionOverrides === 'object' && !Array.isArray(parsed.sessionOverrides)) return overridePath;
  const servers = parsed.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid MCP session config servers.');
  let changed = false;
  for (const [name, entry] of Object.entries(servers)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const definition = entry as Record<string, unknown>;
    if (definition.disabled !== false) continue;
    delete definition.disabled;
    if (Object.keys(definition).length === 0) delete servers[name];
    changed = true;
  }
  if (Object.keys(servers).length === 0) {
    fsSync.rmSync(overridePath);
    return undefined;
  }
  if (changed) fsSync.writeFileSync(overridePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return overridePath;
}

interface AgentDirConfigFile {
  mcpServers?: Record<string, unknown>;
}

/** Persist the desired override set for a session and return the artifact
 *  path. An empty set removes the file so the next worker spawn falls back to
 *  plain config discovery. The agent-dir layer (`<agentDir>/mcp.json`) is
 *  copied in because `--mcp-config` replaces that layer entirely; env refs
 *  stay as written (`${VAR}` interpolation happens later, in the adapter). */
export async function writeSessionMcpOverrides(params: {
  sessionPath: string;
  agentDir: string;
  overrides: SessionMcpOverrides;
}): Promise<{ overridePath: string; removed: boolean }> {
  if (!params.agentDir || typeof params.agentDir !== 'string') throw new Error('Agent directory must be a non-empty string.');
  const overridePath = sessionMcpOverridePath(params.sessionPath);
  const overrides = normalizeSessionMcpOverrides(params.overrides);
  const entries = Object.entries(overrides);

  if (entries.length === 0) {
    await fs.rm(overridePath, { force: true });
    return { overridePath, removed: true };
  }

  const config: { mcpServers: Record<string, { disabled: boolean }>; sessionOverrides: SessionMcpOverrides } = { mcpServers: {}, sessionOverrides: overrides };
  const agentDirConfigPath = path.join(params.agentDir, 'mcp.json');
  const agentDirRaw = await fs.readFile(agentDirConfigPath, 'utf8').catch(() => undefined);
  if (agentDirRaw !== undefined) {
    try {
      const parsed = JSON.parse(agentDirRaw) as AgentDirConfigFile;
      if (parsed?.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
        config.mcpServers = structuredClone(parsed.mcpServers) as Record<string, { disabled: boolean }>;
      }
    } catch (error) {
      // An unparsable agent-dir config must not silently drop its servers;
      // surface the failure instead of writing a degraded override layer.
      throw new Error(`MCP session overrides: cannot parse ${agentDirConfigPath}: ${toErrorMessage(error)}`);
    }
  }
  for (const [name, disabled] of entries) {
    config.mcpServers[name] = { ...(config.mcpServers[name] ?? {}), disabled };
  }
  await atomicWriteText(overridePath, `${JSON.stringify(config, null, 2)}\n`);
  return { overridePath, removed: false };
}