# pi-config

A personal stack built around the [`pi` coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): a VS Code sidebar extension (*pie*), reusable pi plugins, local run-analytics tooling, and the maintainer's own agents/skills/config.

## What's in this repo

| Path | What it is | Distribution |
|---|---|---|
| [`extension/`](extension) | *pie* — VS Code sidebar extension that surfaces a `pi` agent as chat | Built and packaged locally from source |
| [`extensions/subagent/`](extensions/subagent), [`extensions/cwd-skills/`](extensions/cwd-skills), [`extensions/skill-pruner/`](extensions/skill-pruner), [`extensions/safeguard/`](extensions/safeguard) | Reusable pi plugins (subagent delegation, cwd-scoped skill discovery, skill pruning, command safeguards) | Loaded by `pi` via `settings.json` packages |
| [`analysis/`](analysis) | Local DuckDB + static-site workspace for run analytics | Internal research tool |
| [`agents/`](agents), [`skills/`](skills), [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md), [`settings.json`](settings.json) | Maintainer's personal pi config | Reference / example only |
| [`data/`](data), [`pie/`](pie), [`auth.json`](#) | Local runtime/auth data | Local-only; excluded from the portable config |
| [`docs/`](docs) | Design contracts and plans; start at [`docs/INDEX.md`](docs/INDEX.md) | Internal |

## Goals

- Take effective workflows and refine them — the flow of writing docs, making tweaks, and reviewing changes in VS Code while agents work in the sidebar.
- Collect local usage data to improve outcomes — which models, skills, tools, and treatments actually produce results.
- Keep one portable config across machines, with session history local and out of git.

These are the *original* design drivers. The architecture is being adjusted so external users can adopt the publishable pieces (extension, pi plugins) without inheriting the personal layer. Design docs and archived plans are in [`docs/`](docs/INDEX.md).

## Prerequisites

- Node.js 20+ (Node 24+ for the `analysis/` workspace)
- npm 10+
- [`pi`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) installed globally if you want the runtime flow end-to-end
- VS Code, for interactive extension work

## Install

### Windows

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\install.ps1
```

### macOS / Linux

```bash
chmod +x install.sh
./install.sh
```

### What the installer does

Both installers are idempotent and safe to re-run. On each run they:

1. **Set `PI_CODING_AGENT_DIR`** to the repo root (User env var on Windows; shell rc on macOS/Linux) so the `pi` CLI reads `settings.json` and `models.json` from here.
2. **Pin `PI_CODING_AGENT_SESSION_DIR`** to this checkout's `data/outcomes/sessions/` on Windows so standalone `pi` writes session JSONL to the repo-local store even when launched from an arbitrary working directory such as `C:\Windows\System32`.
3. **Install `pi`** ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) globally if the `pi` command is not on PATH.
4. **Relocate `auth.json`** out of the working tree into a secure OS user-data directory (`%LOCALAPPDATA%\pie\` on Windows; `~/.config/pie/` or `~/Library/Application Support/pie/` on macOS/Linux) and set `PI_CODING_AGENT_AUTH_DIR`.
5. **Merge split-brain auth** — if a *new* in-tree `auth.json` appears after relocation (from running `pi` in a shell without `PI_CODING_AGENT_AUTH_DIR`), the installer merges its credentials into the secure location and removes the in-tree copy.
6. **Write `pie.agentDir`** to VS Code User settings so the extension host forwards the correct config dir to the backend, even before VS Code picks up the new User env vars (which only happens on a full restart, not a window reload).
7. **Repair extension paths** in `settings.json` (committed paths may reference another machine's npm global tree).
8. **Migrate session history** from legacy `~/.pi/agent/sessions/` into `data/outcomes/sessions/` (Windows only; planned for macOS/Linux).
9. **Build and install the pie VS Code extension** from `extension/` via `vsce package` + `code --install-extension`.
10. **Run a post-install verification** that checks auth content, `pie.agentDir`, and env vars, and warns about split-brain or missing credentials.

The macOS/Linux script (`install.sh`) is intentionally lighter: it covers steps 1–5 and 9. Full feature parity (session migration, sessionDir repair, VSIX packaging) is planned — see [docs/internal/code-review/TODO-archive.md](docs/internal/code-review/TODO-archive.md).

## Model Configuration

Model configuration (providers, pricing, eligibility flags, LiteLLM proxy routing, and the default model/provider/retry/pruning settings) has a single source of truth: [`models.yaml`](models.yaml). After editing it, regenerate the derived files:

```bash
npm run sync-models            # regenerate models.json, model-profiles.yaml, proxy/litellm_config.yaml, settings.json model fields
npm run sync-models -- --check  # dry-run: exit 1 if any derived file is out of sync
```

Do not edit `models.json`, `model-profiles.yaml`, `proxy/litellm_config.yaml`, or the model fields of `settings.json` directly — the `model-config-sync` test fails on drift.

## Authentication

The pie panel needs provider credentials to send messages. There are two ways to authenticate:

### Option A: Provider API key (env var)

Set a provider API key as a persistent environment variable. The backend reads it automatically.

**Windows:**
```powershell
setx UMANS_API_KEY "sk-..."
# then open a NEW terminal for it to take effect
```

**macOS / Linux:**
```bash
echo 'export UMANS_API_KEY="sk-..."' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc
```

Supported env vars (checked in this order): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `UMANS_API_KEY`.

### Option B: Interactive `pi` login (writes auth.json)

Run `pi` once interactively — it will prompt for an API key and cache it in `auth.json`:

```bash
pi --provider umans --model umans-glm-5.2 "hello"
```

> **Important:** Run this in a terminal that has `PI_CODING_AGENT_AUTH_DIR` set (open a new terminal after install). Otherwise `pi` writes `auth.json` back to the repo root, creating a split-brain where the backend reads the secure (empty) location and returns 401. If this happens, **re-run the installer** — it will auto-merge the in-tree creds into the secure location.

### Where auth.json lives

| OS | Default secure location | Env var override |
|---|---|---|
| Windows | `%LOCALAPPDATA%\pie\auth.json` | `PI_CODING_AGENT_AUTH_DIR` |
| Linux | `~/.config/pie/auth.json` | `PI_CODING_AGENT_AUTH_DIR` |
| macOS | `~/Library/Application Support/pie/auth.json` | `PI_CODING_AGENT_AUTH_DIR` |

`auth.json` is git-ignored and should never be committed. The installer restricts file permissions to the current user only.

## Troubleshooting

### No models appear in the pie panel

**Cause:** The backend's `agentDir` resolved to the default `~/.pi/agent` instead of the repo root, so `models.json` was not loaded.

**Fix:** The installer writes `pie.agentDir` to VS Code User settings to prevent this. If models still don't appear:

1. Open VS Code Settings (JSON) and verify `"pie.agentDir": "C:\path\to\pie"` is present.
2. Reload the VS Code window (Developer: Reload Window) — not just the panel.
3. If running the extension from source, rebuild: `cd extension && npm run build`.

### 401 / "invalid api key" error

**Cause:** The backend reads `auth.json` from `PI_CODING_AGENT_AUTH_DIR` (the secure location), but it's empty `{}` while real credentials are stranded in the repo-root `auth.json`.

This happens when `pi` was run in a shell that didn't inherit `PI_CODING_AGENT_AUTH_DIR`.

**Fix:** Re-run the installer — it auto-merges the in-tree creds into the secure location:
```powershell
.\install.ps1   # or: ./install.sh
```

Or merge manually (Windows):
```powershell
Copy-Item "$env:USERPROFILE\Documents\GitHub\pie\auth.json" "$env:LOCALAPPDATA\pie\auth.json" -Force
```

### Backend fails to start: "SDK path not allowed"

**Cause:** The SDK is installed under a path not in the `isPathAllowed` allowlist.

**Fix:** The extension host derives `PIE_TRUSTED_SDK_ROOT` from the resolved `sdkPath` and passes it to the backend. If using a custom SDK location, set `pie.sdkPath` in VS Code settings to the SDK package directory.

### `pi` command not found after install

**Cause:** `npm install -g` added `pi` to the npm prefix bin dir, but the current shell's PATH hasn't refreshed.

**Fix:** Open a new terminal. Or verify manually:
```bash
npm config get prefix   # shows where pi was installed
```

### VS Code env vars not taking effect

**Cause:** VS Code only picks up new User-scope environment variables on a **full restart**, not on window reload. The installer sets `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_AUTH_DIR` at User scope.

**Fix:** The installer also writes `pie.agentDir` to VS Code User settings (which works immediately on reload) as a belt-and-suspenders fix. But for the `pi` CLI in integrated terminals, you still need to either restart VS Code fully or open a new integrated terminal.

## Quick start

### Run repo-wide tests

```bash
# from repo root; Node 24+ recommended because this includes analysis/
npm run test

# scope to one package when you only touched part of the repo
npm run test -- --package extension
npm run test -- --package subagent
```

`npm run test` is the canonical repo-wide test runner. It runs each package in isolation, prints only per-package summaries plus exact failures, and enforces package-level line/branch coverage gates.

### Build the pie VS Code extension

```bash
cd extension
npm install
npm run build      # builds and syncs into the installed extension
```

Useful extension commands:

- `npm run watch` — incremental rebuild for UI work
- `npm run test` — unit tests
- `npm run typecheck` — type-only check
- `npm run package` — produce a `.vsix`

### Run the analytics workspace

```bash
# from repo root
npm run analytics:serve
```

Other analytics helpers from the repo root: `analytics:build-db`, `analytics:query -- --name model_quality`, `analytics:export-site-data`, `analytics:validate`.

## Persistence and storage

- PI session history is stored as canonical JSONL under this checkout's local `data/outcomes/sessions/`. On Windows, `install.ps1` also pins `PI_CODING_AGENT_SESSION_DIR` to that absolute path so standalone `pi` does not fall back to the shell's current working directory.
- `data/` is git-ignored. It is local runtime data, not part of the portable repo/config state.
- `install.ps1` migrates legacy session files (`~/.pi/agent/sessions/`, `data/sessions/`), repairs reachable absolute / `~`-based legacy `sessionDir` overrides, prefers newer transcripts on conflict, and preserves the loser as `.conflict.*.bak`.
- Relative `sessionDir` overrides cannot be repaired safely by the installer and need manual cleanup.

### Storage locations

| State | Default location | Override env var |
|---|---|---|
| Auth tokens | `%LOCALAPPDATA%\pie\auth.json` (Win) / `~/.config/pie/auth.json` (macOS/Linux) | `PI_CODING_AGENT_AUTH_DIR` |
| Sessions | `data/outcomes/sessions/` (in-tree, git-ignored) | `PI_CODING_AGENT_SESSION_DIR` |
| Run analytics | `data/outcomes/<id>/` or `PIE_ANALYTICS_DIR` override | `PIE_ANALYTICS_DIR` |

The backend logs resolved storage paths on startup via the `backend.ready` event.

## More docs

- [AGENTS.md](AGENTS.md) — repo-specific working conventions for AI assistants
- [docs/INDEX.md](docs/INDEX.md) — curated index of design docs and plans
- [docs/STATE_CONTRACT.md](docs/STATE_CONTRACT.md) — authoritative host ↔ webview sync contract
- [extension/README.md](extension/README.md) — extension design philosophy
- [analysis/README.md](analysis/README.md) — analytics workspace details
