import type { Skill } from "@earendil-works/pi-coding-agent";
import type { PruningConfig } from "../../tool-and-skill-selection/settings/config-types.js";

export const MIN_PROMPT_LENGTH = 8;

/**
 * Locates the host-injected skills block in the system prompt so the pruner
 * can rewrite it. The leading `\n\s*` (rather than a brittle `\n\n`) tolerates
 * whitespace/newline-count variation in the host layout — if the block's exact
 * leading whitespace shifts slightly, matching still succeeds instead of
 * silently self-disabling skill pruning. The intro sentence and
 * `<available_skills>` tags remain the structural anchors, so behaviour is
 * unchanged when the block is present in the standard layout.
 */
export const SKILLS_BLOCK_RE = /\n\s*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;

export function resolveVisibleSkills(skills: Skill[], activeConfig: PruningConfig) {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	const disabledNames = new Set(
		skills.filter((s) => s.disableModelInvocation).map((s) => s.name),
	);

	const visibleSkillNames = new Set(visibleSkills.map((s) => s.name));
	const effectivePinned = [...new Set([
		...(activeConfig.skills.pinned ?? []),
		...(activeConfig.skills.alwaysKeep ?? []),
	])].filter((name) => {
		if (disabledNames.has(name)) {
			console.warn(`[skill-pruner] forced-include skill '${name}' is disabled (disableModelInvocation); skipping`);
			return false;
		}
		if (!visibleSkillNames.has(name)) {
			console.warn(`[skill-pruner] forced-include skill '${name}' is not in the current session's visible skills; skipping`);
			return false;
		}
		return true;
	});

	return {
		visibleSkills,
		visibleSkillNames,
		effectivePinned,
	};
}

export function applySkillSelection(
	visibleSkills: Skill[],
	prunedSkills: string[] | null,
	effectivePinned: string[],
	_activeConfig: PruningConfig,
	// True when at least one tool survives tool-pruning. With tools available the
	// agent is still fully capable (zero skills leaves it functional, unlike zero
	// tools), so a legitimate full skill-prune is allowed through. Defaults to
	// false so callers that don't track tool state keep the historical
	// keep-all-on-full-prune behaviour.
	toolsRemain = false,
): { includedSkillNames: string[]; excludedSkillNames: string[]; safeguardReason?: string } {
	// No usable prepass signal → keep everything.
	if (prunedSkills === null) {
		return {
			includedSkillNames: visibleSkills.map((s) => s.name),
			excludedSkillNames: [],
		};
	}

	const protectedNames = new Set(effectivePinned);
	const visibleNames = new Set(visibleSkills.map((s) => s.name));
	const pruneSet = new Set(
		prunedSkills.filter((name) => visibleNames.has(name) && !protectedNames.has(name)),
	);

	const excludedSkillNames = visibleSkills.filter((s) => pruneSet.has(s.name)).map((s) => s.name);
	const includedSkillNames = visibleSkills.filter((s) => !pruneSet.has(s.name)).map((s) => s.name);

	// Keep-all safeguard: when the prepass prunes every visible skill AND no tools
	// remain, we keep all skills rather than strip the lot. With tools still
	// available a full skill-prune is legitimate (none of the specialized skills
	// are relevant to the arc of work, e.g. a simple text edit), since zero skills
	// leaves the agent fully functional. Only when there are also no tools would
	// stripping every skill leave it with nothing. Pinned skills already survive,
	// so this only triggers when nothing at all would remain.
	if (includedSkillNames.length === 0 && visibleSkills.length > 0 && !toolsRemain) {
		return {
			includedSkillNames: visibleSkills.map((s) => s.name),
			excludedSkillNames: [],
			safeguardReason: "LLM pruned every visible skill; keeping all as a safeguard",
		};
	}

	return { includedSkillNames, excludedSkillNames };
}
