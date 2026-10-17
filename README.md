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

- Node.js **24.16.0**, pinned by `.node-version` and `.prototools`
- Proto-managed pnpm **10.34.4** and Moon **2.4.2**; the root `packageManager` also pins pnpm
- VS Code, for interactive extension work

Pi is built from the repository's pinned source and shipped with the extension as a verified `pi-runtime` artifact. Setup does not install a global `pi` CLI or rely on a host-local locked SDK.

## Install

On a new Windows device, install Git, VS Code, and the exact Node.js version above, then clone to the location where you intend to keep Pie. `install.bat` is the repository's setup entry point:

```cmd
git clone https://github.com/OwanL/pie.git
cd pie
.\install.bat
```

Node.js must already be on PATH. For dependency-only setup, use `proto run pnpm -- run setup` (the `install:dependencies` script is an alias). Both enter the shared Proto-selected frozen pnpm install with lifecycle scripts disabled and a writer gate that refuses to modify the Pi workspace while development readers are active. On an existing installation, close development hosts and test processes that read the native Pi workspace before retrying setup; do not bypass the gate with a direct install command.

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
8. **Calls `proto run pnpm -- run bootstrap --package`**. After gated root setup, bootstrap defaults to compiling the existing Pi workspace and preparing a private pnpm-derived runtime artifact; it restores configured Pi package sources, checks generated models, builds the host, optionally packages it, and runs doctor. An explicit `--pi-runtime` instead reuses a verified artifact and skips workspace compilation. The host build explicitly selects `--delivery --pi-runtime`, writes delivery output, and does not publish.
9. **Installs a produced VSIX** when the VS Code CLI is available and runs post-install readiness checks for auth, paths, versions, and split-brain credentials.

Full install acceptance has not been run; this is an acceptance gap, not a missing-argument blocker. The [migration plan](docs/plans/PIE-PRODUCTIZATION.md) is the status authority.

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
3. For the isolated source-development host, rebuild with `proto run pnpm -- run build` from the repository root; this writes local development output and does not publish to an installed extension.

### 401 / "invalid api key" error

**Cause:** The backend reads `auth.json` from `PI_CODING_AGENT_AUTH_DIR` (the secure location), but it's empty `{}` while real credentials are stranded in the repo-root `auth.json`.

This can happen when an older `pi` CLI was run in a shell that didn't inherit `PI_CODING_AGENT_AUTH_DIR`.

**Fix:** Re-run the installer; it safely merges in-tree credentials into the secure location:

```cmd
.\install.bat
```

### Pi runtime artifact missing or rejected

The backend verifies the `pi-runtime` artifact bundled with its built output for the selected Node target; it does not fall back to a global or host-local SDK. `pie.sdkPath` and `PI_SDK_PATH` are not supported runtime selectors.

Run `proto run pnpm -- run doctor` to verify the checkout-built artifact at `application/hosts/vscode/out/pi-runtime`. To check another artifact without changing it, pass an absolute path:

```bash
proto run pnpm -- run doctor -- --pi-runtime "<absolute artifact directory>"
```

Doctor verifies the selected artifact read-only; it does not build, acquire, or execute Pi. Bootstrap without `--pi-runtime` follows the default source-compilation/private-artifact path above; an explicit path selects verified artifact reuse and skips that compile.

### VS Code env vars not taking effect

**Cause:** VS Code only picks up new User-scope environment variables on a **full restart**, not on window reload. The installer sets `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_AUTH_DIR` at User scope.

**Fix:** The installer also writes `pie.agentDir` to VS Code User settings, which applies on window reload. A new integrated terminal or full VS Code restart is needed for processes to inherit changed User-scope environment variables.

## Multi-machine workflow

Use Git—not Dropbox, OneDrive, or copied working directories—to move configuration between Windows machines. Clone to the final location and select the pinned Node version. The `install.bat` entry point sets up user/session/auth paths; see the migration plan linked above for full install acceptance status. Configure provider credentials independently on each machine; never transfer `auth.json`.

For dependency refresh after pulling, close development hosts and tests that read the native Pi workspace, then run the shared gated setup from an external terminal:

```bash
proto run pnpm -- run setup
# Alias for the same script:
proto run pnpm -- run install:dependencies
```

To build and doctor against an already verified artifact, pass its absolute artifact root explicitly. Add `--package` only when a VSIX is needed:

