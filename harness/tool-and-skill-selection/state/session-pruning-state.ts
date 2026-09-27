import { clearSessionPruningTracking } from "../lifecycle/logger.js";
import { clearSessionPrepassCache } from "./prepass-cache.js";
import { clearSessionSelectorState } from "./selector-state.js";

/** Release all pruning state keyed to a session when its child execution ends. */
export function clearSessionPruningState(sessionId: string): void {
	clearSessionSelectorState(sessionId);
	clearSessionPrepassCache(sessionId);
	clearSessionPruningTracking(sessionId);
}
