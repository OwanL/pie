# Repository-Organization Navigation Study — 2026-09-24

## Summary

This report records a completed synthetic navigation and placement experiment
for the repository-organization discussion. Its evidence is qualitative: it can
inform naming and ownership recommendations, but it is not a validated
migration, controlled benchmark, or claim of universal navigation success.
See [`../plans/REPOSITORY_ORGANIZATION_PLAN.md`](../plans/REPOSITORY_ORGANIZATION_PLAN.md)
for the current recommendation and unresolved execution work.

## Method and limits

- 25 independent fresh probes used staged fixtures `a`–`g`. The two pilot
  fixtures each had 49 common files plus seven differently placed files with
  short representative contents. Later fixtures changed paths and modules.
  No source code was executed; semantic and file-import cues were refined later.
- The first 16 probes used the small request bucket; the remaining nine used
  the medium bucket. Fixtures `c` and `e` had different contents, so their
  outcomes are not a controlled folder-placement comparison.
- Participants received the task and an opaque simulator ID, not parent history
  or the target tree. They were instructed not to inspect scripts, data, or the
  real repository and to navigate/list/read/nominate only. Logs record simulator
  navigation, not proof of every off-simulator action.
- Do not aggregate success rates, speed rankings, significance, or universal
  convergence. Request counts are not a fair comparative metric here.

### Candidate progression

| Fixture | Distinction being explored |
|---|---|
| `a` | Combined selector under instructions/skills; result processing under tools; shared assets under hosts/lib. |
| `b` | Combined selector and result processing under model-input-processing; assets under application/lib. |
| `c` | Split skill/tool policies, with one shared selector under harness/lib; assets under hosts/lib. |
| `d` | Same policy split as c; assets under application/lib for the paired asset lookup. |
| `e` | Explicit skill/tool selection directories; clearer separation of policy from shared lifecycle. |
| `f` | Shared selector becomes a named harness-level domain; agent-execution becomes agent-processes; prompt assembly moves under instructions. |
| `g` | Same hierarchy as f, with representative policy imports and clearer configuration-versus-policy descriptions. |

The final two probes tested the import-linked fixture, not a new folder layout.
They were mixed: tool lifecycle discovery succeeded; the skill-policy probe
nominated prematurely and did not verify its candidate. There was no clean
sweep and no evidence that naming alone resolves all policy discovery.

## Protocol exceptions and negative outcomes

- Pilot `r35` exceeded its stated 14-request limit, logging 103 requests. Treat
  it as a protocol failure, not a navigation win or count comparison.
- Concurrent log corruption affected `r42` and `r61`. Their final nominations
  remain visible, but exclude timing and request-count comparisons. The
  simulator lock and enforced 16-request budget were added for subsequent
  refinement; later sanity checks passed.
- `r08` and `r77` misrouted per-turn tool selection to
  `agent-execution/workers/worker-runtime-host.ts`; `r08` exhausted its budget,
  and `r77` could not inspect the nominated file.
- `r38` put skill policy under shared `harness/lib/tool-and-skill-selection`
  rather than an owned selection domain.
- `r19` nominated the selection `settings.ts` for skill policy. `r48` also
  chose `tool-and-skill-selection/settings.ts` for an existing skill-policy
  lookup. `r31` did place skill policy under
  `agent-instructions/skills/selection`, illustrating that skills-policy
  discoverability remains weak rather than uniformly resolved.
- `r14` nominated the wrong, unread lifecycle target before reading it; it is
  not a success. `r83` did find and read the shared lifecycle, then an extra
  post-nomination read was denied. Keep its successful discovery distinct from
  that denied follow-up.

## Qualitative findings

Refined probes `r26` and `r69` found and read the named shared
`tool-and-skill-selection/lifecycle`; `r83` also found and read it. Other
representative probes found the trusted-LAN policy (`r73`), application UI
reducer (`r29`), durable transcript read (`r46`), shared asset manifest
(`r11`, `r66`), and tool-result processing (`r23`, `r54`, `r57`). These outcomes
support explicit domain names, but do not establish that all readers converge.

Both `application/hosts/lib/assets/manifest.ts` (`r66`) and
`application/lib/assets/manifest.ts` (`r11`) were viable asset nominations.
Choosing the hosts-level common owner is lowest-common-owner reasoning because
the consumers are host adapters, not measured superiority. Likewise,
`agent-processes/` is a recommended clearer name than `agent-execution/`, but
no probe tested finding its own process code.

The latest refinements `f` and `g` used the same recommended topology. The
fixture recommendations point to these distinct responsibilities:

- `harness/agent-instructions/{agents,skills,prompts}` for authored instructions,
  with skill-specific selection policy under `skills/selection/` and prompt
  assembly under `prompts/assembly/`.
- `harness/tools/{<tool>,selection,result-processing}` for tool ownership,
  tool-specific policy, and shared tool-result middleware. This deliberately
  broadens today's callable-only tools ownership and requires an intentional
  update to `tools/README.md` if approved.
- `harness/tool-and-skill-selection/` as a named shared lifecycle/state/prepass/
  settings domain, not generic `lib/` or `context/`.
- Explicit agent-process, session-storage, and provider groups, with exact SDK
  internals and some provider substructure still provisional.
- Application backend, frontend, host adapters, host-specific browser
  `{http,access,transport}`, and shared host-adapter `{assets,renderer-delivery}`
  concerns, without combining independently isolated renderer hubs.

## Separate code-feasibility notes

These constraints came from a separate current-source feasibility review, not
from fixture execution or participant claims. Any future selector refactor must
preserve one `before_agent_start` lifecycle and one model call; perform tool
selection before the skill-block rewrite because SDK `setActiveTools` rebuilds
the base prompt and Pie must preserve its `rebasePieToolPrompt` step; retain the
`toolsRemain` safeguard,
`toolPromptRefreshFailed` skill fail-open path, and the existing
`applySkillSelection` / `applyToolSelection` seams. Keep one analytics row and
`recordKeptSkills` inheritance, a single state module (`hiddenSkills`,
`loadedSkills`, `prunedTools`) for esbuild reference semantics, the skill
resolver, and stateless request-capability ports. Pure policies must not import
lifecycle orchestration; the shared coordinator imports policies. Existing test
seams remain, and state/logger reads of relative configuration roots need an
explicit root seam.

History compaction's actual summarizer remains SDK-owned. Keep Pie's lifecycle
adapter and durable transcript overflow helpers with their respective owners;
matching “compaction” names do not establish a shared domain. Asset-manifest
and renderer-delivery helper consolidation, `server.ts` / `worker-runtime-host.ts`
splits, and standalone CLI/composition/shutdown splits remain candidates for
separate seam review, not proven targets.

## Artifact note

The experiment's results, per-probe logs, and minimal research metadata were
read from the supplied OS-temporary artifact directory. They are not copied into
the repository: this report intentionally retains the synthesis and caveats,
not large synthetic fixture trees. The task-owned temporary scripts, fixtures,
and logs were removed after evidence review. The experiment changed no source
files.
