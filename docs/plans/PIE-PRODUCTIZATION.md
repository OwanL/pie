# Pie productization

**Updated 2026-10-26.** Current scope, decisions and acceptance gates for making Pie usable without its maintainer's checkout or assistance. This replaces the migration diary; historical measurements and receipts remain in Git history, not a second plan.

## Goal and release boundary

A new Windows user can install a release, connect a provider, complete a useful coding task, restart and resume, and update without losing configuration or history. Neither normal setup nor model management requires editing source files, running generators or installing the development toolchain.

The first release remains Windows-first, for a single-user desktop with one active Pie host per machine. VS Code and standalone share application, provider and data authorities; their installation and launch instructions must each be explicit. Preserve current platform/storage restrictions until separately qualified.

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

### Product and configuration ownership

- Ship a **curated Pie workflow**: intentionally reviewed general-purpose tools, agents, skills and instructions, not a minimal Pi baseline or a wholesale copy of the maintainer's setup. Most existing working instructions are candidates for product defaults; an instruction is not personal merely because it is opinionated. User-specific changes, integration configuration, machine paths and account/model selections remain separate; the exact shipped inventory still requires review.
- Separate shipped integration code, schemas and safe defaults from personal preferences, secrets and rebuildable caches. Personal configuration must not reach the Git remote or enter immutable runtime generations.
- Normal VS Code and standalone share personal provider configuration. Development/test profiles remain private and cannot fall through to installed settings, credentials or history.
- Provider configuration is UI-first with optional schema-validated YAML at `%LOCALAPPDATA%/pie/config/providers.yaml`; discovery caches live beneath `<resolved data root>/cache/provider-models/`. Secrets remain separate from YAML, chat and ordinary view snapshots.
- Initially support one configured account/endpoint per provider. Preserve `(provider, model ID)` attribution; do not add speculative multi-account machinery.
- First-run setup guides users through connecting providers and choosing models, then assigning models to title generation, subagents, history compaction and other model-powered features. Explain each job and its extra usage, and prompt the user to assign a model; do not recommend particular models, maintain recommendation lists or automatically rank models for these assignments. The user chooses from their configured models. Separate model assignments are optional: title generation and tool/skill selection use the main session model when no separate model is assigned, rather than remaining off.
- Assign an initial main session model automatically from the user's enabled, configured models; do not require a separate main-model selection step during setup. Users can change it through the normal model picker. Preserve existing users' saved selections.

### Provider and request behavior

- Reuse Pi authentication and the current session engine. An upstream upgrade or agent-engine rewrite is not a prerequisite.
- Discover models where supported; retain manual IDs otherwise. Serve cached state immediately and refresh enabled, configured providers asynchronously with bounded work. Listing, configured authentication and successful inference are distinct facts.
- Metadata precedence is **shipped < discovery < explicit user overrides**. Preserve visibility, selections and routing preferences. Discovery never silently changes defaults or enrolls models in automatic routing/subagent pools.
- Never automatically sign in, send paid inference probes, enable account model policies or download models. Explicit connection tests must explain network/billing effects.
- Genuinely new chats capture saved provider setup; copies inherit their source capture, and reopening/replacing a worker retains it. This supersedes the earlier next-user-turn refresh proposal. Do not hot-swap registries or change pinned work. Authentication/revocation remains separately checked: a metadata pin does not guarantee continued access.
- Preserve the human's selected model when it disappears from a listing; listing absence alone is not proof it cannot serve requests. Warn and use valid last-known request settings where authorization and metadata permit. Do not silently replace models or clamp the saved thinking preference; unsupported effective modes require a choice before dispatch.
- Unknown pricing is usable target behavior, not zero/free. Keep token usage and historical attribution, identify partially unpriced totals, and exclude unknown rates from cheapest-model ranking. Do not reprice past requests after refresh.

### Windows installation

- Reuse a compatible installed Node runtime. When none is available, download a release-compatible Node runtime into Pie-managed user-local storage. Node binaries do not belong in Git; acquisition must not replace the user's Node installation or alter global PATH. Both hosts need a startup route that can acquire Node without requiring Node to run that route.

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

**Acceptance:** a private empty profile starts with neutral defaults; connecting one supported provider is enough for the core task flow. Settings survive restart and replacement of application files. Both hosts resolve the same intended personal configuration. Existing-user migration is tested on disposable fixtures, can be reversed, and neither loses history nor changes retention implicitly. Source and release payload stay unchanged.

### 2. Deliver an end-user Windows installation

**Current gap:** the documented entry point requires cloning, an exact Node version and a source build. Packaged runtime delivery exists, but the complete checkout-independent user installation is not qualified.

**Required work**

