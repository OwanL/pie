# Concurrency configuration

Two independent controls limit different work. A value in source code is not
necessarily the value the running application enforces.

| Control | Unit and scope | Default owner | Runtime authority |
| --- | --- | --- | --- |
| Max active subagent trees | Root child lifetimes, per worker process; nested descendants borrow their root permit | [`lib/concurrency-config.ts`](../../lib/concurrency-config.ts) | [`concurrency-limit.ts`](../../harness/tools/subagent/concurrency-limit.ts) |
| Provider max concurrent | In-flight model requests to one provider, across workers of one coordinator | [`models.yaml`](../../models.yaml), generated into `models.json` | Coordinator provider lease authority |

Provider **Unlimited** (`0`) removes only that provider's capacity/afterburn
throttle. It does not remove the subagent tree cap, tree-session budget, network
deadlines, or circuits. Multiple worker processes can each have their own active
trees; the tree preference is not an application-wide permit pool.

## Resolution and persistence

### Subagent trees

The application resolves the saved chat preference before calling
`runtimePrefs.set`. A valid saved number wins over the shared default. The
preference carries `subagentMaxInflightSource` so materializing a default during
an unrelated settings write does not turn it into an explicit user choice.
Default-sourced records follow the current shared default; explicit saved values
remain unchanged, including a value equal to an older default.

Legacy persisted numbers have no provenance. They are conservatively treated as
saved preferences, never silently migrated. An old stored `2` therefore remains
`2`; use Settings → Subagents → Max active trees to change it intentionally.

The runtime mirrors the resolved value and provenance to
`PIE_SUBAGENT_MAX_INFLIGHT` and `PIE_SUBAGENT_MAX_INFLIGHT_SOURCE`. Application
preferences replace inherited environment values. Outside that application path,
a valid environment value is an environment override; an absent value uses the
shared default and an invalid value uses the safety fallback. The environment
interface retains its existing positive-number semantics; application preferences
use the shared UI/RPC bounds.

### Provider requests

Each explicitly saved `providerConcurrency` field overrides its catalog value.
For the max-request limit, the shared resolver reports `saved-preference`,
`configured-default`, or `safety-fallback`; zero is a valid saved Unlimited value.
The fallback is defensive policy, not a second catalog default.

Every update resolves from the original catalog snapshot, not the previously
merged result. Removing an override restores the current catalog policy.
Already-resolved worker policy snapshots preserve their source rather than being
reinterpreted as user overrides. Other fields keep their existing semantics:
afterburn zero disables the hold, queue-wait zero selects the safety maximum,
and header-wait zero restores the provider/default header bound.

## Inspecting what is applied

- **Provider settings:** the requested override is separate from the runtime max
  and source. The status strip also reads the runtime max, not `models.yaml`.
  Without runtime evidence the UI reports unavailable rather than inventing a
  default. No saved override means the control follows the reported runtime
  value, not a separately inferred catalog value.
- **Subagent settings:** show the host preference, runtime configured value, and
  worker acknowledgement status separately. An applied value is reported only
  when at least one usable worker exists and current worker generations have
  acknowledged the latest runtime-preference revision. No workers or pending
  acknowledgements are explicit, not presented as successful application.
- These are last-observed runtime snapshots. A preference write, backend startup,
  or publication of a new build does not itself prove that workers applied it.
  An old host can report unavailable source/status until its next normal restart.

## Change and test ownership

- Shared defaults/bounds/vocabulary: `lib/concurrency-config.ts`.
- Preference resolution, patches, payload: `application/lib/protocol/settings.ts`.
- Provider max resolver: `harness/model-providers/concurrency/provider-concurrency.ts`.
- Worker acknowledgement evidence: coordinator `worker-runtime-router.ts`.
- Diagnostics transport: `provider_gate.metrics` and `ProviderGateStats`.
- Cross-layer regression: `test/integration/backend-runtime-prefs.test.ts`;
  snapshot preservation: `test/integration/sync-contract.test.ts`.
- Worker apply/ack tests: coordinator and worker `*-phase6.test.ts` suites.

When changing a default, test no saved value, a saved value different from the
new default, an explicit value equal to the default, live updates, and missing
runtime evidence. Never infer live capacity from the catalog alone or reset saved
preferences to make them match a new default.
