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
- Separate shipped integration code, schemas and safe defaults from personal preferences, secrets and rebuildable caches. Personal configuration must not reach the Git remote or enter immutable runtime generations.
- Normal VS Code and standalone share personal provider configuration. Development/test profiles remain private and cannot fall through to installed settings, credentials or history.
- Provider configuration is UI-first with optional schema-validated YAML at `%LOCALAPPDATA%/pie/config/providers.yaml`; discovery caches live beneath `<resolved data root>/cache/provider-models/`. Secrets remain separate from YAML, chat and ordinary view snapshots.
- Initially support one configured account/endpoint per provider. Preserve `(provider, model ID)` attribution; do not add speculative multi-account machinery.

### First-run setup

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
- Specify a reversible migration for existing settings, provider/legacy credential references and session locations. Show conflicts; preserve customized files and history. Do not silently import the maintainer's setup or merge credentials.
- Decide session-location provisioning separately from the existing storage cutoff, including whether a location-only change is needed. Preserve current closure/retention behavior unless its change is explicitly approved.

**Decide first:** configuration precedence and instruction-pack boundary; migration/conflict UX; session-location approach and relationship to the gated cutoff.

**Acceptance:** a private empty profile starts with neutral defaults; connecting one supported provider is enough for the core task flow. Settings survive restart and replacement of application files. VS Code resolves the intended personal configuration; preserve shared configuration authority and existing standalone regressions for the later desktop host. Existing-user migration is tested on disposable fixtures, can be reversed, and neither loses history nor changes retention implicitly. Source and release payload stay unchanged.

### 2. Deliver VS Code Marketplace releases

**Current gap:** the documented entry point requires cloning, an exact Node version and a source build. Packaged runtime delivery exists, but checkout-independent installation is not qualified. The delivered loader uses a Windows/NTFS-specific lock that rejects other operating systems; macOS/Linux support requires real portability work, not just different package labels. Runtime artifacts are bound to OS, architecture and Node ABI; native dependencies need target-specific qualification.

**Required work**

- Prepare platform-specific VSIXs under one listing, with clear installation, onboarding, licence, support and supported-target information. Reuse existing artifact/generation machinery. Human and agent-assisted setup use the same authoritative instructions and release identities; neither should fall back to building source.
- Define and qualify portable equivalents for Windows-specific startup, storage, exclusion and process-lifetime behavior before admitting another platform. Preserve ownership, lease and no-replay guarantees; build and verify native payloads for the actual target.
- Apply the selected AGPLv3 direction with explicit coverage, required notices and compliant Corresponding Source delivery/offers. Verify the actual packaged files; a successful package build is not licence compliance.
- Implement compatible installed-Node reuse and on-demand private Node acquisition for users without a build toolchain, preserving runtime version/ABI verification. Report unsupported platforms/storage and missing prerequisites with an actionable remedy.
- Make first launch provision the user profile and lead an unconfigured user to provider setup instead of stale-path or empty-model troubleshooting. Installation must not rewrite unrelated VS Code preferences or global development configuration.
- Use VS Code's installation/update mechanisms and respect user update settings. Define deliberate rollback, repair and uninstall behavior; do not interrupt active work to force an update. Configuration/history must outlive application replacement; data removal must be a separate explicit action.
- Qualify the bundled local/LAN browser interface against the same backend/session authority. Browser access to a running host is not a browser-only VS Code extension; desktop platform support does not automatically qualify WSL, Remote SSH or dev-container execution.

**Decide first:** renamed publisher/extension identity; exact OS/architecture/storage baseline and optional-native-feature matrix; per-target build/publication ownership; Node acquisition/offline UX; recovery artifact location and remote-workspace scope. Marketplace distribution and phased platform rollout are selected; no publication is authorised by this plan.

**Later stages, not extension-preview gates:** after the cross-platform VS Code phase, add an Electron desktop host reusing the shared application/UI, then a website for its discovery/distribution. Desktop installation, updates, signing, site/domain provider and supplemental artifact hosting remain open. [GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases) remains an artifact-hosting candidate, not a selected service. [Microsoft Artifact Signing currently limits individual Public Trust enrollment to the US/Canada](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart); retain the NZ individual signing question for desktop delivery rather than making it a Marketplace-preview prerequisite. No purchase or signing application is authorised.

**Acceptance, per target:** use the actual VSIX on a clean supported OS/architecture profile/device with no checkout, global Pi, inherited provider credentials or development toolchain. Install, activate, authenticate, complete a task, restart/resume, update and recover to the prior compatible release using disposable data. Verify loaded identity, not just files on disk; exercise the bundled browser surface with its access scope explicit. Reinstallation preserves user data. Publish only targets that pass; standalone distribution is not part of this gate.

### 3. Finish provider-to-request usability

**Current gap:** management preserves unknown pricing, but runtime admission still rejects models without complete rates. Complete applicable tiered pricing already has support; blanket claims that tiered models are unsupported are obsolete. Missing capability/authentication facts and price completeness must not be conflated.

**Required work**

- Carry honestly unpriced models through native request execution, accounting and UI without fabricating rates or zero monetary totals. Preserve partial-rate and tier applicability facts and captured request provenance.
- Give actionable, distinct states for saved connection, listing failure, missing required metadata, unsupported protocol/capability, expired authentication and request rejection. A saved provider or listed model must not promise entitlement.
- Complete the configuration/credential transition selected in milestone 1. Make Add/Edit/Refresh/Reconnect/Disable/Remove semantics clear, including effects on existing pinned chats and irreversible secret deletion.
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