- Select and document the user-facing release/install route for VS Code and standalone, reusing existing artifact and generation machinery rather than another build pipeline.
- Implement compatible installed-Node reuse and on-demand private Node acquisition for users without a build toolchain, preserving runtime version/ABI verification. Report unsupported platforms/storage and missing prerequisites with an actionable remedy.
- Make first launch provision the user profile and lead an unconfigured user to provider setup instead of stale-path or empty-model troubleshooting. Installation must not rewrite unrelated VS Code preferences or global development configuration.
- Define update, deliberate rollback, repair and uninstall behavior. User configuration/history must outlive application replacement; data removal must be a separate explicit action.

**Decide first:** release channel/artifact, Node acquisition/offline UX, supported Windows/storage baseline, and standalone distribution form. Do not add macOS/Linux packaging to this milestone.

**Acceptance:** use the actual release on a clean Windows profile/device with no checkout, global Pi, inherited provider credentials or development toolchain. Install, launch each supported host, authenticate, complete a task, restart/resume, update and recover to the prior compatible release using disposable data. Verify loaded identity, not just files on disk. Reinstallation preserves user data.

### 3. Finish provider-to-request usability

**Current gap:** management preserves unknown pricing, but runtime admission still rejects models without complete rates. Complete applicable tiered pricing already has support; blanket claims that tiered models are unsupported are obsolete. Missing capability/authentication facts and price completeness must not be conflated.

**Required work**

- Carry honestly unpriced models through native request execution, accounting and UI without fabricating rates or zero monetary totals. Preserve partial-rate and tier applicability facts and captured request provenance.
- Give actionable, distinct states for saved connection, listing failure, missing required metadata, unsupported protocol/capability, expired authentication and request rejection. A saved provider or listed model must not promise entitlement.
- Complete the configuration/credential transition selected in milestone 1. Make Add/Edit/Refresh/Reconnect/Disable/Remove semantics clear, including effects on existing pinned chats and irreversible secret deletion.
- Qualify the promised provider/auth modes on the shared installed application. Cover cached/offline use, refresh races, cancellation and account/endpoint replacement; keep last-known-good information without retaining invalid access claims.

**Decide first:** initial supported provider/auth matrix and handling of incomplete capability metadata. There is no current monetary-budget feature to redesign; any future budget treatment of unpriced work needs its own decision.

**Acceptance:** a supported model with sufficient request metadata runs without manually supplying prices; usage remains visible and cost is explicitly incomplete. Known zero and known tiered prices remain accurate. Both hosts support connection-to-request and recovery flows; selected live checks use explicit consent and bounded traffic. Refresh never changes policy or old accounting. Unsupported combinations explain why rather than silently vanishing.

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

- Run the retained release gates plus clean install/connect/task/restart/update/rollback acceptance against one identified candidate. Keep both host adapters in the supported matrix; do not require testing every vendor model.
- Verify the initial provider matrix with mock/native transport tests and explicitly authorized live checks. Record unsupported cases and entitlement limits rather than claiming universal provider compatibility.
- Provide short install/getting-started, update/repair and troubleshooting guidance. Explain local data, usage/cost uncertainty, privacy/retention, backup and explicit deletion. Support diagnostics must identify the build and failed stage without exporting secrets or transcripts by default.
- Define release/update ownership for the Pi fork and integrations: review cadence plus relevant-fix triggers, upstream provenance, local semantic-delta review, focused compatibility gates and a recoverable prior artifact. Preserve licenses/notices.

**Acceptance:** one candidate has reproducible passing evidence for the supported journeys, no unresolved data-loss/secret-exposure/incorrect-accounting blockers, and accurate known limitations. Only then invite a small Windows preview group; observe onboarding and core task completion without maintainer intervention.

## Sequencing and completion

Start with **milestone 1's configuration/storage decisions**, then prove **milestones 1–2 as one checkout-independent installation slice**. Provider pricing work can proceed independently once its request/accounting contract is agreed. Establish milestone 4's baseline early; do not turn performance work into another open-ended runtime rewrite. Milestone 5 is the release gate, not a substitute for the preceding engineering work.

The preview is ready when a fresh user can install → connect → complete a task → restart/resume → update, with neutral defaults, honest model/cost state and preserved data. Record only concise per-milestone status and candidate evidence here as work completes; keep raw logs, temporary paths and experiment histories out of this plan.

## Deferred and non-goals

- macOS/Linux delivery; multi-account providers; public-network or multi-user hosting.
- A wholesale Pi upgrade, agent-engine replacement or new general extension framework.
- Native TypeScript coverage replacement; retain the existing release coverage gate.
- Automatic model downloads, background paid inference tests, speculative budget features and broader agent/UI features unrelated to these acceptance gates.
- Analytics backfill, bulk deletion of legacy files, session-format changes or activation of the gated storage cutoff. Any required storage-policy change needs its own approval under the owning contract.

Historical process/reader uncertainties are not erased by rewriting this document. Follow the existing lifetime gates and [maintenance limitations](MAINTENANCE-FOLLOWUPS.md); do not infer that old processes ended or that an installed feature is active from current source alone.
