# MCP in pie

How pie gets [Model Context Protocol](https://modelcontextprotocol.io/) server
support, how servers are added, and how the layer composes with the rest of the
stack. Operational reference — runtime code lives upstream in
[`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter), pinned as a pi
package (see `settings.json#packages`).

## Why this design

Pi has **no native MCP** — by design ([rationale](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)):
naive MCP integration registers every server tool into the model's context,
which costs 10k+ tokens per server per turn. pie instead adopts
`pi-mcp-adapter`, whose core design is context-lean in the same spirit as the
repo's other context-lean layers (history compaction / skill pruning /
tool-result pruning):

- **One proxy tool `mcp` (~200 tokens) instead of hundreds of registered
  tools.** The agent discovers on demand: `mcp({ search: "screenshot" })` to
  find a tool, `mcp({ tool: "...", args: {...} })` to call it. Context cost is
  O(1) regardless of how many servers are configured.
- **Lazy servers.** A configured server is not spawned until one of its tools
  is actually used. Tool metadata is cached (`mcp-cache.json`) so search and
  describe work without a live connection.
- **Standard config files.** `.mcp.json` and `~/.config/mcp/mcp.json` follow
  the Claude Desktop / Cursor conventions, so a config written for another
  host works here unchanged.

Per-server **direct tools** (`directTools: true`) opt out of the proxy and
register real Pi tools (`jira_get_issue`, …) — worth it only for small,
high-value toolsets; proxy mode is the default and the recommended default.

## How it's wired in

- `settings.json#packages` → `npm:pi-mcp-adapter@2.20.1` (pi installs it into
  the gitignored `npm/` workspace of the agent dir and loads its extension
  into the backend process; no VS Code host changes).
- The adapter exposes `mcp` and, by default, `mcpScript`. The `skill-pruner`
  prepass prunes these catalog entries, not individual MCP servers or tools
  within the adapter. `settings.json#pruning.tools.alwaysKeep` protects only
  `mcp` from pruning.
- Tool results flow through `tool-result-pruner` like any other tool result:
  `minify-json` shrinks API JSON, `duplicate-collapse`/`progress-noise`
  compress repeated rows — no MCP-specific rules needed.
- `mcp-cache.json` (tool-metadata cache) and `mcp-npx-cache.json` (adapter
  resolution state) are rebuildable caches. In the Pie backend they follow the
  absolute `PIE_CACHE_DIR` seam into the canonical data-root `cache/` category;
  the adapter's ordinary npm `_npx` cache remains npm-owned. The checked-in
  `web-access-guard` applies this only to the pinned `pi-mcp-adapter@2.20.1`
  source shape and fails closed on version/source drift.

### MCP controls (UI)

MCP has two control scopes. The **global** controls (Settings → MCP tab) apply
to every session; the **session-scoped** controls (toolbar plug dropdown) apply
to one session only:

- **Settings → MCP tab (global)** — the `MCP enabled` master switch and
  per-server toggles with a Refresh action plus a pointer to the config
  files. The master switch is enforced by a backend guard (not by the
  adapter): `installMcpToolGuard` in `harness/agent-instructions/prompt-assembly/system-prompts.ts`
  filters every `setActiveToolsByName` call while the pref is off, and
  `worker-runtime-host.ts` re-applies the removal after extension bind and at
  every `turn_start` (the adapter's `registerTool` auto-activates new tools,
  bypassing the guard). The pref (`mcpEnabled`, default on) lives in
  `ChatPrefs` and is mirrored to the backend via `runtimePrefs.set` and
  `PIE_MCP_ENABLED`. Turning MCP off strips the adapter's tools (`mcp`,
  `mcpScript`) from every active tool set immediately — servers stay
  configured in their mcp.json files and are re-exposed when re-enabled.
  Per-server toggles here persist a `disabled` override into
  `<cwd>/.pi/mcp.json` (the adapter's own mechanism; see below) and apply on
  the next session reload / backend restart.
- **Toolbar plug dropdown (this session only)** — per-server toggles that
  affect exactly one session. Toggling writes a session-scoped override set
  (host state + a `<session>.mcp-overrides.json` artifact passed to that
  session's worker as `--mcp-config`, which replaces only the adapter's
  highest-preference discovery layer) and recycles that session's worker when
  it is idle so the adapter applies the change at the next session start —
  no manual reload. When a turn is running, the recycle waits and the menu
  shows a pending hint until the next idle transition. Never touches
  `.pi/mcp.json` or the global pref; while the global switch is off the
  dropdown shows a pointer to Settings instead of server rows.
- **Search** — typing `mcp` in the settings search box surfaces the global
  toggle from any tab.

Note: the global guard covers the main session. In-process subagent sessions
do not pass through the backend's `SessionContext` setup, so the adapter's
tools remain available there while MCP is off.

### Version pin

pie is on pi 0.80.6. The adapter is pinned to **2.20.1**, the last release
compatible with pi < 0.84 (`pi-ai` peer `*`). Adapter ≥ 2.21.0 requires pi ≥
0.84.1 (agent plugins, `pi.mcp` package manifests, keyring token store, runtime
`registerMcpServer`). Bumping the pi runtime in the VS Code host package (`application/hosts/vscode/package.json`) unlocks the newer
adapter line; until then stay on 2.20.1.

## Adding a server — the model

Three decisions per server, then a file edit and a restart:

### 1. Pick a scope (which files does it apply to)

| File | Scope | Tracked? |
|---|---|---|
| `~/.config/mcp/mcp.json` | every project, every host | user home — safe for tokens |
| `~/.agents/mcp.json` / `~/.agents/mcp/mcp.json` | every project, tool-agnostic | user home |
| `<agent dir>/mcp.json` (= `pie/mcp.json`) | every project, Pi only | **git repo — tokens must be `${VAR}` env refs** |
| `.mcp.json` | this project only | per-repo |
| `.pi/mcp.json` | this project, Pi overrides (e.g. `disabled`) | per-repo |

Precedence (higher wins, merged per-server field-wise): `~/.config/mcp/mcp.json`
→ `~/.agents/*` → `<agent dir>/mcp.json` → `.mcp.json` → `.pi/mcp.json`.

Rule of thumb: personal integrations you want everywhere (Jira) → home config;
something tied to one repo → `.mcp.json`; Pi-only overrides → `.pi/mcp.json`.
Never put tokens in any file inside a git repo — use `${VAR}` interpolation
(the adapter expands `$VAR`, `${VAR}`, `$env:VAR`; prefix a value with `!` to
disable interpolation).

### 2. Transport + auth

- **Local stdio** (most robust): `command` + `args` (+ `env`, `cwd`), e.g.
  `uvx mcp-atlassian` for Jira. Secrets via `env` map.
- **Remote HTTP** (`url`): Streamable HTTP/SSE with `auth: "oauth"` (interactive
  browser flow) or `"bearer"` + `bearerToken`/`headers`.

### 3. Registration mode

- Proxy (default): discovery via `mcp({ search })`.
- `directTools: true` (or a tool-name list): register `<server>_<tool>` as real
  tools (prefix from `toolPrefix`: `server` default, `short`, `mcp`, `none`).
- Per-server guards: `includeTools`/`excludeTools`, `approveTools`
  (interactive approval), `disabled: true` (also `/mcp disable <server>` or
  the per-server toggle in the pie UI).

### Ops flow

1. Edit the config file (or toggle a server in the pie UI — no file edit
   needed for enable/disable).
2. Restart the backend (`pie: Restart Backend` in VS Code, `/reload` in TUI)
   so the adapter re-reads config. Global per-server toggles also need this;
   session-scoped toolbar toggles recycle their worker automatically when idle.
3. Verify: ask the model to use the server, or probe with
   `mcp({ search: "..." })`; the `/mcp` panel (TUI) shows server/tool status
   and stderr. In the Pie backend, the metadata cache is
   `<PIE_CACHE_DIR>/mcp-cache.json`; deleting this rebuildable cache forces
   re-discovery.

### Troubleshooting

- Server never connects → check the command resolves (`uvx`/`npx` on PATH of
  the backend process), server stderr via `/mcp` (or `debug: true`),
  `disabled` flags in all precedence layers.
- Missing env vars → `${VAR}` interpolates to empty; watch for silent empties.
- Big payloads → `outputGuard` (default 50 KiB inline / 16 KiB details) plus
  `tool-result-pruner` apply automatically; `mcp({ tool, args })` returns
  details including `mcpResult`.

## Security model

MCP servers execute arbitrary code with the user's permissions — same trust
level as any extension. Project `.mcp.json` files are auto-read from any opened
workspace; treat untrusted repos' `.mcp.json` as untrusted code. The adapter
binds auth material to the URL that supplied it (a higher-precedence override
that changes `url` drops inherited headers/tokens). Never commit tokens.

## Optional setup example: Jira

To add a user-global Jira server, configure
`~/.config/mcp/mcp.json` for the local
[`sooperset/mcp-atlassian`](https://github.com/sooperset/mcp-atlassian) server.
This option requires `uv`/`uvx` installed, with `uvx` available on the backend
process `PATH`. Follow the project's upstream
[setup and configuration docs](https://github.com/sooperset/mcp-atlassian) for
current instructions and supported environment variables (such as `JIRA_URL`,
`JIRA_USERNAME`, and `JIRA_API_TOKEN`; generate a token at id.atlassian.com →
*API tokens*). Create the config and supply values as documented; pie does not
provision this file or placeholders. Never commit credentials: for a
project-scoped config, use `${VAR}` interpolation rather than storing secrets.
Restart the backend, then verify with `mcp({ search: "jira" })` (which should
list tools such as `jira_search`, `jira_get`, …) or ask the model to use the
server; the `/mcp` panel shows status and stderr.

Alternatives: the official remote [Atlassian Rovo](https://www.atlassian.com/software/rovo)
server (`url` + OAuth, needs org enablement) or a project-scoped `.mcp.json`
instead of the home file.
