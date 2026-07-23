import type { ThinkingLevel } from "./bucket-config.js";

/** Thinking levels subagents may request, ordered from lightest to heaviest. */
export const SUBAGENT_THINKING_LEVELS = ["minimal", "low", "medium", "high"] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

/** Subagents intentionally stop at high; xhigh/max spend is reserved for parent agents. */
export const MAX_SUBAGENT_THINKING_LEVEL: SubagentThinkingLevel = "high";

/** Apply the subagent reasoning ceiling and provide its high default. */
export function capSubagentThinkingLevel(
	level: ThinkingLevel | "max" | undefined,
): SubagentThinkingLevel {
	if (level === undefined || level === "xhigh" || level === "max") {
		return MAX_SUBAGENT_THINKING_LEVEL;
	}
	return level;
}
