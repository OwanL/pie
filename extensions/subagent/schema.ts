/**
 * Typebox parameter schema for the subagent tool. Extracted from `index.ts` —
 * behaviour-preserving.
 */

// Both `StringEnum` and `Type` come from `@mariozechner/pi-ai` (pi's loader
// aliases the legacy `@mariozechner/pi-ai` to the real `@earendil-works/pi-ai`,
// which re-exports `Type` from its bundled typebox). Importing `Type` from a
// separate `typebox` would resolve to a different module instance under pi's
// loader, splitting the TypeBox runtime (symbols/registries) between
// `StringEnum` and `Type.Object` — so the subagent's parameter schema must
// source both from the same pi-ai entrypoint. This also keeps the schema on
// the exact TypeBox instance pi-ai's tool-parameter API expects.
import { StringEnum, Type, type Static } from "@mariozechner/pi-ai";

export const BUCKET_GUIDANCE = "Model bucket: 'small' for trivial work, 'medium' for normal development (default), or 'frontier' only for exceptional difficulty.";

const BucketSchema = Type.Optional(StringEnum(["small", "medium", "frontier"] as const, {
	description: BUCKET_GUIDANCE,
	default: "medium",
}));

const UserContextSchema = Type.Optional(StringEnum(["latest", "all"] as const, {
	description: "Parent prompts and ask_user clarifications only: omit for self-contained tasks; 'latest' for the current request and its clarifications; 'all' only when requirements span multiple user turns.",
}));

const InputKindSchema = StringEnum(["image"] as const, {
	description: "Required runtime input kind the serving model must accept. `image` restricts selection to provider-qualified image-capable models; text-only models and fallbacks are never chosen for the child.",
});

const ModelRequirementsSchema = Type.Optional(
	Type.Object(
		{
			inputKinds: Type.Optional(
				Type.Array(InputKindSchema, {
					description: "Required input kinds. An empty/absent array preserves current selection behaviour.",
				}),
			),
		},
		{
			additionalProperties: false,
			description: "Optional hard model requirements for the child. Absent or empty preserves current selection behaviour; { inputKinds: ['image'] } restricts selection to provider-qualified image-capable models.",
		},
	),
);

export const SubagentParams = Type.Object(
	{
		agent: Type.String({
			description: "Exact discovered agent name to invoke (e.g. 'worker', 'scout', 'reviewer').",
		}),
		task: Type.String({ description: "One concrete task to delegate to the agent" }),
		workflowRef: Type.Optional(Type.String({
			minLength: 1,
			maxLength: 512,
			description: "Optional opaque workflow correlation issued by another tool. It is persisted on the parent tool call but is not added to the child's prompt.",
		})),
		userContext: UserContextSchema,
		// Do not put a JSON Schema `default` on this optional override. Some tool
		// consumers materialize schema defaults into the call, which would turn an
		// omitted value into an explicit `true` and bypass the settings.json default.
		confirmProjectAgents: Type.Optional(
			Type.Boolean({
				description:
					"Prompt before running project-local agents. Omit to use `subagent.confirmProjectAgents` from settings.json (or true when unset); an explicit call value takes precedence.",
			}),
		),
		cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
		bucket: BucketSchema,
		modelRequirements: ModelRequirementsSchema,
	},
	{ additionalProperties: false },
);

/** Resume compatibility for removed fields/routes. One-item legacy batches
 * can be migrated without ambiguity; multi-item orchestration must be reissued
 * as sibling calls or later turns. */
export function prepareSubagentArguments(raw: unknown): Static<typeof SubagentParams> {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return raw as Static<typeof SubagentParams>;
	}
	const { agentScope: _ignored, thinkingLevel: _legacyThinkingLevel, tasks, chain, ...rest } = raw as Record<string, unknown>;
	if (typeof rest.agent === "string" && typeof rest.task === "string") {
		return rest as Static<typeof SubagentParams>;
	}
	const legacyItems = Array.isArray(tasks) && tasks.length === 1
		? tasks
		: Array.isArray(chain) && chain.length === 1
			? chain
			: undefined;
	const item = legacyItems?.[0];
	if (item && typeof item === "object" && !Array.isArray(item)) {
		const { thinkingLevel: _legacyItemThinkingLevel, ...legacyItem } = item as Record<string, unknown>;
		return { ...rest, ...legacyItem } as Static<typeof SubagentParams>;
	}
	if ((Array.isArray(tasks) && tasks.length > 0) || (Array.isArray(chain) && chain.length > 0)) {
		throw new Error("Subagent batch/chain calls were removed. Emit independent tasks as sibling subagent calls, or delegate dependent tasks in later turns.");
	}
	return rest as Static<typeof SubagentParams>;
}
