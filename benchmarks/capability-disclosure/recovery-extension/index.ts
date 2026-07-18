import { readFileSync } from "node:fs";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";

const HIDDEN_TOOLS = [
  "artifact_metadata_lookup",
  "compatibility_matrix_lookup",
  "deployment_window_lookup",
  "feature_flag_snapshot",
  "incident_reference_lookup",
  "package_provenance_lookup",
  "release_channel_status",
  "schema_registry_lookup",
];
const SKILLS_BLOCK_RE = /\n\s*The following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const variant = String((globalThis as Record<string, unknown>).__PIE_BENCHMARK_CAPABILITY_VARIANT ?? "unified-immediate");
const unified = variant.startsWith("unified-");
const immediate = variant.endsWith("-immediate");

function names(values: string[]): string {
  return values.length > 0 ? values.sort().join(", ") : "(none)";
}

function skillBlock(skill: Skill): string {
  const content = readFileSync(skill.filePath, "utf8");
  const body = content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "").trim();
  return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

export default function recoveryExtension(pi: ExtensionAPI) {
  const hiddenSkills = new Map<string, Skill>();
  const loadedSkills = new Set<string>();

  const currentHiddenTools = () => {
    const active = new Set(pi.getActiveTools());
    return HIDDEN_TOOLS.filter((name) => !active.has(name));
  };
  const currentHiddenSkills = () => [...hiddenSkills.keys()].filter((name) => !loadedSkills.has(name));

  const activateTool = (name: string) => {
    if (!currentHiddenTools().includes(name)) {
      return { content: [{ type: "text" as const, text: `No hidden tool named '${name}'. Poll without arguments for exact names.` }], isError: true };
    }
    pi.setActiveTools([...new Set([...pi.getActiveTools(), name])]);
    return { content: [{ type: "text" as const, text: `Enabled tool '${name}'; it is available on the next model step.` }] };
  };

  const loadSkill = (name: string) => {
    const skill = hiddenSkills.get(name);
    if (!skill || loadedSkills.has(name)) {
      return { content: [{ type: "text" as const, text: `No hidden skill named '${name}'. Poll without arguments for exact names.` }], isError: true };
    }
    loadedSkills.add(name);
    if (immediate) return { content: [{ type: "text" as const, text: skillBlock(skill) }] };
    return { content: [{ type: "text" as const, text: `Skill '${skill.name}': ${skill.description}\nRead ${skill.filePath} and follow it. References are relative to ${skill.baseDir}.` }] };
  };

  if (unified) {
    pi.registerTool({
      name: "request_capability",
      label: "Request Capability",
      description: "List tools and skills hidden by the latest pruning decision, or activate/load one by exact type and name.",
      promptSnippet: "Poll for hidden tools or skills, then activate or load one by exact type and name.",
      promptGuidelines: ["Use request_capability only when the task needs a capability absent from the active tools and skills. Omit both arguments once to list hidden names, then pass the exact type and name. Do not poll when an active capability is sufficient or repeat a poll whose result is already in context."],
      parameters: {
        type: "object",
        properties: {
          capabilityType: { type: "string", enum: ["tool", "skill"], description: "Type of hidden capability to select. Omit when listing." },
          capabilityName: { type: "string", description: "Exact hidden capability name from a previous listing. Omit when listing." },
        },
        additionalProperties: false,
      },
      async execute(_id, params: { capabilityType?: string; capabilityName?: string }) {
        if (!params.capabilityType && !params.capabilityName) {
          return { content: [{ type: "text" as const, text: `tools\t${names(currentHiddenTools())}\nskills\t${names(currentHiddenSkills())}` }] };
        }
        if (!params.capabilityType || !params.capabilityName) {
          return { content: [{ type: "text" as const, text: "Provide both capabilityType and capabilityName, or omit both to list hidden capabilities." }], isError: true };
        }
        return params.capabilityType === "tool" ? activateTool(params.capabilityName) : loadSkill(params.capabilityName);
      },
    });
  } else {
    pi.registerTool({
      name: "request_tool",
      label: "Request Tool",
      description: "List tools hidden by the latest pruning decision, or enable one by exact name.",
      promptSnippet: "Poll for hidden tools, then enable one by exact name.",
      promptGuidelines: ["Use request_tool only when the task needs a tool absent from the active catalog. Omit toolName once to list hidden tool names, then pass an exact listed name. This tool cannot load skills."],
      parameters: { type: "object", properties: { toolName: { type: "string", description: "Exact hidden tool name. Omit when listing." } }, additionalProperties: false },
      async execute(_id, params: { toolName?: string }) {
        return params.toolName ? activateTool(params.toolName) : { content: [{ type: "text" as const, text: `tools\t${names(currentHiddenTools())}` }] };
      },
    });
    pi.registerTool({
      name: "request_skill",
      label: "Request Skill",
      description: "List skills hidden by the latest pruning decision, or load one by exact name.",
      promptSnippet: "Poll for hidden skills, then load one by exact name.",
      promptGuidelines: ["Use request_skill only when the task needs specialized instructions absent from the active skills. Omit skillName once to list hidden skill names, then pass an exact listed name. This tool cannot enable tools."],
      parameters: { type: "object", properties: { skillName: { type: "string", description: "Exact hidden skill name. Omit when listing." } }, additionalProperties: false },
      async execute(_id, params: { skillName?: string }) {
        return params.skillName ? loadSkill(params.skillName) : { content: [{ type: "text" as const, text: `skills\t${names(currentHiddenSkills())}` }] };
      },
    });
  }

  pi.on("before_agent_start", (event) => {
    hiddenSkills.clear();
    for (const skill of event.systemPromptOptions.skills ?? []) hiddenSkills.set(skill.name, skill);
    const recoveryNames = unified ? ["request_capability"] : ["request_tool", "request_skill"];
    const active = pi.getActiveTools().filter((name) => !HIDDEN_TOOLS.includes(name));
    pi.setActiveTools([...new Set([...active, ...recoveryNames])]);
    return { systemPrompt: event.systemPrompt.replace(SKILLS_BLOCK_RE, "") };
  });
}
