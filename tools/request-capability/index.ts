import { readFileSync } from 'node:fs';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';

/**
 * Pie-owned `request_capability` implementation, extracted from
 * `extensions/skill-pruner/src/tools.ts` (step 2 of tools/README.md's
 * remaining migration). The tool is deliberately stateless: pruning
 * lifecycle state (hidden skills, loaded skills, pruned tools), pruning
 * policy, and recovery telemetry remain owned by the skill-pruner
 * extension and reach this tool through the injected ports below. The
 * extension's `createRequestCapabilityDefinition(toolSeams)` adapter
 * constructs the ports from its own single-owner modules, so there is
 * exactly one lifecycle state and no import cycle.
 */

/** Structural view of a hidden-skill record; the skill-pruner state keeps
 *  the full SDK `Skill`, which satisfies this shape. */
export interface SkillRecord {
  name: string;
  filePath: string;
  baseDir: string;
}

/** Explicit seams the recovery tool needs. Read-only state ports let the
 *  owner keep mutating authority; only `recordLoadedSkill` writes lifecycle
 *  state (a recovered skill), mirroring the previous behavior. */
export interface RequestCapabilityPorts {
  /** Host tool-catalog seams (the registering extension's pi instance). */
  getAllTools(): ToolInfo[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  /** Derive the owning session id from the SDK execution context. */
  getSessionId(ctx: unknown): string;
  /** Lifecycle-state ports (single owner: skill-pruner's state module). */
  getPrunedTools(sessionId: string): ReadonlySet<string>;
  getHiddenSkills(sessionId: string): ReadonlyMap<string, SkillRecord>;
  getLoadedSkills(sessionId: string): ReadonlySet<string>;
  recordLoadedSkill(sessionId: string, skillName: string): void;
  /** Policy ports: autonomous-mode withholding and tool dependency edges. */
  isAutonomousModeEnabled(): boolean;
  askUserToolName: string;
  getToolDependencies(): Readonly<Record<string, readonly string[]>>;
  /** Log ports: over-pruning recovery telemetry. */
  recordSkillRecovery(sessionId: string, skillName: string): void;
  recordToolRecovery(sessionId: string, toolName: string): void;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, '').trim();
}

function formatSkill(skill: SkillRecord): string {
  const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8'));
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

function commaList(names: readonly string[]): string {
  return names.length > 0 ? [...names].sort().join(', ') : '(none)';
}

export function createRequestCapabilityTool(ports: RequestCapabilityPorts) {
  return {
    name: 'request_capability',
    label: 'Request Capability',
    description: 'List tools and skills hidden by the latest pruning decision, or activate/load one by exact type and name.',
    promptSnippet: 'Poll for hidden tools or skills, then activate or load one by exact type and name.',
    promptGuidelines: [
      'Use request_capability only after checking the active tools and skills and finding no suitable capability. Never poll to verify, supplement, or replace a suitable active capability. Omit both arguments once to list hidden names, then pass the exact type and name; do not repeat a poll already in context.',
    ],
    parameters: {
      type: 'object',
      properties: {
        capabilityType: {
          type: 'string',
          enum: ['tool', 'skill'],
          description: 'Type of hidden capability to select. Omit when listing.',
        },
        capabilityName: {
          type: 'string',
          description: 'Exact hidden capability name from a previous listing. Omit when listing.',
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: Record<string, unknown>, _signal: AbortSignal, _onUpdate: () => void, ctx: unknown) {
      const capabilityType = typeof params.capabilityType === 'string' ? params.capabilityType.trim() : '';
      const capabilityName = typeof params.capabilityName === 'string' ? params.capabilityName.trim() : '';
      const sessionId = ports.getSessionId(ctx);
      const allTools = ports.getAllTools();
      const activeTools = ports.getActiveTools();
      const knownToolNames = new Set(allTools.map((tool) => tool.name));
      const autonomousMode = ports.isAutonomousModeEnabled();
      const hiddenToolNames = [...ports.getPrunedTools(sessionId)]
        .filter((name) => knownToolNames.has(name) && !activeTools.includes(name))
        .filter((name) => !autonomousMode || name !== ports.askUserToolName)
        .sort();
      const hiddenSkills = ports.getHiddenSkills(sessionId);
      const loadedSkills = ports.getLoadedSkills(sessionId);
      const hiddenSkillNames = [...hiddenSkills.keys()].filter((name) => !loadedSkills.has(name)).sort();

      if (!capabilityType && !capabilityName) {
        if (hiddenToolNames.length === 0 && hiddenSkillNames.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No capabilities are hidden by the latest pruning decision.' }] };
        }
        return { content: [{ type: 'text' as const, text: `tools\t${commaList(hiddenToolNames)}\nskills\t${commaList(hiddenSkillNames)}` }] };
      }
      if (!capabilityType || !capabilityName) {
        return {
          content: [{ type: 'text' as const, text: 'Provide both capabilityType and capabilityName, or omit both to list hidden capabilities.' }],
          isError: true,
        };
      }
      if (capabilityType !== 'tool' && capabilityType !== 'skill') {
        return { content: [{ type: 'text' as const, text: "capabilityType must be 'tool' or 'skill'." }], isError: true };
      }
      if (autonomousMode && capabilityType === 'tool' && capabilityName === ports.askUserToolName) {
        return { content: [{ type: 'text' as const, text: 'ask_user is unavailable while autonomous mode is active.' }], isError: true };
      }

      if (capabilityType === 'skill') {
        const skill = hiddenSkills.get(capabilityName);
        if (!skill || loadedSkills.has(capabilityName)) {
          if (hiddenToolNames.includes(capabilityName)) {
            return { content: [{ type: 'text' as const, text: `'${capabilityName}' is a hidden tool, not a skill. Use capabilityType='tool'.` }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: `No hidden skill named '${capabilityName}'. Poll without arguments for exact names.` }], isError: true };
        }
        try {
          const text = formatSkill(skill);
          ports.recordLoadedSkill(sessionId, capabilityName);
          ports.recordSkillRecovery(sessionId, capabilityName);
          return { content: [{ type: 'text' as const, text }] };
        } catch (error) {
          return { content: [{ type: 'text' as const, text: `Failed to load hidden skill '${capabilityName}': ${error instanceof Error ? error.message : String(error)}` }], isError: true };
        }
      }

      if (!hiddenToolNames.includes(capabilityName)) {
        if (hiddenSkillNames.includes(capabilityName)) {
          return { content: [{ type: 'text' as const, text: `'${capabilityName}' is a hidden skill, not a tool. Use capabilityType='skill'.` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: `No hidden tool named '${capabilityName}'. Poll without arguments for exact names.` }], isError: true };
      }

      const pruned = ports.getPrunedTools(sessionId);
      const dependencies = ports.getToolDependencies();
      const enabled = new Set(activeTools);
      const visited = new Set<string>();
      const visit = (name: string) => {
        if (visited.has(name) || !knownToolNames.has(name)) return;
        visited.add(name);
        if (name === capabilityName || pruned.has(name)) enabled.add(name);
        for (const dependency of dependencies[name] ?? []) visit(dependency);
      };
      visit(capabilityName);
      const newActiveTools = [...enabled];
      ports.setActiveTools(newActiveTools);
      ports.recordToolRecovery(sessionId, capabilityName);
      return { content: [{ type: 'text' as const, text: `Enabled tool '${capabilityName}'; it is available on the next model step.` }] };
    },
  };
}