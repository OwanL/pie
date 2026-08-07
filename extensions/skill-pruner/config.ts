import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PrepassConfig, PruningConfig, PruningMode, PruningStrategy, ToolPruningConfig } from "./types.js";
import { toErrorMessage, parseJsonOrThrow } from "../../shared/error-message.js";

/** Root of the pi-config repo, resolved from this extension's known position. */
const CONFIG_ROOT = path.resolve(import.meta.dirname, "..", "..");

export const DEFAULT_TOOL_CONFIG: ToolPruningConfig = {
	strategy: "discretion",
	ceiling: 10,
	dependencies: {
		edit: ["read"],
		subagent: ["bash"],
		session_review: ["subagent", "ask_user"],
	},
	alwaysKeep: [],
};

export const DEFAULT_CONFIG: PruningConfig = {
	mode: "auto",
	model: "gpt-5.4-mini",
	provider: "github-copilot",
	thinkingLevel: "minimal",
	skills: {
		strategy: "discretion",
		ceiling: 8,
		pinned: [],
		alwaysKeep: [],
	},
	tools: cloneDefaultToolConfig(),
	// `prepass` intentionally absent: no overrides → the built-in timeout /
	// retry budgets in src/prepass.ts apply. Populated only when the user
	// supplies a `pruning.prepass` block.
	prepass: undefined,
	autoSkipBelowTokens: 1200,
};

const VALID_MODES = new Set<PruningMode>(["auto", "off", "shadow"]);
const VALID_STRATEGIES = new Set<PruningStrategy>(["discretion", "topK"]);

function cloneDefault(): PruningConfig {
	return {
		mode: DEFAULT_CONFIG.mode,
		model: DEFAULT_CONFIG.model,
		provider: DEFAULT_CONFIG.provider,
		thinkingLevel: DEFAULT_CONFIG.thinkingLevel,
		skills: {
			strategy: DEFAULT_CONFIG.skills.strategy,
			ceiling: DEFAULT_CONFIG.skills.ceiling,
			pinned: [...DEFAULT_CONFIG.skills.pinned],
			alwaysKeep: [...DEFAULT_CONFIG.skills.alwaysKeep],
		},
		tools: cloneDefaultToolConfig(),
		prepass: undefined,
		autoSkipBelowTokens: DEFAULT_CONFIG.autoSkipBelowTokens,
	};
}

function cloneDefaultToolConfig(): ToolPruningConfig {
	return {
		strategy: DEFAULT_TOOL_CONFIG.strategy,
		ceiling: DEFAULT_TOOL_CONFIG.ceiling,
		dependencies: Object.fromEntries(
			Object.entries(DEFAULT_TOOL_CONFIG.dependencies).map(([k, v]) => [k, [...v]]),
		),
		alwaysKeep: [...DEFAULT_TOOL_CONFIG.alwaysKeep],
	};
}

