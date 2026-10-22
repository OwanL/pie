import { AsyncLocalStorage } from "node:async_hooks";
import type { Release } from "./concurrency-limit.js";
import type { SubagentChildIdentity } from "./types.js";
import type { SubagentAnalyticsCaptureContext } from "./analytics-capture.js";

/** Mutable counter shared across an entire nested subagent tree. A fresh one
 * is created at the outermost call and threaded down to every child. */
export interface TreeBudget {
	sessions: number;
}

export interface ProcessPermitScope {
	/** The root child owns this release handle. Descendants borrow the scope and
	 * never acquire another process permit, avoiding parent/child deadlock. */
	release: Release;
}

/** Async-local ancestry, tree budget, policy and attribution for nested calls. */
export interface SubagentRuntimeContext {
	depth: number;
	trail: string[];
	/** Effective bucket serving the current subagent session. Undefined for the
	 * root chat, which is never restricted by per-bucket delegation policy. */
	bucket?: string;
	/** Current session agent's spawning allowlist. Undefined means unrestricted
	 * at the root and for agents without a canSpawn frontmatter field. */
	canSpawn?: string[];
	budget?: TreeBudget;
	/** Main chat session whose per-session provider policy applies to this tree. */
	rootSessionPath?: string;
	/** Main chat's identity for privacy attribution of all descendant sessions. */
	rootSessionId?: string;
	/** Effective subagent-only provider policy snapshotted by the root call. Child
	 * sessions have in-memory session managers, so they must inherit this policy
	 * rather than trying to resolve a per-chat override from their own path. */
	subagentProviderToggles?: Record<string, boolean>;
	subagentBucketChoices?: Readonly<import("../../../lib/subagent-bucket-policy.js").SubagentBucketChoices>;
	/** One process-wide permit held for the complete root-tree lifetime. */
	processPermitScope?: ProcessPermitScope;
	/** Immutable producer lineage of the currently executing ancestor attempt. */
	lineage?: SubagentChildIdentity[];
	/** Optional Pie-owned rich-detail transport. Absent outside the disabled-by-
	 * default analytics prototype and inherited unchanged by nested attempts. */
	analyticsCapture?: SubagentAnalyticsCaptureContext;
}

// Pi loads every AgentSession's extensions through a fresh jiti instance with
// `moduleCache: false`. A module-local AsyncLocalStorage therefore splits the
// parent and nested copies of this extension: descendants lose depth, budget,
// root-session provider overrides, and the process-permit scope. Keep the async
// context on globalThis so independently loaded copies share one tree context.
// This remains concurrency-safe because AsyncLocalStorage scopes values to the
// active async call chain; only the storage container is process-global.
const SUBAGENT_RUNTIME_KEY = Symbol.for("pie.subagent-runtime-context.v1");

function subagentRuntimeHost(): Record<PropertyKey, unknown> {
	return globalThis as unknown as Record<PropertyKey, unknown>;
}

function sharedSubagentRuntime(): AsyncLocalStorage<SubagentRuntimeContext> {
	const existing = subagentRuntimeHost()[SUBAGENT_RUNTIME_KEY];
	if (existing instanceof AsyncLocalStorage) {
		return existing as AsyncLocalStorage<SubagentRuntimeContext>;
	}
	const created = new AsyncLocalStorage<SubagentRuntimeContext>();
	subagentRuntimeHost()[SUBAGENT_RUNTIME_KEY] = created;
	return created;
}

export const subagentRuntime = sharedSubagentRuntime();

/** Read current runtime context, falling back to legacy env vars for outermost call. */
export function readRuntimeContext(): SubagentRuntimeContext {
	const store = subagentRuntime.getStore();
	if (store) return store;
	const depth = parseInt(process.env.PI_SUBAGENT_DEPTH ?? "0", 10);
	const trail = (process.env.PI_SUBAGENT_TRAIL ?? "").split(",").filter(Boolean);
	return { depth, trail };
}
