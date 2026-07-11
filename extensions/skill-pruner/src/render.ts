import type { PruningResult } from "../types.js";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatLatencyNote } from "./message-builders.js";

export const pruningResultRenderer = {
	messageType: "pruning-result" as const,
	render: (message: { content: string; details?: unknown }, { expanded }: { expanded: boolean }, theme: {
		bg: (key: string, child: unknown) => unknown;
		fg: (key: string, text: string) => string;
	}) => {
		const details = message.details as PruningResult | undefined;
		if (!details) {
			const box = new Box(1, 1, (t: unknown) => theme.bg("customMessageBg", t));
			box.addChild(new Text(String(message.content), 0, 0));
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
			const box = new Box(1, 1, (t: unknown) => theme.bg("customMessageBg", t));
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

		const box = new Box(1, 1, (t: unknown) => theme.bg("customMessageBg", t));
		const header = hasError ? "Pruning Results (prepass failed — kept all)" : "Pruning Results";
		box.addChild(new Text(`${modeLabel}${header}\n${lines.join("\n")}`, 0, 0));
		return box;
	},
};