```bash
proto run pnpm -- run bootstrap -- --pi-runtime "<absolute verified artifact directory>"
proto run pnpm -- run bootstrap -- --pi-runtime "<absolute verified artifact directory>" --package
```

These explicit `--pi-runtime` commands verify and reuse the selected artifact, skipping source compilation; bootstrap without that option uses its default source-compilation/private-artifact path. Doctor is read-only. Gated setup is allowed when no development readers are active; preserve active workspace readers and the installed host rather than stopping them or bypassing the gate. Setup/build do not authorize publication, VSIX installation or an installed-host restart. See the [migration plan](docs/plans/PIE-PRODUCTIZATION.md) for acceptance status.

`proto run pnpm -- run doctor` verifies the checkout-built artifact at `application/hosts/vscode/out/pi-runtime` by default. An explicit `--pi-runtime` path overrides that selection for a read-only full-payload check against the executing Node target; neither route uses a global-Pi fallback or mutates the artifact:

```bash
proto run pnpm -- run doctor
proto run pnpm -- run doctor -- --pi-runtime "<absolute artifact directory>"
```

The main workspace uses one shared `pnpm-lock.yaml`. Review and test dependency changes against that lock; do not run host-local npm installs or unpinned global upgrades independently on each machine.

See [Persistence and storage](#persistence-and-storage) below before sharing a checkout or backing up local state.

## Quick start

### Test and validate

Run the canonical wrappers from the repository root:

```bash
# Primary root test route: Moon's affected project-task graph
proto run pnpm -- run test

# Focused native Node test file (TypeScript is loaded through the local tsx setup)
proto run pnpm -- run test:file application/backend/test/path/to/test.ts

# Focused SDK-backed artifact fixture, using a separately verified runtime
proto run pnpm -- run test:file --sdk-path "<absolute verified runtime root>/node_modules/@earendil-works/pi-coding-agent" harness/tool-and-skill-selection/prepass/test/completion-entry.artifact.test.ts

# Dedicated SDK artifact-fixture task (without a path, it prepares one private SDK artifact)
proto run pnpm -- run test:artifact
# Or reuse an already verified runtime; this skips artifact preparation, not the Pi workspace build prerequisite
proto run pnpm -- run test:artifact -- --pi-runtime "<absolute verified runtime root>"

# All configured Moon project test tasks; opt-in integration route
proto run pnpm -- run test:all
proto run pnpm -- run test:integration

# Individual root checks
proto run pnpm -- run typecheck
proto run pnpm -- run lint
proto run pnpm -- run check
proto run pnpm -- run verify

# Compatibility alias for affected Moon tests; retained legacy coverage gate
proto run pnpm -- run test:fast
proto run pnpm -- run test:coverage
proto run pnpm -- run test:coverage -- --package extension
proto run pnpm -- run test:coverage -- --package subagent
proto run pnpm -- run verify:release

# Explicit nonpublishing delivery qualification, including both headless hosts/browser
proto run pnpm -- run delivery:qualify
# Reuse an existing verified runtime and skip Pi compilation/artifact construction
proto run pnpm -- run delivery:qualify -- --pi-runtime "<absolute verified runtime root>"
```

`test` uses Moon's `:test --affected --include-relations` tasks with explicit consumer-source inputs. Project dependencies alone do not select consumer tests in Moon 2.4.2; deep task traversal is intentionally omitted because it can pull artifact tasks into ordinary checks. The uncached `proto run moon -- run root:graphTest` qualifies affected selection using temporary Git fixtures and NOOP commands, without running application builds or providers. It is not the legacy static-import/file-URL fixture selector. Affected dispatch is conservative at project granularity and may run a whole owning project's configured tests. Ordinary Moon test tasks exclude files matching `*.artifact.test.*`; the default `test:artifact` selectors include SDK-backed cases and development-refresh/checkpoint suites, whose assertions remain in place for the separate artifact task. SDK-backed package-resolution, unbundled-module and CLI cases run in artifact companions; their SDK-free cases remain in ordinary tests. The generic native runner accepts repeatable `--include` and `--exclude <repo-relative glob>` filters. `test:all` dispatches all configured Moon `:test` tasks. `test:fast` and `test:changed` are affected-Moon aliases; legacy package commands with `--fast` now invoke the native runner. The old fast batching, impact selection, custom result cache and cost tooling are removed.

`test:artifact` is the separate SDK-backed route: it delegates to Moon's `root:artifactTest` task (which depends on `pi:build`), then invokes the artifact runner once for the selected fixtures. It prepares one private SDK artifact, or accepts an explicit verified runtime via `-- --pi-runtime "<absolute verified runtime root>"` and skips private artifact preparation; the Pi workspace compilation prerequisite still runs either way. This route exercises production-style SDK bytes, not an application release build, publication, installation, or an SDK cache. The ordinary Moon test task's use of the compiled native workspace SDK is a task-boundary distinction, not a lightweight-artifact or speed claim. Some provider/integration cases still need credentials or explicit opt-in; existing skip flags remain unchanged, and this route does not mean every fixture or integration smoke was run or qualified.

`test:file` runs native `node:test`; TypeScript test files use private per-file CommonJS entry wrappers with the local `tsx` loader, while JavaScript and `.mjs` entries use Node's standard loading. This does not use esbuild or a custom test queue, and the runner's process isolation remains in place. Focused checks qualify this compatibility route, not ESM namespace behavior, top-level await, or full native parity. Its `--sdk-path` option supplies module aliases from an already compiled SDK package; it does not acquire or verify an artifact, so SDK-backed source fixtures must use the coding-agent package from a separately verified `pi-runtime`, never the native workspace package. Do not invoke `npx tsx` directly.

For explicit offline Pi Vitest qualification, use `proto run node -- scripts/verification/test-framework-offline.mjs --package ai --` (or `agent` / `coding-agent`, with Vitest arguments after `--`). The selected Pi package must already be compiled; this command checks for its entry point and does not build Pi. The invocation isolates credentials and state, disables automatic local-model tests, denies external Node networking, and holds the workspace reader through confirmed teardown. It does not change ordinary developer commands or qualify skipped provider cases; native subprocess networking is not sandboxed.

Native coverage is refused before child launch for TypeScript, including artifact fixtures. JavaScript and `.mjs` native coverage remains usable, including threshold enforcement. `test:coverage` and `verify:release` remain the supported coverage lane. Their retained Node/tsx tests now use invocation-private V8 ranges and exact evaluated-script/source-map captures, converted through the pinned agent test framework's AST-aware Istanbul tooling. Coverage fails closed when source provenance is missing or conflicting; generated compiler scaffolding is excluded only after syntax and provenance checks. Release owners run in four rolling slots without changing test APIs, file concurrency, deadlines or thresholds. Raw evidence and alias overlays are retained on accounting failures or uncertain teardown. This is not permission to use Node's unqualified native TypeScript totals, nor a claim of full live/browser/provider qualification. The [migration plan](docs/plans/PIE-PRODUCTIZATION.md) owns evidence, status and remaining acceptance limits.

Test and typecheck children have a 20-minute watchdog that kills the complete process tree on timeout or runner interruption (including `taskkill /T /F` on Windows). Override it with `PIE_TEST_PROCESS_TIMEOUT_MS`; set `0` only to disable it explicitly.

When an explicitly selected SDK resolves to the native Pi workspace package, its development-reader lease blocks workspace setup/rebuild until reader teardown is confirmed. A denied operation reports the registered reader/writer identities; temporary native-runner diagnostics capture owned process identities in `teardown.json`. Inspect registrations read-only with `proto run node -- scripts/development/inspect-workspace.mjs harness/pi` (or an isolated Pi workspace root). Operation/invocation labels and owned artifact paths help locate diagnostics; legacy records without metadata remain unresolved, not safe to remove. The snapshot is not lifetime proof or recovery authorization. The gate fails closed and never reclaims registrations by PID or age. Do not kill an installed Pie process or blindly remove gate state; use the [canonical development-workspace gate](lib/development-runtime/lifetime.mjs) diagnostics and the [productization plan](docs/plans/PIE-PRODUCTIZATION.md) for status and recovery authority.

### Build and run Pie from source

Use the repository-root shortcuts through Proto so the pinned pnpm, Moon, and Node toolchain is selected:

```bash
proto run pnpm -- run build          # compile into application/hosts/vscode/out-dev
proto run pnpm -- run watch          # development build plus shared renderer watch/reload
proto run pnpm -- run dev            # launch the isolated standalone development host
proto run pnpm -- run dev:vscode     # launch the isolated VS Code development host
```

Ordinary build and watch are development-only. They compile the host/backend and the local Pi workspace into `application/hosts/vscode/out-dev`; this workspace route has no `pi-runtime` artifact manifest. They never stage or publish files to an installed extension, install anything, or assert that a runtime is loaded. The launcher keeps persistent state in a repository-specific development profile with separate agent settings, auth, sessions, data, home/temp, VS Code user data, and extension directories, and uses its own host coordinator. It seeds public defaults, not installed-host settings/auth/history; optional remote packages are not automatically acquired. Configure private development settings/auth in the printed profile. Ambient provider environment variables can still be inherited: profile isolation is not a credential sandbox. Session settings and legacy fallback paths are private too. It does not snapshot the Pi workspace. A reader gate protects compiled workspace use from Pi rebuilds: stop the development host before refreshing backend or real Pi code, run `build`, then relaunch. This recompiles the workspace and selects the refreshed Pi bytes without touching installed output. Renderer changes use the shared frontend rebuild; the running development host reloads completed renderer output, not HMR.

Development acceptance is opt-in and consumes existing `out-dev`; ordinary tests do not launch a visible Electron window. For private standalone and headless VS Code adapter checks, set `PIE_RUN_DEVELOPMENT_HOST_TESTS=1` and use `test:file` on `scripts/development/test/standalone-development.test.mjs` or `scripts/development/test/vscode-development.test.mjs`. The artifact refresh fixture uses the same opt-in and qualifies stop → private rebuild → relaunch against real Pi/session discovery. The VS Code fixture mocks the VS Code API; it is not Electron acceptance.

Only after explicit user consent, run visible Electron acceptance from Git Bash:

```bash
PIE_RUN_ELECTRON_ACCEPTANCE=1 proto run node -- scripts/development/test/electron-acceptance.mjs
```

The isolated real-Electron acceptance passed actual transcript synchronization, 15-second stable sidebar observation and confirmed teardown of all owned trees. This is not installed-host, all-browser or live-provider qualification; the [plan](docs/plans/PIE-PRODUCTIZATION.md) owns acceptance evidence and limits.

Delivery is a separate explicit path. `proto run pnpm -- run delivery:build` selects `--delivery` and writes the verified artifact under `application/hosts/vscode/out`; it does not publish it. `proto run pnpm -- run extension:package` packages a VSIX through the delivery path but does not install or publish it. `proto run pnpm -- run extension:publish` explicitly selects `--delivery --publish` and publishes to a matching installed extension. Loader installation/upgrade uses the explicit script command `proto run node -- scripts/build/build.mjs --delivery --activate`. Neither building nor publishing proves that an extension has been installed, loaded, or behavior-verified. See the [migration plan](docs/plans/PIE-PRODUCTIZATION.md) for acceptance tracking.

`delivery:qualify` builds a new package under OS temp, then runs the existing relocated standalone and mocked VS Code bootstrap checks with headless browser first paint. Its default route uses reader-gated Pi compilation and fresh artifact preparation; explicit `--pi-runtime` verifies/reuses caller-owned bytes and skips Pi compilation. The task is uncached and is not part of ordinary checks. It never publishes, installs, starts visible Electron, downloads a browser, or sends provider prompts. Successful confirmed teardown removes the temporary package; failed, cancelled or uncertain child completion retains it and prints its location. This is delivered-byte smoke evidence, not installed-host adoption, real Electron acceptance, all browser behavior or coverage parity.

### Run the standalone localhost UI

After building the extension, start the standalone browser host on Windows:

```cmd
.\start-pie.bat
```

The launcher requires Windows PowerShell 5.1 and does not install or rebuild dependencies. It prompts for an **absolute workspace path**, then asks whether to enable trusted-LAN access (default **No**). The prompt always sends an explicit choice, so answering No disables LAN even if it was enabled in a prior run. You can pass `-AllowLan` to the launcher to opt in without the prompt. LAN access is unauthenticated and has no TLS: anyone who can reach the URL can execute Pie commands and read or modify files. Use it only on a trusted local network; internet/public access is unsupported. The launcher does not change firewall rules.

The standalone launcher uses the delivery output, not the ordinary development build. Generate it locally without publishing or installing it:

```bash
proto run pnpm -- run delivery:build
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
