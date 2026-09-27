import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Per-execution ownership boundary for tools that maintain process-backed
 * runtimes. This plain data object crosses jiti module re-evaluations; its
 * AsyncLocalStorage instance is kept on globalThis under a stable Symbol.for
 * key so extensions loaded by a separate jiti graph observe the same owner.
 */
export interface ChildToolRuntimeOwner {
	readonly id: string;
	readonly label: string;
	state: "open" | "closing" | "closed";
	readonly cleanups: Map<string, () => Promise<void> | void>;
	cleanupPromise?: Promise<void>;
}

interface OwnerGlobals {
	storage: AsyncLocalStorage<ChildToolRuntimeOwner>;
}

const OWNER_GLOBAL_KEY = Symbol.for("pie.child-tool-runtime-owner.lifecycle.v1");

function ownerGlobals(): OwnerGlobals {
	const holder = globalThis as Record<PropertyKey, unknown>;
	const existing = holder[OWNER_GLOBAL_KEY] as OwnerGlobals | undefined;
	if (existing) return existing;
	const value: OwnerGlobals = { storage: new AsyncLocalStorage<ChildToolRuntimeOwner>() };
	Object.defineProperty(holder, OWNER_GLOBAL_KEY, {
		value,
		writable: false,
		configurable: false,
		enumerable: false,
	});
	return value;
}

export function createChildToolRuntimeOwner(label = "Pie child agent"): ChildToolRuntimeOwner {
	// eslint-disable-next-line no-control-regex -- Strip ASCII control characters from supplied owner labels.
	const shortLabel = label.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
	return {
		id: `child-${randomUUID()}`,
		label: shortLabel || "Pie child agent",
		state: "open",
		cleanups: new Map(),
	};
}

export function runWithChildToolRuntimeOwner<T>(owner: ChildToolRuntimeOwner, callback: () => T): T {
	return ownerGlobals().storage.run(owner, callback);
}

export function currentChildToolRuntimeOwner(): ChildToolRuntimeOwner | undefined {
	return ownerGlobals().storage.getStore();
}

export function assertChildToolRuntimeOwnerOpen(owner: ChildToolRuntimeOwner): void {
	if (owner.state !== "open") {
		throw Object.assign(
			new Error("This child execution is closing; its private tool runtime cannot be used or recreated."),
			{ code: "CHILD_RUNTIME_CLOSING" },
		);
	}
}

export function registerChildToolRuntimeCleanup(
	owner: ChildToolRuntimeOwner,
	key: string,
	cleanup: () => Promise<void> | void,
): void {
	assertChildToolRuntimeOwnerOpen(owner);
	if (!owner.cleanups.has(key)) owner.cleanups.set(key, cleanup);
}

/** Synchronously fence admissions; cleanup itself is explicitly awaited. */
export function markChildToolRuntimeOwnerClosing(owner: ChildToolRuntimeOwner): void {
	if (owner.state === "open") owner.state = "closing";
}

/**
 * Close every runtime acquired by this attempt once. Artifacts are deliberately
 * outside this owner cleanup and remain available after the child returns.
 */
export function cleanupChildToolRuntimeOwner(owner: ChildToolRuntimeOwner): Promise<void> {
	if (owner.cleanupPromise) return owner.cleanupPromise;
	markChildToolRuntimeOwnerClosing(owner);
	const cleanups = [...owner.cleanups.entries()];
	const cleanupPromise = Promise.resolve().then(async () => {
		const results = await Promise.allSettled(cleanups.map(async ([, cleanup]) => await cleanup()));
		const errors: unknown[] = [];
		for (let index = 0; index < results.length; index++) {
			const [key, cleanup] = cleanups[index]!;
			const result = results[index]!;
			if (result.status === "fulfilled") {
				if (owner.cleanups.get(key) === cleanup) owner.cleanups.delete(key);
			} else {
				errors.push(result.reason);
			}
		}
		if (owner.cleanups.size === 0) owner.state = "closed";
		if (errors.length > 0) {
			const details = errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ");
			throw new AggregateError(errors, `One or more child tool runtimes failed to close: ${details}`);
		}
	});
	owner.cleanupPromise = cleanupPromise;
	void cleanupPromise.then(
		() => { if (owner.cleanupPromise === cleanupPromise) owner.cleanupPromise = undefined; },
		() => { if (owner.cleanupPromise === cleanupPromise) owner.cleanupPromise = undefined; },
	);
	return cleanupPromise;
}
