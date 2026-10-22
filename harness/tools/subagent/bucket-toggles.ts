import { normalizeSubagentBucketChoices, type SubagentBucketChoices } from "../../../lib/subagent-bucket-policy.js";
import type { SubagentRuntimeContext } from "./runtime-context.js";

export const SUBAGENT_BUCKET_TOGGLES_ENV = "PIE_SUBAGENT_BUCKET_TOGGLES_BY_SESSION_JSON";

const comparablePath = (value: string): string => {
	const normalized = value.replace(/\\/g, "/");
	return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
};

export function parseSessionBucketToggles(raw: string | undefined, sessionPath: string | undefined): SubagentBucketChoices {
	try {
		const parsed: unknown = raw ? JSON.parse(raw) : undefined;
		if (!sessionPath || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return normalizeSubagentBucketChoices(undefined);
		const entry = Object.entries(parsed).find(([key]) => comparablePath(key) === comparablePath(sessionPath));
		return normalizeSubagentBucketChoices(entry?.[1]);
	} catch {
		return normalizeSubagentBucketChoices(undefined);
	}
}

/** Root calls read fresh preferences; descendants inherit the tree snapshot. */
export function resolveTreeSubagentBucketChoices(context: SubagentRuntimeContext, sessionPath: string | undefined): Readonly<SubagentBucketChoices> {
	return context.subagentBucketChoices ??= Object.freeze(parseSessionBucketToggles(process.env[SUBAGENT_BUCKET_TOGGLES_ENV], sessionPath));
}