function warn(message: string): void {
	console.warn(`[skill-pruner] ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function assignEnumValue<T extends string>(
	value: unknown,
	allowed: Set<T>,
	assign: (next: T) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (typeof value === "string" && allowed.has(value as T)) {
		assign(value as T);
		return;
	}
	warn(invalidMessage);
}

function assignNonEmptyString(
	value: unknown,
	assign: (next: string) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (isNonEmptyString(value)) {
		assign(value);
		return;
	}
	warn(invalidMessage);
}

function assignPositiveInteger(
	value: unknown,
	assign: (next: number) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (isPositiveInteger(value)) {
		assign(value);
		return;
	}
	warn(invalidMessage);
}

function assignNonNegativeInteger(
	value: unknown,
	assign: (next: number) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (isNonNegativeInteger(value)) {
		assign(value);
		return;
	}
	warn(invalidMessage);
}

function assignStringArray(
	value: unknown,
	assign: (next: string[]) => void,
	invalidMessage: string,
): void {
	if (value === undefined) {
		return;
	}
	if (isStringArray(value)) {
		assign([...value]);
		return;
	}
	warn(invalidMessage);
}

export function loadConfig(
	settingsPath = path.join(CONFIG_ROOT, "settings.json"),
): PruningConfig {
	if (!existsSync(settingsPath)) {
		warn(`settings.json not found at ${settingsPath}; using pruning defaults`);
		return cloneDefault();
	}

	let parsed: unknown;
	try {
		parsed = parseJsonOrThrow(readFileSync(settingsPath, "utf-8"), "pruning settings");
	} catch (error) {
		warn(`failed to parse settings.json at ${settingsPath}; using pruning defaults: ${toErrorMessage(error)}`);
		return cloneDefault();
	}

	if (!isRecord(parsed) || !("pruning" in parsed)) {
		return cloneDefault();
	}

	const pruning = parsed.pruning;
	if (!isRecord(pruning)) {
		warn("settings.pruning must be an object; using pruning defaults");
		return cloneDefault();
	}

	const raw = pruning;
	const config = cloneDefault();

	// Parse top-level fields
	assignEnumValue(
		raw.mode,
		VALID_MODES,
		(value) => {
			config.mode = value;
		},
		`invalid pruning.mode '${String(raw.mode)}'; using default '${DEFAULT_CONFIG.mode}'`,
	);

	assignNonEmptyString(
		raw.model,
		(value) => {
			config.model = value;
		},
		"invalid pruning.model; using default",
	);

	assignNonEmptyString(
		raw.provider,
		(value) => {
			config.provider = value;
		},
		"invalid pruning.provider; using default",
	);

	if (raw.autoSkipBelowTokens === null) {
		config.autoSkipBelowTokens = null;
	} else if (raw.autoSkipBelowTokens !== undefined) {
		if (isPositiveInteger(raw.autoSkipBelowTokens)) {
			config.autoSkipBelowTokens = raw.autoSkipBelowTokens;
		} else {
			config.autoSkipBelowTokens = null;
			warn("invalid pruning.autoSkipBelowTokens; must be a positive integer or null; disabling");
		}
	}

	assignNonEmptyString(
		raw.thinkingLevel,
		(value) => {
			config.thinkingLevel = value;
		},
		"invalid pruning.thinkingLevel; using default",
	);

	// Parse skills config
	const rawSkills = isRecord(raw.skills) ? raw.skills : {};

	assignEnumValue(
		rawSkills.strategy,
		VALID_STRATEGIES,
		(value) => {
			config.skills.strategy = value;
		},
		"invalid pruning.skills.strategy; using default",
	);

	assignPositiveInteger(
		rawSkills.ceiling,
		(value) => {
			config.skills.ceiling = value;
		},
		"invalid pruning.skills.ceiling; must be a positive integer; using default",
	);

	assignStringArray(
		rawSkills.pinned,
		(value) => {
			config.skills.pinned = value;
		},
		"invalid pruning.skills.pinned; using default []",
	);

	assignStringArray(
		rawSkills.alwaysKeep,
		(value) => {
			config.skills.alwaysKeep = value;
		},
		"invalid pruning.skills.alwaysKeep; using default []",
	);

	// Parse tools config
	if (isRecord(raw.tools)) {
		const rawTools = raw.tools;

		assignEnumValue(
			rawTools.strategy,
			VALID_STRATEGIES,
			(value) => {
				config.tools!.strategy = value;
			},
			"invalid pruning.tools.strategy; using default",
		);

		assignPositiveInteger(
			rawTools.ceiling,
			(value) => {
				config.tools!.ceiling = value;
			},
			"invalid pruning.tools.ceiling; must be a positive integer; using default",
		);

		if (isRecord(rawTools.dependencies)) {
			const newDependencies: Record<string, string[]> = { ...DEFAULT_TOOL_CONFIG.dependencies };
			for (const [tool, deps] of Object.entries(rawTools.dependencies)) {
				if (isStringArray(deps)) {
					newDependencies[tool] = deps;
				} else {
					warn(`Invalid dependencies for tool '${tool}'; skipping`);
				}
			}
			config.tools!.dependencies = newDependencies;
		}

		assignStringArray(
			rawTools.alwaysKeep,
			(value) => {
				config.tools!.alwaysKeep = value;
			},
			"invalid pruning.tools.alwaysKeep; using default []",
		);
	}

	// Parse prepass config (timeouts + retry budgets). Absent → undefined,
	// meaning the built-in budgets in src/prepass.ts apply unchanged.
	if (isRecord(raw.prepass)) {
		const rawPrepass = raw.prepass;
		const prepass: PrepassConfig = {};

		if (typeof rawPrepass.temperature === "number" && Number.isFinite(rawPrepass.temperature)
			&& rawPrepass.temperature >= 0 && rawPrepass.temperature <= 2) {
			prepass.temperature = rawPrepass.temperature;
		} else if (rawPrepass.temperature !== undefined) {
			warn("invalid pruning.prepass.temperature; must be a finite number from 0 to 2; using provider default");
		}

		assignPositiveInteger(
			rawPrepass.maxOutputTokens,
			(value) => { prepass.maxOutputTokens = value; },
			"invalid pruning.prepass.maxOutputTokens; must be a positive integer; using default",
		);

		if (isRecord(rawPrepass.timeoutMs)) {
			const timeoutMs: Record<string, number> = {};
			for (const [level, ms] of Object.entries(rawPrepass.timeoutMs)) {
				if (isPositiveInteger(ms)) {
					timeoutMs[level] = ms;
				} else {
					warn(`Invalid timeoutMs for thinking level '${level}'; must be a positive integer; skipping`);
				}
			}
			if (Object.keys(timeoutMs).length > 0) {
				prepass.timeoutMs = timeoutMs;
			}
		} else if (rawPrepass.timeoutMs !== undefined) {
			warn("invalid pruning.prepass.timeoutMs; must be an object of thinking-level → ms; ignoring");
		}

		assignNonNegativeInteger(
			rawPrepass.maxTransportRetries,
			(value) => {
				prepass.maxTransportRetries = value;
			},
			"invalid pruning.prepass.maxTransportRetries; must be a non-negative integer; using default",
		);

		assignNonNegativeInteger(
			rawPrepass.transportBackoffBaseMs,
			(value) => {
				prepass.transportBackoffBaseMs = value;
			},
			"invalid pruning.prepass.transportBackoffBaseMs; must be a non-negative integer; using default",
		);

		assignNonNegativeInteger(
			rawPrepass.oauthRaceBackoffMs,
			(value) => {
				prepass.oauthRaceBackoffMs = value;
			},
			"invalid pruning.prepass.oauthRaceBackoffMs; must be a non-negative integer; using default",
		);

		// Only attach when at least one override was set, so the default path
		// (empty block or all-invalid) stays `undefined` → pure built-in defaults.
		if (Object.keys(prepass).length > 0) {
			config.prepass = prepass;
		}
	}

	return config;
}
