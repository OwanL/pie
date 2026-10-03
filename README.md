# pi-config

A personal stack built around the [`pi` coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent): a VS Code sidebar extension (*pie*), reusable pi plugins, local run-analytics tooling, and the maintainer's own agents/skills/config.

## What's in this repo

| Path | What it is | Distribution |
|---|---|---|
| [`application/`](application), [`analytics/`](analytics), [`harness/`](harness), [`lib/`](lib), [`test/integration/`](test/integration) | *pie* host/backend/frontend and domain runtime owners; tests are colocated with their packages, with cross-owner gates under `test/integration/` | Build and VS Code packaging live under [`application/hosts/vscode/`](application/hosts/vscode) |
| [`application/hosts/vscode/`](application/hosts/vscode) | VS Code distribution package, toolchain, runtime assets, and package-owned configuration; build orchestration lives in [`scripts/build/`](scripts/build) | Build and packaging owner |
| [`harness/tools/`](harness/tools/README.md) | Explicit Pie-owned tool catalog, tool implementations, and package integrations | Extension discovery adapters or backend-injected factories; backend composition lives in [`harness/agent-processes/coordinator/backend-tools.ts`](harness/agent-processes/coordinator/backend-tools.ts) |
| [`harness/session-storage/`](harness/session-storage), [`harness/model-providers/`](harness/model-providers), [`harness/agent-processes/`](harness/agent-processes) | Owner packages for session persistence, provider catalogs/policies, and agent-process workers/helpers; cross-owner integration gates remain under [`test/integration/`](test/integration) | Internal runtime and test owners |
| [`extensions/`](extensions) — e.g. [`skill-pruner/`](extensions/skill-pruner), [`safeguard/`](extensions/safeguard), [`cwd-skills/`](extensions/cwd-skills) | Pi discovery adapters and middleware; the skill-pruner implementation lives in [`harness/tool-and-skill-selection/`](harness/tool-and-skill-selection) | Auto-discovered by `pi` from the agent directory's `extensions/` directory |
| [`analytics/analysis/`](analytics/analysis) | Retained local DuckDB query workspace over legacy run-analytics exports/stores | Internal research tool |
| [`harness/agent-instructions/`](harness/agent-instructions) — authored [`agents/`](harness/agent-instructions/agents), [`skills/`](harness/agent-instructions/skills), and [`APPEND_SYSTEM.md`](harness/agent-instructions/APPEND_SYSTEM.md), plus [`settings.json`](settings.json) | Maintainer's personal pi config; selector policy/state is in [`harness/tool-and-skill-selection/`](harness/tool-and-skill-selection) | Reference / example only |
| [`data/`](data), [`auth.json`](#) | Local runtime/auth data | Local-only; excluded from the portable config |
| [`docs/`](docs) | Architecture, contracts, plans, operations, and research | Internal |

## Goals

- Take effective workflows and refine them — the flow of writing docs, making tweaks, and reviewing changes in VS Code while agents work in the sidebar.
- Collect local usage data to improve outcomes — which models, skills, tools, and treatments actually produce results.
- Keep one portable config across machines, with session history local and out of git.

These are the *original* design drivers. The architecture is being adjusted so external users can adopt the publishable pieces (extension, pi plugins) without inheriting the personal layer. Design docs and archived plans are in [`docs/`](docs).

## Supported platform

Pie is currently developed and tested on Windows only. Other operating systems may work in parts, but they have no supported installation path.

## Prerequisites

- Node.js **24.16.0**, pinned by `.node-version`
- npm **11.13.0**, pinned by `packageManager` in `package.json`
- VS Code, for interactive extension work

Pi is built from the repository's pinned source and shipped with the extension as a verified `pi-runtime` artifact. Setup does not install a global `pi` CLI or rely on a host-local locked SDK.

## Install

On a new Windows device, install Git, VS Code, and the exact Node.js version above, then clone to the location where you intend to keep Pie:

```cmd
git clone https://github.com/OwanL/pie.git
cd pie
.\install.bat
```

Node.js must already be on PATH. The installer checks prerequisites before changing configuration and installs the pinned npm version if needed. Dependency setup also downloads Playwright's pinned Chromium browser, so allow internet access and time for that download. On an existing installation, close VS Code windows using Pie before reinstalling to avoid locked dependency files.

Double-clicking `install.bat` also works; it pauses at the end so the window doesn't close immediately.

### What the installer does

The installer is idempotent and safe to re-run. On each run it:

1. **Sets `PI_CODING_AGENT_DIR`** to the repo root as a Windows User environment variable so Pie reads `settings.json` and `models.json` from here.
2. **Pins `PI_CODING_AGENT_SESSION_DIR`** to this checkout's `data/outcomes/sessions/` for Pie's machine-local session JSONL store.
3. **Configures the auth directory** at `%LOCALAPPDATA%\pie\` and sets `PI_CODING_AGENT_AUTH_DIR`. Existing custom User-scope auth directories are preserved; any in-tree `auth.json` is relocated or merged.
4. **Merges split-brain auth** if credentials are found in an in-tree `auth.json`, then removes the in-tree copy after merging.
5. **Writes `pie.agentDir`** to VS Code User settings so the extension host forwards the correct config directory, even before VS Code picks up updated User environment variables.
6. **Repairs extension paths** in `settings.json` (committed paths may reference another machine's npm global tree).
7. **Migrates session history** from legacy `~/.pi/agent/sessions/`, `data/sessions/`, and `<repo>/sessions/` roots into the current checkout's local `data/outcomes/sessions/` store.
8. **Runs `npm run bootstrap -- --package`**. Bootstrap starts with root `npm ci` (whose postinstall restores the additional locked dependency trees), then acquires one verified source Pi artifact, restores configured Pi package sources through its local Node CLI, checks generated model files, builds and packages the VS Code extension, and checks that same artifact with doctor. No global Pi is installed or required.
9. **Installs the resulting VSIX** when the VS Code CLI is available and runs post-install readiness checks for auth, paths, versions, and split-brain credentials.

Configuration comes from Git, while credentials, sessions, logs, analytics, dependencies, and build outputs remain local to each machine.

## Model Configuration

The provider catalog, pricing, eligibility, concurrency, retry policy, and initial chat/pruning selections have a single source of truth: [`models.yaml`](models.yaml). Existing chat and pruning selections are user preferences owned by `settings.json`; synchronization seeds them only when absent. After editing the catalog or defaults, regenerate the derived files:

```bash
npm run sync-models            # regenerate models.json, model-profiles.yaml, settings.json model fields
npm run sync-models -- --check  # dry-run: exit 1 if any derived file is out of sync
```

Do not edit `models.json` or `model-profiles.yaml` directly. Change active chat and pruning selections through the UI (which writes `settings.json`); `sync-models` preserves those choices. The `model-config-sync` test guards generated catalog drift.

## Authentication

Remote providers need credentials before the pie panel can send messages through them. Configure a provider API key as a User environment variable, or keep using credentials already present in `auth.json`:

### Provider API key (environment variable)

Set a provider API key as a persistent environment variable. The backend reads it automatically.

```cmd
setx ANTHROPIC_API_KEY "sk-ant-..."
REM then open a NEW terminal for it to take effect
```

Set the environment variable for the provider you use. Examples (not an exhaustive list) include `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY`.

The installer does not install a global `pi` CLI, and `pi /login` is no longer a setup step. It migrates an existing `%USERPROFILE%\.pi\agent\auth.json` when present; this source-runtime migration does not add replacement interactive subscription-login onboarding. For a new setup, use a provider API key as described above.

### Where auth.json lives

| Default secure location | Env var override |
|---|---|
| `%LOCALAPPDATA%\pie\auth.json` | `PI_CODING_AGENT_AUTH_DIR` |

`auth.json` is git-ignored and should never be committed. The installer restricts file permissions to the current user only.

## Troubleshooting

### No models appear in the pie panel

**Cause:** The selected agent/config directory from `pie.agentDir` or `PI_CODING_AGENT_DIR` is stale or does not point to this checkout, so its `models.json` is not loaded.

**Fix:** The installer writes `pie.agentDir` to VS Code User settings and sets `PI_CODING_AGENT_DIR`. If models still don't appear:

1. Open VS Code Settings (JSON) and verify `"pie.agentDir": "C:\path\to\pie"` points to this checkout.
2. Reload the VS Code window (Developer: Reload Window) — not just the panel.
3. If running the extension from source, rebuild with `npm run extension:build` from the repository root.

### 401 / "invalid api key" error

**Cause:** The backend reads `auth.json` from `PI_CODING_AGENT_AUTH_DIR` (the secure location), but it's empty `{}` while real credentials are stranded in the repo-root `auth.json`.

This can happen when an older `pi` CLI was run in a shell that didn't inherit `PI_CODING_AGENT_AUTH_DIR`.

**Fix:** Re-run the installer; it safely merges in-tree credentials into the secure location:

```cmd
.\install.bat
```

### Pi runtime artifact missing or rejected

The backend verifies the `pi-runtime` artifact bundled with its built output for the selected Node target; it does not fall back to a global or host-local SDK. `pie.sdkPath` and `PI_SDK_PATH` are not supported runtime selectors.

Run `npm run doctor` to verify the checkout-built artifact at `application/hosts/vscode/out/pi-runtime`. To check another artifact without changing it, pass an absolute path:

```bash
npm run doctor -- --pi-runtime "<absolute artifact directory>"
```

Doctor only verifies the selected artifact read-only; it does not build, acquire, or execute Pi. Under normal safe maintenance conditions, `npm run bootstrap` rebuilds and checks the checkout's artifact.

### VS Code env vars not taking effect

**Cause:** VS Code only picks up new User-scope environment variables on a **full restart**, not on window reload. The installer sets `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_AUTH_DIR` at User scope.

**Fix:** The installer also writes `pie.agentDir` to VS Code User settings, which applies on window reload. A new integrated terminal or full VS Code restart is needed for processes to inherit changed User-scope environment variables.

## Multi-machine workflow

Use Git—not Dropbox, OneDrive, or copied working directories—to move configuration between Windows machines. Clone to the final location, select the pinned Node version, and run `install.bat`. Configure provider credentials independently on each machine; never transfer `auth.json`.

For a deterministic dependency/build refresh after pulling, first close all VS Code windows using Pie (Windows may lock running extension dependency files), then run from an external terminal:

```bash
npm run bootstrap
```

Bootstrap runs root `npm ci`, restores configured Pi packages through a verified local source CLI, checks generated model files, then reuses one verified source artifact for the extension build and doctor. It does not install or require global Pi. Pass `--package` to also create a VSIX (`install.bat` uses this flow and installs the resulting package):

```bash
npm run bootstrap -- --package
```

To reuse an existing verified artifact, pass `npm run bootstrap -- --pi-runtime "<absolute artifact directory>"`. The source-runtime installer/bootstrap and doctor routes are implemented in this checkout; they do not establish a deployed runtime or completed cutover. During the active-manager safety gate, do not run `install.bat` or bootstrap, stage/publish an extension runtime, install the VSIX, or restart VS Code. Keep the active manager session uninterrupted. See the [migration plan](docs/plans/PIE-PRODUCTIZATION.md).

`npm run doctor` verifies the checkout-built artifact at `application/hosts/vscode/out/pi-runtime` by default. An explicit `--pi-runtime` path overrides that selection for a read-only full-payload check against the executing Node target; neither route uses a global-Pi fallback or mutates the artifact:

```bash
npm run doctor
npm run doctor -- --pi-runtime "<absolute artifact directory>"
```

Dependency updates arrive as monthly Dependabot pull requests for each tracked lockfile root. Review and test those changes; do not run unpinned global upgrades independently on each machine.

See [Persistence and storage](#persistence-and-storage) below before sharing a checkout or backing up local state.

## Quick start

### Test and validate

Run the canonical wrappers from the repository root:

```bash
# dependency-aware tests for working-tree changes (default final development test)
npm test

# focused test file(s) while iterating; pass multiple paths if needed
npm run test:file -- application/backend/test/path/to/test.ts

# full fast suite and opt-in integration suite
npm run test:all
npm run test:integration

# individual and combined validation
npm run typecheck
npm run lint
npm run check      # model drift + typecheck + lint + changed tests
npm run verify     # full verification: model drift + typecheck + lint + full fast suite + build

# release coverage gate, optionally scoped to one package
npm run test:coverage
npm run test:coverage -- --package extension
npm run test:coverage -- --package subagent
```

`npm test` traces changed files through static relative imports and file-URL fixtures, runs affected test files concurrently, and conservatively falls back to a package suite when a changed source has no dependency edge. Test-runner or global shared-infrastructure changes trigger the full fast suite. Use `npm run test:file` for focused tests rather than invoking `npx tsx` directly. Slow tests that require real SDK sessions, process trees, Git repositories, or shell pools live behind `npm run test:integration`. The slower release gate remains available as `npm run verify:release` or `npm run test:coverage`.

Test and typecheck children have a 20-minute watchdog that kills the complete process tree on timeout or runner interruption (including `taskkill /T /F` on Windows). Override it with `PIE_TEST_PROCESS_TIMEOUT_MS`; set `0` only to disable it explicitly.

### Build the pie VS Code extension

For first-time setup, use `install.bat`: it also restores the managed `pi-web-access` and `pi-mcp-adapter` packages needed by the build. `npm ci` alone does not restore those Pi-managed packages. After setup, refresh dependency trees and build from the repository root:

```bash
npm ci                             # also restores the additional locked dependency trees via postinstall
npm run extension:build            # validate + stage runtime + publish renderer
npm run extension:build:validate   # compile/validate without publishing
npm run extension:activate         # one-time startup loader setup or upgrade
npm run extension:package          # produce a .vsix when needed
```

For an extension-only refresh after dependencies are already installed:

```bash
cd application/hosts/vscode
npm run build      # compile/validate + publish one renderer generation
```

Useful extension commands:

- `npm run build:validate` — compile and validate coordinated host/renderer output without touching the installed extension
- `npm run publish:renderer` — publish already-validated renderer output only
- `npm run watch` — incremental Vite rebuilds plus a concurrent TypeScript watch; each complete emission publishes an immutable renderer generation
- `npm run watch -- --skip-typecheck` — Vite-only watch when typechecking elsewhere
- `npm run activate` — one-time startup loader setup or explicit upgrade; takes effect on the next normal VS Code restart without stopping running sessions
- `npm run test` — unit tests
- `npm run typecheck` — incremental type-only check
- `npm run package` — produce a `.vsix`

Ordinary build/watch publication stages a complete immutable runtime under the matching installed extension, without overwriting loaded bundles or rewriting `package.json`. The startup loader validates content hashes and selects the newest complete generation on every normal VS Code startup. **Restarting VS Code therefore loads the latest successfully published build.** Active windows retain their own runtime leases and keep working; no automatic restart is performed. Startup displays “Loading updated Pie build…” for a new generation, while running windows show “Pie update ready”. Renderer-only changes can still publish live.

Older installations need `npm run extension:activate` once, or a new VSIX installation, to install the startup loader. This setup publishes immutable loader files and changes the next-start entrypoint, so even Windows does not need locked host files replaced. Restart VS Code when convenient afterward. Routine code changes need only a build and a normal restart, not another manual installation. Extension manifest/SDK dependency upgrades remain explicit installation work.

Full-runtime publication retains the current and prior generations plus leased generations. A crashed host's lease is retained conservatively because orphan workers may still need its files; it is not automatically reclaimed merely because its parent PID disappeared. Pi packages, runtime dependencies, and assets are verified inside each output's `pi-runtime` artifact and share its lifetime. Startup checks the selected backend Node target and does not fall back to an external SDK installation. Development can select another verified artifact only with both `PIE_DEVELOPMENT_PI_RUNTIME=<absolute artifact directory>` and `PIE_ALLOW_DEVELOPMENT_RUNTIME=1`; `pie.sdkPath` and `PI_SDK_PATH` are not fallback selectors. Settings, credentials, sessions, and other user data remain outside runtime generations.

Keep **built**, **staged**, **loaded**, and **behavior verified** distinct. Staged files are not evidence that existing windows have loaded the update.

### Run the standalone localhost UI

After building the extension, start the standalone browser host on Windows:

```cmd
.\start-pie.bat
```

The launcher requires Windows PowerShell 5.1 and does not install or rebuild dependencies. It prompts for an **absolute workspace path**, then asks whether to enable trusted-LAN access (default **No**). The prompt always sends an explicit choice, so answering No disables LAN even if it was enabled in a prior run. You can pass `-AllowLan` to the launcher to opt in without the prompt. LAN access is unauthenticated and has no TLS: anyone who can reach the URL can execute Pie commands and read or modify files. Use it only on a trusted local network; internet/public access is unsupported. The launcher does not change firewall rules.

The launcher requires the generated runtime first:

```bash
npm run extension:build
```

It launches the built `application/hosts/vscode/out/standalone.js` entry and prints the actual localhost URL, normally `http://127.0.0.1:1997` (or an assigned fallback port). It does **not** open a browser; paste a printed URL into one. With no saved preference, it binds only to loopback. If LAN is enabled, Pie also prints usable private IPv4 LAN URLs; use one of those from another device on the same trusted network.

For direct CLI use, `node application/hosts/vscode/out/standalone.js --cwd <absolute-workspace-path> [--lan | --no-lan]` is supported; `--help` prints the options. An explicit LAN flag overrides and saves the preference before the server starts. Omitting both flags restores the saved preference (or loopback-only when no preference has been saved).

For the VS Code host, set `pie.browserServer.allowLan` to `true` in User Settings and run `pie: Restart Browser Server` (or restart the extension host). The default remains `false`. The browser server accepts requests only from loopback or private IPv4 peers; Host and WebSocket Origin checks further require loopback or the exact private IPv4 addresses advertised by that running instance. Arbitrary hostnames/public addresses remain rejected, including clients that try to forge browser headers. LAN URLs are not advertised for public IPv4 interfaces.

In VS Code, the composer's **Browser network access** popover also exposes a **Run browser server** switch (VS Code only). It persists the same application-scoped `pie.browserServer.enabled` global setting and starts/stops the shared localhost listener on demand, showing the actual listener status, URLs, pending change, and any failure. Turning it off does not close the sidebar; a browser renderer attached to the host must confirm before stopping because that stops its own connection. Standalone never offers the switch because the browser server is its only UI. The LAN toggle remains a saved preference and never implicitly starts a disabled listener.

If another device cannot connect on Windows, manually add an inbound Windows Defender Firewall rule for TCP on the port Pie printed (normally `1997`), scoped to the **Private** profile and trusted local network. Do not enable the rule for Public networks. Pie never changes firewall settings automatically. If the configured port fell back, use the actual printed port in the rule.

Press **Ctrl+C** to request graceful shutdown. If the 15-second supervisor deadline is exceeded, only Pie's private Windows Job is force-terminated. Closing the launcher console also cleans up that owned process tree through the Job's kill-on-close policy; it does not delete Pie's runtime data.

Standalone uses the same `HostRuntime`, backend, browser server, session/transcript authorities, and active analytics authority as the VS Code composition. Managed runtime output uses the existing generation lease, acquired before artifact/runtime use and released only after confirmed owned teardown; uncertainty retains it. Packaged flat output instead has package-install lifetime with no generation-GC lease protection. An explicit `runtimeOutputDirectory` is caller-owned and must remain immutable and available until confirmed shutdown; standalone does not delete it or claim it is leased. Its small host-storage document is workspace-scoped under the resolved data root and holds standalone equivalents of renderer/session-service preferences and tab checkpoints. The launcher prompt always applies its answer with a default of No; direct CLI startup restores the saved LAN preference unless `--lan` or `--no-lan` explicitly overrides and persists it. VS Code-specific file picking, settings, editor open/reveal, and file/diff actions are unavailable in standalone mode.

### One active pie host per machine

Pie enforces a single active host per machine across VS Code and standalone (VS Code takes priority), via an OS-owned exclusive loopback coordinator (fixed port `1996`, overridable with `PIE_HOST_COORDINATOR_PORT`). Ownership is the bound socket itself — the kernel grants it to exactly one starter and frees it when the owner dies, so there is no stale PID file and no process is ever killed by PID. The host acquires ownership before any runtime/backend startup and releases it only after shutdown has actually finished.

- **Standalone** refuses to start while any host is active and prints an explicit terminal refusal (exit code 2). It started no runtime or backend.
- **A second VS Code window** is refused with a visible notification; only the first window's pie runs.
- **VS Code taking over from standalone** shows a progress notification, asks the standalone host to stop, waits a bounded time (`PIE_HOST_HANDOFF_TIMEOUT_MS`, default 30s), and starts only after the standalone released. On timeout pie fails closed and terminates nothing.
- A standalone host that is asked to stop logs that VS Code requested the stop, shuts down gracefully, and retains saved sessions.

Scope and limits: the coordinator is loopback-only (never reachable over LAN) and machine-global — a pie host under another local OS user session also occupies it, so a second user is refused rather than taking over. The graceful handoff request is unauthenticated local IPC, accepted within this single-user desktop scope. See [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md) ("Single active pie host per machine") for the contract.

### Query local analytics

Named batch queries run against the retained local DuckDB workspace, which reads privacy-safe legacy run-analytics exports and storage stores:

```bash
# from repo root
npm run analytics:build-db
npm run analytics:query -- --name core_runs
```

Other analytics helpers from the repo root: `analytics:typecheck`, `analytics:test`, and `analytics:validate`.

Runtime usage/cost questions are answered from the canonical SQLite store instead (see [Persistence and storage](#persistence-and-storage) and the [query-analytics skill](harness/agent-instructions/skills/query-analytics/SKILL.md)); the DuckDB workspace never reads or writes it.

## Persistence and storage

Pie has one OS-local runtime-data root, resolved from `PIE_DATA_DIR` or the platform default, holding `analytics/`, `sessions/`, `artifacts/`, `state/`, and `cache/`. See [docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md](docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) for the layout and the authority rules.

- Analytics have two authorities, and only one is active at a time: the legacy owners (`data/outcomes/<workspace-id>/` run analytics plus the workspace billable-invocation ledger and activity timeline) stay authoritative whenever the resolved state directory records no active canonical generation — no manifest, or a validated candidate/ready manifest. With a validated active generation, capture goes exclusively to `<data-root>/analytics/analytics.sqlite` and the legacy ledger is not written at all — never a dual-write, and no import of old analytics into the canonical store. A malformed or inconsistent activation state fails startup closed instead of falling back to legacy.
- Privacy mode means delete on explicit session close: capture stays available while the session is open, and closing a private session deletes its captured analytics. Under legacy authority, privacy instead suppresses run analytics and scrubs existing records.
- `data/outcomes/` is the machine-wide session authority for this checkout, independent of cwd and VS Code workspace. It contains canonical session JSONL and workspace-sharded analytics stores.
- The installer pins `PI_CODING_AGENT_SESSION_DIR` to `data/outcomes/sessions/`. The separate transcript-root switch that would move new sessions under `<data-root>/sessions/` is implemented behind the explicit `PIE_STORAGE_CUTOFF_AUTHORIZATION=p7b-authorized-v1` gate; nothing in this repository sets it, so do not assume it is in effect.
- `data/` is git-ignored runtime data, not portable configuration. Do not cloud-sync it and never let two machines write to the same outcomes authority.
- When an existing session environment points elsewhere, the installer merges its durable transcripts and completed run snapshots into the canonical authority. Retired review and closure files remain at their source; private close still scrubs the exact session from those legacy files before deleting its transcript.
- Back up session data only to encrypted storage; transcripts can contain source code, prompts, paths, tool output, and secrets.

### Storage locations

| State | Default location | Override env var |
|---|---|---|
| Auth tokens | `%LOCALAPPDATA%\pie\auth.json` | `PI_CODING_AGENT_AUTH_DIR` |
| Runtime data root | `%LOCALAPPDATA%\pie\data` | `PIE_DATA_DIR` |
| Canonical analytics | `<data-root>/analytics/analytics.sqlite` (only under canonical activation) | `PIE_DATA_DIR` |
| Sessions | `data/outcomes/sessions/` (in-tree, git-ignored) | `PI_CODING_AGENT_SESSION_DIR` |
| Run analytics | `data/outcomes/<workspace-id>/` (globally aggregated) | `PIE_ANALYTICS_DIR` |

The host logs resolved storage paths in its `backend` log channel entry, `starting pie backend`.

## More docs

- [AGENTS.md](AGENTS.md) — global agent traversal and shell conventions
- [develop-pie skill](harness/agent-instructions/skills/develop-pie/SKILL.md) — Pie-specific working conventions, commands, and architecture references
- [Architecture](docs/architecture/ARCHITECTURE.md) — system design and boundaries
- [Documentation policy](docs/DOCUMENTATION-POLICY.md) — keeping documentation simple and connected
- [docs/contracts/STATE_CONTRACT.md](docs/contracts/STATE_CONTRACT.md) — authoritative host ↔ webview sync contract
- [docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md](docs/contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) — analytics authority, data root, privacy and gated storage-cutoff contract
- [query-analytics skill](harness/agent-instructions/skills/query-analytics/SKILL.md) — querying the canonical analytics store
- [UI design philosophy](docs/architecture/UI-DESIGN-PHILOSOPHY.md) and [GUI development](docs/operations/GUI-DEVELOPMENT.md)
- [analytics/analysis/README.md](analytics/analysis/README.md) — local DuckDB analytics workspace
