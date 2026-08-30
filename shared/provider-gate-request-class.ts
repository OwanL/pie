/**
 * Shared contract between the host-side provider gate
 * (`extension/src/backend/provider-gate.ts`) and pi extensions that want queue
 * priority when their provider's concurrency pool is saturated.
 *
 * The canonical consumer is the skill-pruner extension, whose prepass LLM call
 * is on the critical path of the session it is preflighting. If the pruner
 * provider is maxed out (e.g. it is shared with main sessions, or many sessions
 * prune concurrently), the prepass would otherwise sit in the gate's FIFO
 * queue behind main-session requests, stalling the very session it is trying to
 * unblock. Tagging the prepass request with `x-pi-request-class: skill-pruner`
 * makes the gate hand the next freed slot to the pruner ahead of main-session
 * calls — without interrupting any in-flight request.
 *
 * Kept in the root `shared/` package so both the VS Code extension backend and
 * standalone pi extensions (skill-pruner) import the exact same constant
 * without one depending on the other's internal modules.
 */

/** Request class drives queue priority when a provider's concurrency pool is
 *  saturated. The blocking skill-pruner runs ahead of normal turns, while
 *  cosmetic asynchronous session titles yield to both. Unknown values map to
 *  `default`. */
export type ProviderGateRequestClass = 'skill-pruner' | 'default' | 'session-title';

/** Header name carrying the request class. The provider gate reads this from
 *  the outbound request headers. */
export const PROVIDER_GATE_REQUEST_CLASS_HEADER = 'x-pi-request-class';

/** Header value the skill-pruner prepass sets to claim priority. */
export const PROVIDER_GATE_REQUEST_CLASS_SKILL_PRUNER: ProviderGateRequestClass = 'skill-pruner';

/** Header value used by best-effort asynchronous session-title requests. */
export const PROVIDER_GATE_REQUEST_CLASS_SESSION_TITLE: ProviderGateRequestClass = 'session-title';