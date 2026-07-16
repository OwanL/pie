# pi-config

A personal stack built around the [`pi` coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): a VS Code sidebar extension (*pie*), reusable pi plugins, local run-analytics tooling, and the maintainer's own agents/skills/config.

## What's in this repo

| Path | What it is | Distribution |
|---|---|---|
| [`extension/`](extension) | *pie* — VS Code sidebar extension that surfaces a `pi` agent as chat | Built and packaged locally from source |
| [`extensions/subagent/`](extensions/subagent), [`extensions/cwd-skills/`](extensions/cwd-skills), [`extensions/skill-pruner/`](extensions/skill-pruner), [`extensions/safeguard/`](extensions/safeguard) | Reusable pi plugins (subagent delegation, cwd-scoped skill discovery, skill pruning, command safeguards) | Loaded by `pi` via `settings.json` packages |
| [`analysis/`](analysis) | Local DuckDB + static-site workspace for run analytics | Internal research tool |
| [`agents/`](agents), [`skills/`](skills), [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md), [`settings.json`](settings.json) | Maintainer's personal pi config | Reference / example only |
| [`data/`](data), [`auth.json`](#) | Local runtime/auth data | Local-only; excluded from the portable config |
| [`docs/`](docs) | Design contracts and plans; start at [`docs/INDEX.md`](docs/INDEX.md) | Internal |

## Goals

- Take effective workflows and refine them — the flow of writing docs, making tweaks, and reviewing changes in VS Code while agents work in the sidebar.
- Collect local usage data to improve outcomes — which models, skills, tools, and treatments actually produce results.
- Keep one portable config across machines, with session history local and out of git.

These are the *original* design drivers. The architecture is being adjusted so external users can adopt the publishable pieces (extension, pi plugins) without inheriting the personal layer. Design docs and archived plans are in [`docs/`](docs/INDEX.md).

## Prerequisites

- Node.js **24.16.0**, pinned by `.nvmrc` and `.node-version`
- npm **11.13.0**, pinned by `packageManager` in `package.json`
- VS Code, for interactive extension work

The installers pin the optional standalone `pi` CLI to the exact SDK version resolved by `extension/package-lock.json`. The VS Code backend always prefers that repo-local locked SDK, so a global package upgrade cannot silently change it.

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
3. **Pin `pi`** ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)) globally to the exact version in `extension/package-lock.json`, then restore packages with `pi update --extensions` without self-updating the CLI.
4. **Relocate `auth.json`** out of the working tree into a secure OS user-data directory (`%LOCALAPPDATA%\pie\` on Windows; `~/.config/pie/` or `~/Library/Application Support/pie/` on macOS/Linux) and set `PI_CODING_AGENT_AUTH_DIR`.
5. **Merge split-brain auth** — if a *new* in-tree `auth.json` appears after relocation (from running `pi` in a shell without `PI_CODING_AGENT_AUTH_DIR`), the installer merges its credentials into the secure location and removes the in-tree copy.
6. **Write `pie.agentDir`** to VS Code User settings so the extension host forwards the correct config dir to the backend, even before VS Code picks up the new User env vars (which only happens on a full restart, not a window reload).
7. **Repair extension paths** in `settings.json` (committed paths may reference another machine's npm global tree).
8. **Migrate session history** from legacy `~/.pi/agent/sessions/` into the current checkout's local `data/outcomes/sessions/` store.
9. **Install dependencies with `npm ci`**, then build, package, and install the pie VS Code extension when the VS Code CLI is available.
10. **Run post-install verification** for auth, paths, versions, and split-brain credentials.

Both installers enforce the same portability policy: configuration comes from Git, while credentials, sessions, logs, analytics, dependencies, and build outputs remain local to each machine.

## Model Configuration

The provider catalog, pricing, eligibility, concurrency, retry policy, and initial chat/pruning selections have a single source of truth: [`models.yaml`](models.yaml). Existing chat and pruning selections are user preferences owned by `settings.json`; synchronization seeds them only when absent. After editing the catalog or defaults, regenerate the derived files:

```bash
npm run sync-models            # regenerate models.json, model-profiles.yaml, settings.json model fields
npm run sync-models -- --check  # dry-run: exit 1 if any derived file is out of sync
```

Do not edit `models.json` or `model-profiles.yaml` directly. Change active chat and pruning selections through the UI (which writes `settings.json`); `sync-models` preserves those choices. The `model-config-sync` test guards generated catalog drift.

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

**Fix:** The extension host derives `PIE_TRUSTED_SDK_ROOT` from the resolved `sdkPath` and passes it to the backend, and the repo-local pinned SDK (`extension/node_modules/@earendil-works/pi-coding-agent`) is trusted by construction. If overriding with a custom SDK location, set `pie.sdkPath` in VS Code *User* settings (or the `PI_SDK_PATH` env var) to the SDK package directory — avoid committing an absolute `pie.sdkPath` to the tracked `.vscode/settings.json`, since it is machine-specific and breaks other machines on pull.

### SDK version drift / backend breaks after a pull

**Cause:** The extension backend previously loaded whatever `@earendil-works/pi-coding-agent` `npm root -g` resolved, so a `npm i -g` upgrade (or a different version on another machine) could silently swap the SDK out from under the backend.

**Fix:** The SDK is now a pinned `extension/package.json` dependency. `cd extension && npm install` (or `npm ci` for a reproducible install from the lockfile) installs the exact version into `extension/node_modules/`, and the backend resolves that copy first. Run `npm install` in `extension/` after pulling if the SDK version in the lockfile changed.

### `pi` command not found after install

**Cause:** `npm install -g` added `pi` to the npm prefix bin dir, but the current shell's PATH hasn't refreshed.

**Fix:** Open a new terminal. Or verify manually:
```bash
npm config get prefix   # shows where pi was installed
```

### VS Code env vars not taking effect

**Cause:** VS Code only picks up new User-scope environment variables on a **full restart**, not on window reload. The installer sets `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_AUTH_DIR` at User scope.

**Fix:** The installer also writes `pie.agentDir` to VS Code User settings (which works immediately on reload) as a belt-and-suspenders fix. But for the `pi` CLI in integrated terminals, you still need to either restart VS Code fully or open a new integrated terminal.

## Multi-machine workflow

Use Git—not Dropbox, OneDrive, or copied working directories—to move configuration between machines. Clone to the final location, select the pinned Node version, and run the OS installer. Authenticate each machine independently; never transfer `auth.json`.

For a deterministic dependency/build refresh after pulling, first close all VS Code windows using pie (Windows locks the running extension's native/esbuild files), then run from an external terminal:

```bash
npm run bootstrap
```

This runs a root `npm ci`; its `postinstall` automatically installs the locked `extension/` and `analysis/` dependency trees (including build/test dependencies such as jsdom). It then installs the locked pi CLI, restores pi packages without updating the CLI, checks generated model files, builds the extension, and runs the doctor. For a non-destructive check:

```bash
npm run doctor
```

Dependency updates arrive as monthly Dependabot pull requests for each tracked lockfile root. Review and test those changes; do not run unpinned global upgrades independently on each machine.

See [SECURITY.md](SECURITY.md) before sharing a checkout or backing up local state.

## Quick start

### Run repo-wide tests

```bash
# from repo root; parallel unit suite, no coverage instrumentation
npm run test

# coverage gates used by the release verification workflow
npm run test:coverage

# opt-in real-SDK and real-shell integration tests
npm run test:integration

# tight loop: run only named files
npm run test:file -- extension/test/webview/transcript/activity/activity-tail.test.ts

# run fast suites for packages touched in the working tree
npm run test:changed

# fast package loop (parallel files, no coverage instrumentation)
npm run test:fast -- --package extension

# coverage verification scoped to one package
npm run test:coverage -- --package extension
npm run test:coverage -- --package subagent
```

`npm run test` is the canonical unit runner. A successful repo-wide run is content-addressed by Node version, Git HEAD, tracked changes, and untracked source content; unchanged reruns complete in under 30 seconds (normally about 1–2 seconds). Slow tests that require real SDK sessions, child processes, Git repositories, or shell pools live behind `npm run test:integration`; coverage collection remains available through `npm run test:coverage`. `npm run check` combines generated-config drift, parallel incremental typechecks, lint, and changed-package tests; `npm run verify` performs the full local release gate (including coverage) and reuses its completed typecheck during the build. Use `test:file` while iterating and the appropriate scoped or repo-wide command before finishing a change.

Test and typecheck children have a 20-minute watchdog that kills the complete process tree on timeout or runner interruption (including `taskkill /T /F` on Windows). Override it with `PIE_TEST_PROCESS_TIMEOUT_MS`; set `0` only to disable it explicitly.

### Build the pie VS Code extension

From a fresh checkout, install every dependency tree once from the repository root:

```bash
npm ci             # also installs extension/ and analysis/ via postinstall
npm run extension:build
```

For an extension-only refresh after dependencies are already installed:

```bash
cd extension
npm run build      # builds and syncs into the installed extension
```

Useful extension commands:

- `npm run watch` — incremental Vite rebuilds plus a concurrent TypeScript watch
- `npm run watch -- --skip-typecheck` — Vite-only watch when typechecking elsewhere
- `npm run test` — unit tests
- `npm run typecheck` — incremental type-only check
- `npm run package` — produce a `.vsix`

### Run the analytics workspace

```bash
# from repo root
npm run analytics:serve
```

Other analytics helpers from the repo root: `analytics:build-db`, `analytics:query -- --name model_quality`, `analytics:export-site-data`, `analytics:validate`.

## Persistence and storage

- Session history is canonical JSONL under each checkout's `data/outcomes/sessions/`. Both installers pin `PI_CODING_AGENT_SESSION_DIR` to that machine-local path.
- `data/` is git-ignored runtime data, not portable configuration. Do not cloud-sync it and never let two machines write to the same session directory.
- Both installers migrate legacy session files (`~/.pi/agent/sessions/`, `data/sessions/`), prefer newer transcripts on conflict, and preserve the loser as `.conflict.*.bak`.
- Back up session data only to encrypted storage; transcripts can contain source code, prompts, paths, tool output, and secrets.

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
