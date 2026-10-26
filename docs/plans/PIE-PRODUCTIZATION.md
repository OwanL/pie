# Pie productization

**Updated 2026-10-26.** Current scope, decisions and acceptance gates for making Pie usable without its maintainer's checkout or assistance. This replaces the migration diary; historical measurements and receipts remain in Git history, not a second plan.

## Goal and release boundary

A new user on a qualified desktop platform can install from the VS Code Marketplace, connect a provider, complete a useful coding task, restart and resume, and update without losing configuration or history. Neither normal setup nor model management requires editing source files, running generators or installing the development toolchain.

Release sequence: **VS Code extension → Electron desktop app → website for desktop discovery/distribution**. Target Windows, macOS and Linux during the VS Code phase, releasing each qualified OS/architecture package independently rather than waiting for all three. A website/domain and standalone installer are not extension-launch prerequisites. Current qualification remains Windows-only; preserve existing platform/storage restrictions until replacements are implemented and qualified. Retain the single-user desktop scope with one active Pie host per machine.

This document authorizes no implementation, credential/session migration, storage cutoff, provider traffic, publication or restart by itself. New product requirements below define the destination; open design choices must be resolved before the affected implementation. Preserve active sessions and unrelated working changes.

## Completed foundations

Do not rebuild these as prerequisites for productization:

- **Owned Pi source:** the four matched Pi packages derive from upstream **0.80.6**, commit `2b3fda9921b5590f285165287bd442a25817f17b`, with typed Pie changes and preserved notices. The shared pnpm lock owns dependencies. A package version is not artifact identity.
- **Windows runtime delivery:** verified runtime/tooling artifacts, immutable generations, leases, explicit packaging/publication, bounded fallback and deliberate rollback exist. Relocated host/browser and packaged-byte checks have passed; installed startup and bounded session resumption have been observed. This is not clean-machine end-user installation acceptance.
- **Development and release tooling:** repository-scoped Proto/pnpm/Moon, isolated hosts, reader-gated workspace builds and an isolated source-to-artifact route exist. The retained TypeScript release/coverage gate has passed; native TypeScript coverage is still unqualified and must not replace it.
- **Provider management:** shared Settings UI/backend, native authentication orchestration, external YAML/secrets/cache separation, discovery, user preferences, immutable runtime capture and worker promotion exist. Private live requests have succeeded for selected Codex and local/Cloud Ollama combinations. That does not establish all-provider entitlement, credential migration or complete installed-feature acceptance.
- **Accounting and session safety:** canonical analytics, captured pricing provenance, durable transcripts, write ownership, interruption/recovery fencing and catalog isolation already have owning contracts and regression coverage. Public cold open publishes conversation history before fresh inventory, with separately fenced inventory delivery; cold creation/duplication and toggle confirmations retain their snapshot-based catalog path.

Current architecture and lifecycle rules belong to [Architecture](../architecture/ARCHITECTURE.md), the [state contract](../contracts/STATE_CONTRACT.md) and the [runtime artifact guide](../../harness/pi-runtime/README.md). Later installed-runtime evidence and bounded maintenance limitations are recorded in [maintenance follow-ups](MAINTENANCE-FOLLOWUPS.md). Earlier release acceptance is recorded at source revision `0b2ffe00a`; the replaced diary is available at Git revision `0bfdd2f2c`. Neither is acceptance of the latest working tree.

## Decisions to retain

### Adoption, identity and licensing

