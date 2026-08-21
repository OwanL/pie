/**
 * MCP server discovery + per-server enable/disable, delegated to the pinned
 * `pi-mcp-adapter` package's own config module (settings.json#packages →
 * `npm:pi-mcp-adapter@2.20.1`).
 *
 * Rationale: the adapter is the authority on MCP config semantics — scope
 * precedence (`~/.config/mcp/mcp.json` → `~/.agents/*` → `<agent dir>/mcp.json`
 * → `.mcp.json` → `.pi/mcp.json`), `imports`, env interpolation, and the
 * lower-precedence-disabled nuance of the `disabled` field. Reimplementing any
 * of that here would drift. The adapter's `config.ts` is pure file I/O with no
 * side effects (unlike `index.ts`, whose default export instantiates the whole
 * adapter), so bundling it into the worker is safe. The version is pinned by
 * the package lock; a major adapter upgrade may require revisiting this import.
 *
 * Toggling writes ONLY the `disabled` field into `.pi/mcp.json` (the project
 * Pi-overrides layer) via the adapter's own writer — never server definitions
 * or credentials. The adapter re-reads config on every session start, so the
 * override applies on the next session reload / backend restart.
 */
import {
  getProjectPiConfigPath,
  loadMcpConfig,
  writeProjectServerDisabledOverride,
} from '../../../npm/node_modules/pi-mcp-adapter/config.ts';
import { isServerDisabled } from '../../../npm/node_modules/pi-mcp-adapter/types.ts';

/** Effective per-server view: name + merged `disabled` state. */
export interface McpServerEntryView {
  name: string;
  disabled: boolean;
}

export interface McpServerList {
  servers: McpServerEntryView[];
  /** Project Pi-overrides file the toggle writer uses (`.pi/mcp.json` under
   *  `cwd`), surfaced so the UI can say where overrides land. */
  overridePath: string;
}

/** Effective MCP config for `cwd`, mirroring what the adapter itself loads
 *  when it initializes a session there. `overridePath` is forwarded
 *  unset so discovery follows the adapter defaults. */
export function listMcpServers(cwd: string): McpServerList {
  const config = loadMcpConfig(undefined, cwd);
  const servers = Object.keys(config.mcpServers)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      name,
      disabled: isServerDisabled(config.mcpServers[name]),
    }));
  return { servers, overridePath: getProjectPiConfigPath(cwd) };
}

export interface McpServerToggleResult {
  servers: McpServerEntryView[];
  overridePath: string;
  /** True when the file actually changed (no-op toggles — already in the
   *  requested state — return false). */
  changed: boolean;
}

/** Persist a per-server `disabled` override for `cwd` and return the fresh
 *  effective list. Throws when the override file is unreadable/unwritable. */
export function setMcpServerEnabled(cwd: string, name: string, enabled: boolean): McpServerToggleResult {
  if (!name || typeof name !== 'string') throw new Error('MCP server name must be a non-empty string.');
  if (name.length > 256) throw new Error('MCP server name is too long.');
  if (typeof enabled !== 'boolean') throw new Error('MCP enabled flag must be a boolean.');
  const { changed } = writeProjectServerDisabledOverride(undefined, cwd, name, !enabled);
  return { ...listMcpServers(cwd), changed };
}
