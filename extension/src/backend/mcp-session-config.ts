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
 * `{ disabled }` flag entry per session toggle. Because the override layer
 * sits above `.pi/mcp.json`, a session flag beats a project `disabled` flag
 * per-field, and composite server definitions never leave their original
 * files — the override entries carry a single flag each, never credentials.
 *
 * Lifecycle: the host owns the desired set (per-session UI state) and pushes
 * it through `mcp.setSessionServerEnabled`; the backend writes/deletes the
 * file and recycles the session's worker when the toggle should apply
 * immediately (the adapter re-reads config at every session start). The file is
 * passed to the adapter only while it exists, so host state loss (webview/host
 * restart before the next spawn) falls back to the global config untouched.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteText } from '../shared/atomic-write';
import { toErrorMessage } from '../shared/error-message';

/** Sibling artifact per durable session file. Same lifecycle spaces as the
 *  session — forgotten/cleaned with it, never global. */
export function sessionMcpOverridePath(sessionPath: string): string {
  if (!sessionPath || typeof sessionPath !== 'string') throw new Error('Session path must be a non-empty string.');
  const trimmed = path.basename(sessionPath).replace(/\.(jsonl|json)$/i, '') || 'session';
  return path.join(path.dirname(sessionPath), `${trimmed}.mcp-overrides.json`);
}

/** Desired per-session server state: `true` = disabled for this session only.
 *  `false` entries force-enable a server the global/project files disable. */
export type SessionMcpOverrides = Record<string, boolean>;

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
  const servers = (parsed as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return null;
  const overrides: SessionMcpOverrides = {};
  for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || !('disabled' in (entry as Record<string, unknown>))) continue;
    overrides[name] = (entry as { disabled?: unknown }).disabled === true;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
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
  const entries = Object.entries(params.overrides).filter(([name]) => typeof name === 'string' && name.length > 0);

  if (entries.length === 0) {
    await fs.rm(overridePath, { force: true });
    return { overridePath, removed: true };
  }

  const config: { mcpServers: Record<string, { disabled: boolean }> } = { mcpServers: {} };
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