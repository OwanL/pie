/**
 * Copilot-specific header injection for the pruning LLM call.
 *
 * GitHub Copilot requires a set of IDE-mimicking headers on every API
 * request. This module is the single source of truth for those headers
 * and the helpers that patch them onto raw model/options shapes.
 *
 * Exported for direct testing and re-exported via the package index.
 */

export const COPILOT_PROVIDER_ID = "github-copilot";

/**
 * Required GitHub Copilot IDE-auth headers.
 */
export const COPILOT_IDE_HEADERS: Record<string, string> = {
	"User-Agent": "GitHubCopilotChat/0.35.0",
	"Editor-Version": "vscode/1.107.0",
	"Editor-Plugin-Version": "copilot-chat/0.35.0",
	"Copilot-Integration-Id": "vscode-chat",
};

function isCopilotModel(model: unknown): boolean {
	return Boolean(model) && typeof model === "object"
		&& (model as Record<string, unknown>).provider === COPILOT_PROVIDER_ID;
}

/**
 * Return a new model object with Copilot IDE headers merged in, or the
 * input unchanged if the model is not a Copilot model or already has all
 * the headers.
 */
export function ensureCopilotHeaders(model: Record<string, unknown>): Record<string, unknown> {
	if (!isCopilotModel(model)) return model;
	const existing = (model.headers ?? {}) as Record<string, string>;
	let patched = false;
	const merged = { ...existing };
	for (const [key, value] of Object.entries(COPILOT_IDE_HEADERS)) {
		if (!merged[key]) {
			merged[key] = value;
			patched = true;
		}
	}
	if (!patched) return model;
	return { ...model, headers: merged };
}

/**
 * Merge Copilot IDE headers into an existing headers record, leaving
 * pre-existing values untouched. Returns the input unchanged when the
 * model is not a Copilot model.
 */
export function withCopilotHeaders(headers: Record<string, string> | undefined, isCopilot: boolean): Record<string, string> | undefined {
	if (!isCopilot) return headers;
	const merged: Record<string, string> = { ...headers };
	for (const [key, value] of Object.entries(COPILOT_IDE_HEADERS)) {
		if (!merged[key]) merged[key] = value;
	}
	return merged;
}

/**
 * Patch a `completeSimple` options object so it carries Copilot IDE
 * headers. Returns the input unchanged for non-Copilot models or when
 * no new keys would be added.
 */
export function withCopilotOptions(
	options: Record<string, unknown>,
	model: Record<string, unknown>,
): Record<string, unknown> {
	if (!isCopilotModel(model)) return options;
	const existing = { ...(options.headers ?? {}) } as Record<string, string>;
	let changed = false;
	for (const [key, value] of Object.entries(COPILOT_IDE_HEADERS)) {
		if (!existing[key]) {
			existing[key] = value;
			changed = true;
		}
	}
	if (!changed) return options;
	return { ...options, headers: existing };
}