- Prioritise adoption, repeat use and community before monetisation. Keep the local product free and customisable; optional sponsorship and creator content are funding candidates, not selected services or revenue assumptions.
- Rename Pie and settle publisher/extension identifiers before the first public Marketplace listing; defer the domain/site until the desktop distribution phase. Plan initially around an individual publisher in New Zealand; do not introduce company formation as a publication prerequisite.
- Choose **AGPLv3** for the Pie-owned product. The desired protection is reciprocal access to covered improvements: distributed versions carry source-sharing obligations, and modified versions supporting remote network interaction must offer their Corresponding Source to those users. Commercial use and compliant paid forks remain permitted; required notices remain, but neither prominent marketing credit nor contributions to the upstream repository are guaranteed. Branding rules are separate and still need definition. See the [licence text](https://www.gnu.org/licenses/agpl-3.0.html).
- This records the licensing direction, not an applied repository-wide grant. Before applying it, establish copyright authority, exact version grant and coverage for source, shipped instructions/skills and assets; review the delivered dependency graph, preserve upstream licences/notices and define user-customisation boundaries. A bounded audit found no top-level Pie licence and permissive declarations for inspected direct dependencies; it is not complete legal/distribution clearance.

### Product and configuration ownership

- Ship a **curated Pie workflow**: intentionally reviewed general-purpose tools, agents, skills and instructions, not a minimal Pi baseline or a wholesale copy of the maintainer's setup. Most existing working instructions are candidates for product defaults; an instruction is not personal merely because it is opinionated. User-specific changes, integration configuration, machine paths and account/model selections remain separate; the exact shipped inventory still requires review.
- Shipped workflow instructions are opinionated defaults that defer to explicit user and applicable project guidance. Keep automatic logical commits of verified, task-related changes as the default; never include unrelated changes. Committing does not itself authorise pushing or publishing.
- **Under reconsideration; do not implement yet:** the previous choice was **one editable workflow folder** outside installed application files. Its proposed update policy was to successfully back up the complete previous folder, then replace it with the new shipped workflow. Edited defaults and user-added files remain in the backup, not automatically in the active folder. Users perform any restoration/merging themselves or with an agent. Do not add per-file ownership tracking, automatic text merging or per-update approval prompts; this intentionally favours simplicity and the latest defaults over preserving edits as permanent overrides. Backup storage/retention mechanics remain to be defined.
- Personal preferences, provider configuration, credentials, history and caches remain outside that replaceable workflow folder. Separate shipped integration code and schemas from mutable state; personal configuration must not reach the Git remote or enter immutable runtime generations.
- Normal VS Code and standalone share personal provider configuration. Development/test profiles remain private and cannot fall through to installed settings, credentials or history.
- Provider configuration is UI-first with optional schema-validated YAML at `%LOCALAPPDATA%/pie/config/providers.yaml` on Windows; discovery caches live beneath `<resolved data root>/cache/provider-models/`. Qualify equivalent platform defaults through the same path authority before admitting macOS/Linux; the current default provider-config resolver is Windows-only. Secrets remain separate from YAML, chat and ordinary view snapshots.
- Initially support one configured account/endpoint per provider. Preserve `(provider, model ID)` attribution; do not add speculative multi-account machinery.

**Workflow packaging alternative — decision pending:** Pi's [development guide](https://pi.dev/docs/latest/development) covers installed packages/binaries and source execution through common package-asset path helpers; its [configuration model](https://pi.dev/docs/latest/configuration) and the pinned SDK README support user/project instructions, skills and extensions without requiring a fork. User files are separate from application assets, not an editable mirror of every shipped default maintained by whole-folder replacement. Pie already packages its shared implementation. Recommend shipping curated resources with that implementation and reusing existing resource/customisation mechanisms, preserving Pie's main/subagent and private-profile boundaries, rather than creating a managed workflow mirror or requiring source builds for all guidance changes. Writable personal state remains external; source-path assumptions still need correction. This recommendation is not selected, and source-only modification of built-in defaults remains another option. The first-slice proposal below still assumes the earlier mirror policy and must be reconciled before implementation.

**OMP comparison:** [Oh My Pi](https://github.com/can1357/oh-my-pi#install) distributes a Bun package or installer-acquired prebuilt binary rather than requiring a source checkout. Its [bundled task agents](https://github.com/can1357/oh-my-pi/blob/main/docs/task-agent-discovery.md) are embedded at build time; a user agent of the same name overrides the bundled definition, and a project definition takes precedence over the user definition. Default user agents live in `~/.omp/agent/agents/`, project agents in `.omp/agents/`. Its [prompt customisation](https://github.com/can1357/oh-my-pi/blob/main/docs/system-prompt-customization.md) distinguishes `APPEND_SYSTEM.md` (retain defaults and add guidance) from `SYSTEM.md` (replace primary instructions while retaining generated context/tool surfaces). This supports packaged defaults plus user-owned overrides, not a managed mirror of all shipped guidance. Treat it as a design precedent, not approval to adopt OMP's runtime, templating, cross-harness discovery or different subagent inheritance rules. Pie still needs explicit, tested precedence and append/replacement semantics through its existing owners.

### First-run setup

- Focus the first preview on **fresh installs**, with documented manual import for existing configuration/history. Do not build a migration wizard or automatically import, relocate or merge legacy settings, credentials or sessions; leave existing setups untouched until the user explicitly acts.
- Guide users through connecting providers and choosing models, then offer model assignments for title generation, subagents, history compaction and tool/skill selection. Explain each job and its extra usage.
- Prompt users to assign models, but do not recommend particular models, maintain recommendation lists or automatically rank models for these assignments. Users choose from their configured models.
- Assign an initial main session model automatically from the user's enabled, configured models; no separate main-model selection step is required. Users can change it through the normal model picker. Preserve existing users' saved selections.
- Separate model assignments are optional: title generation and tool/skill selection use the main session model when no separate model is assigned, rather than remaining off.

### Provider and request behavior

- Reuse Pi authentication and the current session engine. An upstream upgrade or agent-engine rewrite is not a prerequisite.
- Discover models where supported; retain manual IDs otherwise. Serve cached state immediately and refresh enabled, configured providers asynchronously with bounded work. Listing, configured authentication and successful inference are distinct facts.
- Metadata precedence is **shipped < discovery < explicit user overrides**. Preserve visibility, selections and routing preferences. Discovery never silently changes defaults or enrolls models in automatic routing/subagent pools.
- Never automatically sign in, send paid inference probes, enable account model policies or download models. Explicit connection tests must explain network/billing effects.
- Genuinely new chats capture saved provider setup; copies inherit their source capture, and reopening/replacing a worker retains it. This supersedes the earlier next-user-turn refresh proposal. Do not hot-swap registries or change pinned work. Authentication/revocation remains separately checked: a metadata pin does not guarantee continued access.
- Preserve the human's selected model when it disappears from a listing; listing absence alone is not proof it cannot serve requests. Warn and use valid last-known request settings where authorization and metadata permit. Do not silently replace models or clamp the saved thinking preference; unsupported effective modes require a choice before dispatch.
- Unknown pricing is usable target behavior, not zero/free. Keep token usage and historical attribution, identify partially unpriced totals, and exclude unknown rates from cheapest-model ranking. Do not reprice past requests after refresh.

### Distribution and runtime direction

- Launch through **one VS Code Marketplace listing with platform-specific packages**. Add Windows, macOS and Linux targets as each passes acceptance; do not publish an unrestricted fallback that offers unqualified platforms a nonfunctional build. The exact supported OS/architecture matrix remains to be defined. See [platform-specific publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platform-specific-extensions).
- Bundle optional browser access with both the extension and later desktop app, sharing their backend and sessions. Support local access and opt-in trusted private-LAN access; this is not a cloud service or an internet-exposure commitment. Existing LAN access has no authentication/TLS; retain its explicit limitations and do not imply otherwise. The backend/UI are reusable, but there is no standalone Electron application yet; existing Electron acceptance launches VS Code.
- Separate source from user-installable builds. Normal users install prebuilt releases without cloning the repository, compiling Pie or installing the development toolchain. Source builds remain a contributor workflow. Publish build artifacts separately from Git-tracked source; this does not require a separate source repository.
- Reuse a compatible installed Node runtime. When none is available, download a release-compatible Node runtime into Pie-managed user-local storage. Node binaries do not belong in Git; acquisition must not replace the user's Node installation or alter global PATH. Each release target needs a startup route that can acquire Node without requiring that external Node runtime to run the acquisition.
- On Windows, reuse a suitable installed Git/Bash toolset; otherwise acquire a release-compatible portable copy in Pie-managed user-local storage. Verify the selected payload and preserve its notices. Expose it only to Pie's child processes; do not change global PATH or replace the user's installation. Preserve Bash command semantics rather than silently substituting PowerShell. Project-specific toolchains remain the user's responsibility.
- During setup, check for the Playwright integration's compatible browser payload and download it when missing; do not require a manual browser-install step or defer acquisition until first use. Reuse the supported compatible cache rather than assuming an arbitrary Chrome/Edge installation qualifies. This is a tooling dependency, not Pie's browser/LAN UI or a model download. Other optional dependencies, including Python-based skill helpers, still need a bounded inventory/setup decision.

### Safety and scope

- Preserve the pure reducer/passive-renderer architecture, explicit session addressing, durable-before-terminal publication, write fencing and no-replay recovery. UI polish or faster startup must not weaken these guarantees.
- Preserve the current cold-open/inventory split and its session/token/generation/model-write fences under the state contract. Deferred inventory must remain fresh and isolated; earlier blanket blocking-inventory decisions are superseded. Do not weaken execution admission or substitute stale catalogs to improve apparent readiness.
- Build, package, stage, load and behavior verification are separate states. Do not restart active hosts or reclaim uncertain readers/leases to make progress. Use supported isolation routes.
- The [analytics contract](../contracts/ANALYTICS_IMPLEMENTATION_CONTRACT.md) owns canonical storage and privacy. Its separately gated transcript-root cutoff also changes closure/expiry behavior; moving data out of a checkout does not authorize that cutoff or deletion of old history.

## Remaining work, in order

### 1. Separate the product from personal configuration

**Current gap:** normal installation still points at a checkout agent directory. Tracked settings/defaults select maintainer-specific models, integrations and instruction paths; session storage remains checkout-associated. Provider configuration already has an external authority, so do not create a competing one.

**Required work**

- Classify current configuration/instructions as required product behavior, safe defaults or optional personal customizations. Ship only intentional product defaults; make personal agents, skills, MCP endpoints and account-specific selections opt-in.
- Provision a user-local agent/configuration home shared by both normal hosts. Define precedence for shipped defaults, user preferences, workspace instructions and explicit overrides. Normal UI edits must never modify the application/source checkout.
- Remove inaccessible provider/model assumptions from chat, title generation, pruning and subagent defaults. Optional automation must work with configured eligible models or clearly remain off; it must not secretly require another subscription.
- Document an opt-in manual import path for existing settings, provider/credential references and history, with backups and explicit handling of conflicts. Preserve the original files; do not build a migration wizard or silently import the maintainer's setup, relocate history or merge credentials.
- Decide session-location provisioning separately from the existing storage cutoff, including whether a location-only change is needed. Preserve current closure/retention behavior unless its change is explicitly approved.

**Before implementation:** resolve the workflow ownership/customisation choice, revise and approve the first slice, and review the exact instruction/skill inventory. Settle backup storage/retention only if the editable-copy model is retained. Manual-import-only policy remains selected; the proposed path layout is not a new current-runtime contract.

**Acceptance:** a private empty profile starts with neutral defaults; connecting one supported provider is enough for the core task flow. Settings survive restart and replacement of application files. VS Code resolves the intended personal configuration; preserve shared configuration authority and existing standalone regressions for the later desktop host. Manual-import instructions are checked on disposable fixtures, preserve a reversible path, and neither lose history nor change retention implicitly. Source and release payload stay unchanged.

#### Proposed first implementation slice — not yet authorised

Read-only design review supported the earlier editable-copy approach below. It remains unapproved and must be revised if the workflow policy changes; keep the eventual implementation bounded rather than treating it as the whole public-release project:

1. **Normal profile and path seams.** Propose the existing Windows application/auth home (`%LOCALAPPDATA%/pie`, pending branding) as normal `agentDir`: root `settings.json` and existing `auth.json`, unchanged `config/providers.yaml`, separate `workflow/` and backup folders. Preserve provider/data/auth authorities and explicit overrides rather than introducing a profile manager. Create neutral settings only in the selected normal fallback, never in a rejected explicit path. Retain stale-path diagnostics, explicit source/custom routes and private development-profile precedence; fresh packaged startup must not infer a checkout or fall through to `.pi` or opportunistic credential import. Preserve default-store credential-forget permissions.
2. **Reviewed packaged workflow.** Deliver curated main/child instructions, scout/reviewer/worker and installation-safe general-purpose skills/resources through existing artifact machinery. Preserve read-only agent restrictions and user/project guidance precedence; do not blindly copy pending maintainer instructions. Keep executable integration code in its runtime owners. Decouple both root and subagent/inventory discovery from the settings root and checkout paths.
3. **Replacement and qualification.** Apply the agreed whole-folder backup/replacement only after acquiring host ownership and before resource-consuming children start. Keep pack identity outside the editable folder; make ordinary restart idempotent and interrupted updates recoverable. Recommend retaining versioned backups for manual cleanup initially; retention is not yet selected. Use disposable fixtures, then actual isolated delivered bytes with existing prerequisites, without touching the installed host or making provider calls.

**Proposed initial pack — awaiting approval:** reviewed main/child guidance; scout, reviewer and worker; generalised `check-ui`, `diagnose` and `grill-with-docs`, including their needed skill-local reference files. Preserve project conventions and remove Pie-source-only assumptions. UI checking requires an available browser tool and image-capable model when visual inspection is needed. Keep `develop-pie` and `add-provider` contributor-only; defer `query-analytics` and `pie-logs` until their installed paths/guidance are qualified. Recommend deferring `codebase-maintenance` from this first pack: its helpers require Python/uv, third-party analyzers and npm/npx tooling, not merely a Python interpreter. Define and qualify that dependency setup before promising ready-to-use maintenance tooling; do not expand this slice into new installers or helper rewrites. This inventory does not alter the maintainer's current workflow or establish licence clearance.

The proposed normal `agentDir` naturally externalises the existing `data/outcomes/sessions` default; retain explicit session overrides and existing closure/privacy/retention. Do not use reserved `<data-root>/sessions`, enable the storage cutoff or relocate existing history.

**Slice exit:** prove fresh packaged configuration/workflow independence, correct root/child/project discovery, settings persistence and recoverable whole-folder updates without changing personal state. Path provisioning and resource discovery must both be complete before claiming independence. Explicit source/custom routes remain supported. Dependency acquisition, complete first-run onboarding, authenticated task acceptance and public release follow separately; implementation/build/activation/publication approval remains outstanding.

### 2. Deliver VS Code Marketplace releases

**Current gap:** the documented entry point requires cloning, an exact Node version and a source build. Packaged runtime delivery exists, but checkout-independent installation is not qualified. The delivered loader uses a Windows/NTFS-specific lock that rejects other operating systems; macOS/Linux support requires real portability work, not just different package labels. Runtime artifacts are bound to OS, architecture and Node ABI; native dependencies need target-specific qualification.

**Required work**

- Prepare platform-specific VSIXs under one listing: these are installable extension packages hosted by the Marketplace, not standalone desktop installers. Provide clear installation, onboarding, licence, support and supported-target information. Reuse existing artifact/generation machinery. Human and agent-assisted setup use the same authoritative instructions and release identities; neither should fall back to building source.
- Retain one versioned candidate VSIX per target, bound to reviewed source, toolchain/runtime identity and a package checksum. Test and upload that exact file without rebuilding after acceptance. Existing `extension:package` rebuilds during packaging, `delivery:qualify` creates/tests a separate temporary package, and `extension:publish` stages local installed generations rather than publishing to the Marketplace; these are useful foundations, not an existing end-to-end public-release route. Automated build/publication workflows can follow a proven manual candidate flow.
- Define and qualify portable equivalents for Windows-specific startup, storage, exclusion and process-lifetime behavior before admitting another platform. Preserve ownership, lease and no-replay guarantees; build and verify native payloads for the actual target.
- Apply the selected AGPLv3 direction with explicit coverage, required notices and compliant Corresponding Source delivery/offers. Verify the actual packaged files; a successful package build is not licence compliance.
- Implement compatible installed-Node reuse and on-demand private Node acquisition for users without a build toolchain, preserving runtime version/ABI verification. On Windows, likewise reuse or privately acquire Git/Bash for command execution and Git operations; acquire the required Playwright browser during setup if absent. Report unsupported platforms/storage, offline acquisition failures and missing prerequisites with an actionable remedy.
- Make first launch provision the user profile and lead an unconfigured user to provider setup instead of stale-path or empty-model troubleshooting. Installation must not rewrite unrelated VS Code preferences or global development configuration.
- Keep the publisher/extension identity stable and assign a higher version for new Marketplace releases; do not overwrite an already published target/version. Use VS Code's installation/update mechanisms and respect user update settings. Pie still owns runtime/worker shutdown, compatibility and safe data migration; Marketplace delivery alone proves none of these. Define deliberate rollback, repair and uninstall behavior; do not interrupt active work to force an update. Configuration/history must outlive application replacement; code rollback is not data rollback, and data removal must be a separate explicit action.
- Qualify the bundled local/LAN browser interface against the same backend/session authority. Browser access to a running host is not a browser-only VS Code extension; desktop platform support does not automatically qualify WSL, Remote SSH or dev-container execution.

**Decide first:** renamed publisher/extension identity; exact OS/architecture/storage baseline and optional-native-feature matrix; per-target build/publication ownership; Node acquisition/offline UX; recovery artifact location and remote-workspace scope. Marketplace distribution and phased platform rollout are selected; no publication is authorised by this plan.

**Later stages, not extension-preview gates:** after the cross-platform VS Code phase, add an Electron desktop host reusing the shared application/UI, then a website for its discovery/distribution. Desktop installation, updates, signing, site/domain provider and supplemental artifact hosting remain open. [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) remains a candidate supplemental download/recovery location, including for the extension phase, not a selected service or launch prerequisite. If selected, mirror the same tested VSIX bytes with version/checksum and matching source/notices rather than rebuilding a separate release. Installing prebuilt packages removes the user's need to clone/build source; it does not remove AGPL Corresponding Source obligations. [Microsoft Artifact Signing currently limits individual Public Trust enrollment to the US/Canada](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart); retain the NZ individual signing question for desktop delivery rather than making it a Marketplace-preview prerequisite. No purchase or signing application is authorised.

**Acceptance, per target:** use the actual VSIX on a clean supported OS/architecture profile/device with no checkout, global Pi, inherited provider credentials or development toolchain. Install, activate, authenticate, complete a task, restart/resume, update and recover to the prior compatible release using disposable data. Verify loaded identity, not just files on disk; exercise the bundled browser surface with its access scope explicit. Reinstallation preserves user data. Publish only targets that pass; standalone distribution is not part of this gate.

### 3. Finish provider-to-request usability

**Current gap:** management preserves unknown pricing, but runtime admission still rejects models without complete rates. Complete applicable tiered pricing already has support; blanket claims that tiered models are unsupported are obsolete. Missing capability/authentication facts and price completeness must not be conflated.

**Required work**

- Carry honestly unpriced models through native request execution, accounting and UI without fabricating rates or zero monetary totals. Preserve partial-rate and tier applicability facts and captured request provenance.
- Give actionable, distinct states for saved connection, listing failure, missing required metadata, unsupported protocol/capability, expired authentication and request rejection. A saved provider or listed model must not promise entitlement.
- Respect milestone 1's fresh-profile and opt-in manual-import boundaries. Make Add/Edit/Refresh/Reconnect/Disable/Remove semantics clear, including effects on existing pinned chats and irreversible secret deletion.
- Qualify the promised provider/auth modes on the shared installed application. Cover cached/offline use, refresh races, cancellation and account/endpoint replacement; keep last-known-good information without retaining invalid access claims.

**Decide first:** initial supported provider/auth matrix and handling of incomplete capability metadata. There is no current monetary-budget feature to redesign; any future budget treatment of unpriced work needs its own decision.

**Acceptance:** a supported model with sufficient request metadata runs without manually supplying prices; usage remains visible and cost is explicitly incomplete. Known zero and known tiered prices remain accurate. VS Code and its bundled browser UI support connection-to-request and recovery flows; selected live checks use explicit consent and bounded traffic. Refresh never changes policy or old accounting. Unsupported combinations explain why rather than silently vanishing.

### 4. Make readiness, delays and recovery understandable

**Current gap:** historical startup/session traces identify expensive verification/import/discovery work, but they are not a current controlled latency baseline or renderer-readiness qualification. Further optimization needs user-visible outcomes, not old timing comparisons.

**Required work**

- Establish a reproducible baseline on the supported release for activation, transcript visible, inventory ready, execution ready and first provider response. Separate cold/warm runs, large/restored sessions and renderer paint; do not add overlapping spans.
- Agree numerical acceptance budgets before performance implementation. Profile the current complete path and retain only changes with meaningful measured improvement.
- Expose pending, failed and recoverable states without presenting acknowledgements as completed work. Authentication, backend loss and interrupted sends need actionable recovery, with no automatic prompt replay or silent model substitution.

**Decide first:** latency budgets and which failures require user intervention. Early transcript publication for public cold open already exists; qualification must measure it rather than propose it again. Additional inventory caching or changes to other readiness paths require explicit semantics/invalidation and contract updates.

**Acceptance:** the selected release meets the agreed budgets on representative fixtures; session switches never show another session's catalog. Delays and failures have understandable states, and recovery preserves drafts, transcript and execution ownership. Test first-send as well as history browsing.

### 5. Qualify and support the preview release

**Current gap:** passing individual component, artifact and private-host checks is not a single fresh-user release journey.

**Required work**

- Run the retained release gates plus clean VSIX install/connect/task/restart/update/rollback acceptance against one identified candidate per OS/architecture target. Retain shared/standalone regression checks without making standalone distribution a preview prerequisite; do not require testing every vendor model.
- Verify the initial provider matrix with mock/native transport tests and explicitly authorized live checks. Record unsupported cases and entitlement limits rather than claiming universal provider compatibility.
- Run bounded cost-versus-quality experiments against other harnesses before making comparative efficiency claims. Separate matched-model/provider comparisons from realistic configured-workflow comparisons, including Pie's model buckets. Use repeated tasks with independent tests/review; report acceptance rate, time and human intervention alongside total cost of all scored attempts divided by accepted solutions. Include failed attempts, retries, subagents, auxiliary calls and cache pricing; distinguish measured charges from API-equivalent estimates and subscription costs, and leave missing usage unknown. Select tasks, configurations, repetitions and an explicit spend/data-transmission budget before running; this plan authorises no paid experiments. Outperforming competitors is not itself an installation-release gate.
- Provide short install/getting-started, update/repair and troubleshooting guidance. Explain local data, usage/cost uncertainty, privacy/retention, backup and explicit deletion. Support diagnostics must identify the build and failed stage without exporting secrets or transcripts by default.
- Define release/update ownership for the Pi fork and integrations: review cadence plus relevant-fix triggers, upstream provenance, local semantic-delta review, focused compatibility gates and a recoverable prior artifact. Preserve licenses/notices.

**Acceptance:** each target candidate has reproducible passing evidence for the supported journeys, no unresolved data-loss/secret-exposure/incorrect-accounting blockers, and accurate known limitations. Invite a small preview group on qualified targets; observe onboarding and core task completion without maintainer intervention. Add other platform packages only after the same acceptance, not simply because the Marketplace supports them.

## Sequencing and completion

Start with **milestone 1's configuration/storage decisions**, then prove **milestones 1–2 as one checkout-independent VS Code installation slice**. Qualify additional OS/architecture packages independently during the VS Code phase; do not bypass current Windows-only runtime/storage gates to claim portability. Provider pricing work can proceed independently once its request/accounting contract is agreed. Establish milestone 4's baseline early; do not turn performance work into another open-ended runtime rewrite. Milestone 5 is the release gate, not a substitute for the preceding engineering work.

A platform preview is ready when a fresh user can install the extension → connect → complete a task → restart/resume → update, with neutral defaults, honest model/cost state and preserved data. Record only concise per-milestone status and candidate evidence here as work completes; keep raw logs, temporary paths and experiment histories out of this plan.

## Deferred and non-goals

- Electron desktop distribution and its website/domain are later stages, not prerequisites for the cross-platform VS Code launch.
- Multi-account providers; public-network or multi-user hosting. Bundled opt-in private-LAN browser access does not expand those boundaries.
- A wholesale Pi upgrade, agent-engine replacement or new general extension framework.
- Native TypeScript coverage replacement; retain the existing release coverage gate.
- Automatic model downloads, background paid inference tests, speculative budget features and broader agent/UI features unrelated to these acceptance gates.
- Analytics backfill, bulk deletion of legacy files, session-format changes or activation of the gated storage cutoff. Any required storage-policy change needs its own approval under the owning contract.

Historical process/reader uncertainties are not erased by rewriting this document. Follow the existing lifetime gates and [maintenance limitations](MAINTENANCE-FOLLOWUPS.md); do not infer that old processes ended or that an installed feature is active from current source alone.
