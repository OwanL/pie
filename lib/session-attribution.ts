/** Minimal root-session attribution shared by in-process Pi extensions. */

export interface RootAttributedSessionManager {
	getSessionId?: () => string;
	getRootSessionId?: () => string;
}

/**
 * Attach the owning chat identity to an in-memory child SessionManager without
 * replacing its real session ID. Pi passes this same manager through to the
 * extension context, where auxiliary JSONL producers can attribute rows to the
 * root session for private-close scrubbing.
 */
export function attachRootSessionId(sessionManager: object, rootSessionId: string | undefined): void {
	if (typeof rootSessionId !== "string" || rootSessionId.length === 0) return;
	Object.defineProperty(sessionManager, "getRootSessionId", {
		configurable: true,
		enumerable: false,
		value: () => rootSessionId,
		writable: false,
	});
}

/** Resolve the tree root for a logger, falling back to the current session. */
export function getRootSessionId(context: unknown): string | undefined {
	const ctx = context as { sessionManager?: RootAttributedSessionManager } | null | undefined;
	const manager = ctx?.sessionManager;
	const attributedRoot = manager?.getRootSessionId?.();
	if (typeof attributedRoot === "string" && attributedRoot.length > 0) return attributedRoot;
	const sessionId = manager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/** Keep ordinary single-session records byte-compatible; add attribution only
 * when a child session is distinct from its owning chat session. */
export function rootSessionAttribution(context: unknown, sessionId: string): { rootSessionId?: string } {
	const rootSessionId = getRootSessionId(context);
	return rootSessionId && rootSessionId !== sessionId ? { rootSessionId } : {};
}
