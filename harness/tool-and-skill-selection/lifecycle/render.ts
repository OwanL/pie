import type { MessageRenderOptions, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import type { PruningResult } from "../settings/config-types.js";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatLatencyNote } from "../prepass/message-builders.js";

/** The message shape Pi passes to this customType's registered renderer. */
type PruningFeedbackMessageShape = Parameters<MessageRenderer<PruningResult>>[0];

/** Render the permitted message-content union (string or content blocks).
 *  Pruning feedback always sends a string; content blocks are flattened to
 *  their text (image blocks are acknowledged rather than silently dropped). */
function messageText(message: PruningFeedbackMessageShape): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => (part.type === "text" ? part.text : `[image: ${part.mimeType}]`))
		.join("");
}

export const pruningResultRenderer = {
	messageType: "pruning-result" as const,
	render: (message: PruningFeedbackMessageShape, { expanded }: MessageRenderOptions, theme: Theme) => {
		const details = message.details;
		if (!details) {
			const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
			box.addChild(new Text(messageText(message), 0, 0));
			return box;
		}

		const mode = details.mode === "shadow" ? "shadow" : details.mode;
		const modeLabel = theme.fg("dim", mode === "shadow" ? "[shadow] " : "");
		const skillSummary = details.excludedSkills.length > 0
			? `Kept ${details.includedSkills.length}/${details.includedSkills.length + details.excludedSkills.length} skills`
			: "All skills included";
		const toolSummary = details.excludedTools.length > 0
			? `Kept ${details.includedTools.length}/${details.includedTools.length + details.excludedTools.length} tools`
			: "";
		const parts = [skillSummary, toolSummary].filter(Boolean);
		const tokensSaved = details.skillTokensSaved + details.toolTokensSaved;
		const tokenNote = tokensSaved > 0 ? ` · Saved ~${tokensSaved} tokens` : "";
		const latencyNote = formatLatencyNote(details.prepassLatencyMs);
		const cacheNote = details.cacheHit ? " · cached" : "";
		const hasError = !!details.prepassError;
		const errorNote = hasError ? ` · ${details.prepassError}` : "";

		if (!expanded) {
			const compact = hasError
				? `${modeLabel}${theme.fg("error", "Pruning error")}${errorNote}`
				: `${modeLabel}${parts.join(", ")}${tokenNote}${latencyNote}${cacheNote}`;
			const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
			box.addChild(new Text(compact, 0, 0));
			return box;
		}

		const lines: string[] = [];
		if (hasError) {
			// Surface the full verbatim error so it is debuggable, not swallowed.
			lines.push(theme.fg("error", `  Prepass error: ${details.prepassError}`));
			if (details.prepassModel) lines.push(theme.fg("dim", `  Model: ${details.prepassModel} (${details.prepassThinkingLevel ?? "n/a"})`));
			if (details.prepassLatencyMs) lines.push(theme.fg("dim", `  Latency: ${details.prepassLatencyMs}ms`));
		}
		if (details.excludedSkills.length > 0) {
			const skillsKept = details.includedSkills.length > 0 ? details.includedSkills.join(", ") : "None";
			lines.push(theme.fg("success", `  Skills kept: ${skillsKept}`));
			lines.push(theme.fg("dim", `  Skills pruned: ${details.excludedSkills.join(", ")}`));
		}
		if (details.excludedTools.length > 0) {
			const toolsKept = details.includedTools.length > 0 ? details.includedTools.join(", ") : "None";
			lines.push(theme.fg("success", `  Tools kept: ${toolsKept}`));
			lines.push(theme.fg("dim", `  Tools pruned: ${details.excludedTools.join(", ")}`));
		}
		if (tokenNote) {
			lines.push(theme.fg("accent", `  ${tokenNote.trim()}`));
		}
		if (latencyNote) {
			lines.push(theme.fg("dim", `  Prepass latency: ${details.prepassLatencyMs}ms`));
		}
		if (details.cacheHit) lines.push(theme.fg("dim", "  Prepass: cached"));

		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		const header = hasError ? "Pruning Results (prepass failed — kept all)" : "Pruning Results";
		box.addChild(new Text(`${modeLabel}${header}\n${lines.join("\n")}`, 0, 0));
		return box;
	},
};
