import type { SystemPromptEntry } from '../shared/protocol';
import { ASK_USER_TOOL_NAME } from '../../../shared/autonomous-mode.js';
import { contextFilePathKey, prepareContextFiles } from './context-files';
import type { ActiveModelInfo } from './session-metadata';
import type { SdkBuildSystemPromptOptions, SdkContextFile, SdkSkill, SdkToolInfo } from './sdk';

/** Maximum characters for system prompt and tool description summaries. */
const SUMMARY_MAX_LENGTH = 80;

// ─── Per-session entry toggles ───────────────────────────────────────────────
// Each `SystemPromptEntry` gets a stable `id` so the user can toggle it off
// from the composer toolbar menu. The toggle removes the entry from the
// prompt sent to the model (see `applySystemPromptTogglesToOptions` +
// `stripDisabledSectionsFromPrompt`) and hides it from the transcript display.

/** Entry id for the informational provider card. Display-only: never present
 *  in the sent prompt and not toggleable — the provider's own system prompt is
 *  injected server-side and cannot be removed by pi. */
export const PROVIDER_ENTRY_ID = 'provider';
/** Entry id for the core pi harness prompt (the "You are an expert coding
 *  assistant…" template). Toggling it is a footgun: the model stops behaving
 *  as a coding agent. */
export const HARNESS_ENTRY_ID = 'harness';
/** Entry id for a user-supplied custom prompt that replaces the harness. */
export const CUSTOM_ENTRY_ID = 'custom';
/** Entry id for the appended system prompt (e.g. APPEND_SYSTEM.md). */
export const APPEND_ENTRY_ID = 'append';
/** Entry id for the "Project Context" group prelude heading. */
export const PROJECT_CONTEXT_ENTRY_ID = 'project-context';
/** Entry id for the tool descriptions section of the harness prompt. */
export const TOOLS_ENTRY_ID = 'tools';
/** Entry id for the skills section. */
export const SKILLS_ENTRY_ID = 'skills';
/** Entry id for the trailing "Current date / working directory" runtime line. */
export const RUNTIME_ENTRY_ID = 'runtime';

/** Stable entry id for a project context file (AGENTS.md / context file). */
export function contextFileEntryId(filePath: string): string {
  return `context:${contextFilePathKey(filePath)}`;
}

/** Returns the set of entry ids that should be stripped from the sent prompt.
 *  The provider card is display-only (never in the prompt), so it is excluded. */
export function disabledPromptEntryIds(disabled: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const id of disabled) {
    if (id === PROVIDER_ENTRY_ID) continue;
    out.add(id);
  }
  return out;
}

/** Build a copy of `options` with option-driven disabled entries removed
 *  (appended prompt, skills, individual context files). Non-option-driven
 *  sections (harness, tools, runtime, project-context prelude) are stripped
 *  from the built prompt string by `stripDisabledSectionsFromPrompt`.
 *
 *  `customPrompt` is intentionally NOT cleared here: clearing it would make
 *  `buildSystemPrompt` fall back to the harness template, re-adding the
 *  harness. Instead the custom prompt is stripped from the built string. */
export function applySystemPromptTogglesToOptions(
  options: SdkBuildSystemPromptOptions,
  disabled: ReadonlySet<string>,
): SdkBuildSystemPromptOptions {
  const filtered: SdkBuildSystemPromptOptions = { ...options };

  if (disabled.has(APPEND_ENTRY_ID)) {
    filtered.appendSystemPrompt = undefined;
  }

  if (disabled.has(SKILLS_ENTRY_ID)) {
    filtered.skills = [];
  }

  if (options.contextFiles) {
    const remaining = options.contextFiles.filter(
      (cf) => !disabled.has(contextFileEntryId(cf.path)),
    );
    filtered.contextFiles = remaining.length === options.contextFiles.length
      ? options.contextFiles
      : remaining;
  }

  return filtered;
}

const RUNTIME_TRAILER_RE = /(?:^|\n)Current date: [^\n]+\nCurrent working directory: [^\n]+$/;
const TOOLS_BLOCK_RE =
  /Available tools:\n[\s\S]*?\nIn addition to the tools above, you may have access to other custom tools depending on the project\.\n\n/;
const PROJECT_CONTEXT_OPEN_RE =
  /\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n/;
const PROJECT_CONTEXT_CLOSE_RE = /\n<\/project_context>\n/;

/** Strip non-option-driven disabled sections (harness/custom, tools,
 *  project-context prelude, runtime) from a prompt built by `buildSystemPrompt`.
 *  `harnessPrefix` is the exact harness-template prefix (the result of
 *  `buildSystemPrompt({ cwd, selectedTools, toolSnippets, promptGuidelines })`
 *  with no custom/append/context/skills); `customPrompt` is the user's custom
 *  prompt string when one is set. */
export function stripDisabledSectionsFromPrompt(
  prompt: string,
  disabled: ReadonlySet<string>,
  customPrompt: string | undefined,
  harnessPrefix: string | undefined,
): string {
  let out = prompt;

  // Harness core or custom prompt: remove the leading prefix. The Tools row
  // is independent, so preserve its block when only the harness row is off.
  if (disabled.has(HARNESS_ENTRY_ID) || disabled.has(CUSTOM_ENTRY_ID)) {
    if (customPrompt && out.startsWith(customPrompt)) {
      out = out.slice(customPrompt.length).replace(/^\n+/, '');
    } else if (harnessPrefix && out.startsWith(harnessPrefix)) {
      const toolsBlock = disabled.has(TOOLS_ENTRY_ID)
        ? ''
        : harnessPrefix.match(TOOLS_BLOCK_RE)?.[0] ?? '';
      out = toolsBlock + out.slice(harnessPrefix.length).replace(/^\n+/, '');
    }
  }

  // Tool descriptions block (lives inside the harness prefix).
  if (disabled.has(TOOLS_ENTRY_ID)) {
    out = out.replace(TOOLS_BLOCK_RE, '');
  }

  // Project-context prelude: drop the wrapping <project_context> tag + heading
  // but keep the inner <project_instructions> blocks for any still-enabled
  // files. (When ALL files are disabled, `applySystemPromptTogglesToOptions`
  // empties `contextFiles` and `buildSystemPrompt` omits the whole block, so
  // this surgery only runs for the prelude-only-off case.)
  if (disabled.has(PROJECT_CONTEXT_ENTRY_ID)) {
    out = out.replace(PROJECT_CONTEXT_OPEN_RE, '\n\n').replace(PROJECT_CONTEXT_CLOSE_RE, '\n');
  }

  // Trailing runtime line (date + cwd).
  if (disabled.has(RUNTIME_ENTRY_ID)) {
    out = out.replace(RUNTIME_TRAILER_RE, '');
  }

  return out.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
}

/** A shallow clone of `options` sufficient to snapshot it: nested arrays are
 *  never mutated in place by `applySystemPromptTogglesToOptions` (it spreads
 *  the object and reassigns `contextFiles` / `skills` / `appendSystemPrompt` to
 *  fresh arrays), so a shallow copy keeps the snapshot independent of later
 *  filtering applied to the live options. */
function cloneSystemPromptOptions(options: SdkBuildSystemPromptOptions): SdkBuildSystemPromptOptions {
  return { ...options };
}

/** Whether `current` carries at least every option-driven entry `cached` does
 *  (context files by path, skills by name, appended prompt). True means
 *  `current` is the SDK's fresh, unfiltered snapshot — a superset of what we
 *  had — so it's safe to adopt as the display source of truth. False means
 *  `current` was already filtered by `applySystemPromptTogglesToOptions`
 *  (some entries stripped) and must not overwrite the cached original.
 *  Non-option-driven sections (harness, tools, runtime, project-context,
 *  provider) are stripped from the prompt string, not the options, so they are
 *  not compared. */
export function isSupersetSystemPromptOptions(
  current: SdkBuildSystemPromptOptions,
  cached: SdkBuildSystemPromptOptions,
): boolean {
  if (cached.contextFiles) {
    const currentPaths = new Set(current.contextFiles?.map((cf) => cf.path));
    for (const cf of cached.contextFiles) {
      if (!currentPaths.has(cf.path)) return false;
    }
  }
  if (cached.skills) {
    const currentNames = new Set(current.skills?.map((s) => s.name));
    for (const s of cached.skills) {
      if (!currentNames.has(s.name)) return false;
    }
  }
  if (cached.appendSystemPrompt && !current.appendSystemPrompt) return false;
  return true;
}

/** Minimal view of {@link SessionPromptState} so this pure-logic module stays
 *  decoupled from the server's type graph and unit-testable in isolation. */
interface PromptStateLike {
  _baseSystemPromptOptions?: SdkBuildSystemPromptOptions;
  _originalSystemPromptOptions?: SdkBuildSystemPromptOptions;
}

interface RebuildablePromptState extends PromptStateLike {
  _rebuildSystemPrompt?: (toolNames: string[]) => string;
}

interface ToolToggleSession {
  setActiveToolsByName?: (toolNames: string[]) => void;
}

export interface ToggledSystemPrompt {
  prompt: string;
  options: SdkBuildSystemPromptOptions;
}

/** Rebuild a prompt from an unfiltered SDK option snapshot and apply the
 * persisted picker exclusions. An empty string is a valid result: it is how
 * the picker represents a genuinely prompt-less/raw model call. */
export function buildToggledSystemPrompt(
  source: SdkBuildSystemPromptOptions,
  disabledEntries: readonly string[],
  buildSystemPrompt: (options: SdkBuildSystemPromptOptions) => string,
): ToggledSystemPrompt {
  const disabled = disabledPromptEntryIds(new Set(disabledEntries));
  const options = applySystemPromptTogglesToOptions(source, disabled);
  const built = normalizePromptText(buildSystemPrompt(options)) ?? '';
  if (disabled.size === 0) {
    return { prompt: built, options };
  }

  const harnessPrefix = normalizePromptText(buildSystemPrompt({
    cwd: source.cwd,
    selectedTools: source.selectedTools,
    toolSnippets: source.toolSnippets,
    promptGuidelines: source.promptGuidelines,
  }))?.replace(RUNTIME_TRAILER_RE, '');
  return {
    prompt: stripDisabledSectionsFromPrompt(
      built,
      disabled,
      source.customPrompt,
      harnessPrefix,
    ),
    options,
  };
}

/** Keep picker exclusions authoritative when the SDK rebuilds its base prompt
 * after tools or extension-contributed resources change. The SDK rebuild is
 * synchronous, so the guard must filter synchronously too; a fire-and-forget
 * reapply would race `before_agent_start` and expose the unfiltered prompt. */
export function installSystemPromptToggleRebuildGuard(
  promptState: RebuildablePromptState,
  getDisabledEntries: () => readonly string[],
  buildSystemPrompt: (options: SdkBuildSystemPromptOptions) => string,
): void {
  const rebuild = promptState._rebuildSystemPrompt;
  if (typeof rebuild !== 'function') return;

  promptState._rebuildSystemPrompt = function guardedRebuild(toolNames: string[]): string {
    const sdkPrompt = rebuild.call(this, toolNames);
    captureOriginalSystemPromptOptions(promptState);
    const source = promptState._originalSystemPromptOptions ?? promptState._baseSystemPromptOptions;
    if (!source) return sdkPrompt;

    try {
      const toggled = buildToggledSystemPrompt(source, getDisabledEntries(), buildSystemPrompt);
      promptState._baseSystemPromptOptions = toggled.options;
      return toggled.prompt;
    } catch {
      return sdkPrompt;
    }
  };
}

/** Make the Tools picker row authoritative over provider tool schemas as well
 * as prompt prose. Extensions may call `setActiveToolsByName` during preflight;
 * while Tools is disabled those calls must remain unable to re-expose tools. */
export function installSystemPromptToolToggleGuard(
  session: ToolToggleSession,
  getDisabledEntries: () => readonly string[],
): void {
  const setActiveTools = session.setActiveToolsByName;
  if (typeof setActiveTools !== 'function') return;

  session.setActiveToolsByName = function guardedSetActiveTools(toolNames: string[]): void {
    const toolsDisabled = getDisabledEntries().includes(TOOLS_ENTRY_ID);
    setActiveTools.call(this, toolsDisabled ? [] : toolNames);
  };
}

/** Keep autonomous mode authoritative over every extension-driven tool update.
 * Skill-pruner can reconsider previously hidden tools and request_capability can
 * recover one at runtime, so filtering only once when the preference changes is
 * insufficient: every later setActiveTools call must continue to exclude
 * ask_user while autonomous mode is active. */
export function installAutonomousModeToolGuard(
  session: ToolToggleSession,
  getAutonomousMode: () => boolean,
): void {
  const setActiveTools = session.setActiveToolsByName;
  if (typeof setActiveTools !== 'function') return;

  session.setActiveToolsByName = function guardedSetActiveTools(toolNames: string[]): void {
    setActiveTools.call(
      this,
      getAutonomousMode()
        ? toolNames.filter((name) => name !== ASK_USER_TOOL_NAME)
        : toolNames,
    );
  };
}

/** Tool names owned by the pi-mcp-adapter package. The backend strips these
 *  from every active tool set while the MCP pref is off, so servers stay
 *  configured in their mcp.json files but the model never sees the tools. */
export const MCP_TOOL_NAMES = ['mcp', 'mcpScript'] as const;

/** Keep the MCP pref authoritative over every extension-driven tool update.
 *  The adapter re-adds its tools via setActiveTools on config changes, so
 *  filtering only once when the preference changes is insufficient: every
 *  later setActiveTools call must continue to exclude the MCP tools while the
 *  pref is off. (registerTool auto-activation is handled separately by
 *  re-enforcement at turn start — see worker-runtime-host.) */
export function installMcpToolGuard(
  session: ToolToggleSession,
  getMcpEnabled: () => boolean,
): void {
  const setActiveTools = session.setActiveToolsByName;
  if (typeof setActiveTools !== 'function') return;

  session.setActiveToolsByName = function guardedSetActiveTools(toolNames: string[]): void {
    setActiveTools.call(
      this,
      getMcpEnabled()
        ? toolNames
        : toolNames.filter((name) => !(MCP_TOOL_NAMES as readonly string[]).includes(name)),
    );
  };
}

/** Maintain `_originalSystemPromptOptions`: an unfiltered snapshot of the
 *  SDK's `_baseSystemPromptOptions`, used to rebuild the display entry list
 *  (picker + transcript) with disabled entries still present even after
 *  `applySystemPromptTogglesToBasePrompt` filters the live options for the
 *  model prompt. Refreshes only when the live options are at least as complete
 *  as the cached snapshot, so a filtered set never clobbers it — this is what
 *  keeps a de-selected row from disappearing: the row is rebuilt from the
 *  unfiltered snapshot and marked `disabled`, instead of being dropped because
 *  the live options no longer carry it. */
export function captureOriginalSystemPromptOptions(
  promptState: PromptStateLike,
): void {
  const current = promptState._baseSystemPromptOptions;
  if (!current) return;
  const cached = promptState._originalSystemPromptOptions;
  if (!cached || isSupersetSystemPromptOptions(current, cached)) {
    promptState._originalSystemPromptOptions = cloneSystemPromptOptions(current);
  }
}

/** Mark each entry with `disabled: true/false` based on the session's disabled
 *  set, so the webview can render toggle state without a separate channel.
 *  Display-only entries (`toggleable === false`) are never marked disabled —
 *  even if their id is in the set (e.g. a stale persisted sidecar from before
 *  they became non-toggleable) — so they always stay visible in the transcript. */
export function markDisabledEntries(
  entries: SystemPromptEntry[],
  disabled: ReadonlySet<string>,
): SystemPromptEntry[] {
  if (disabled.size === 0) return entries;
  return entries.map((e) =>
    e.id && disabled.has(e.id) && e.toggleable !== false ? { ...e, disabled: true } : e,
  );
}

/** Normalize a context file list for the option-filter helpers (exposed for
 *  tests that build options inline). */
export function normalizeContextFiles(
  files: readonly SdkContextFile[] | undefined,
): SdkContextFile[] | undefined {
  return files ? [...files] : undefined;
}

export function summarizePrompt(text: string): string {
  const stripped = text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > SUMMARY_MAX_LENGTH ? stripped.slice(0, SUMMARY_MAX_LENGTH) + '...' : stripped;
}

export function normalizePromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function buildSkillSummary(skills: readonly SdkSkill[]): string {
  const summary = skills.map((skill) => skill.name).join(', ');
  return summary.length > SUMMARY_MAX_LENGTH ? `${summary.slice(0, SUMMARY_MAX_LENGTH)}...` : summary;
}

function splitRuntimeContext(text: string | undefined): {
  mainText?: string;
  runtimeText?: string;
} {
  const normalized = normalizePromptText(text);
  if (!normalized) {
    return {};
  }

  const match = normalized.match(/\nCurrent date: [^\n]+\nCurrent working directory: [^\n]+$/);
  if (!match) {
    return { mainText: normalized };
  }

  const runtimeText = match[0].trimStart();
  const mainText = normalized.slice(0, normalized.length - match[0].length).trimEnd();
  return {
    mainText: mainText || undefined,
    runtimeText: runtimeText || undefined,
  };
}

function buildRuntimeContext(cwd: string | undefined): string | undefined {
  const resolvedCwd = normalizePromptText(cwd)?.replace(/\\/g, '/');
  if (!resolvedCwd) {
    return undefined;
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `Current date: ${year}-${month}-${day}\nCurrent working directory: ${resolvedCwd}`;
}

function buildProjectContextPrelude(): string {
  return '# Project Context\n\nProject-specific instructions and guidelines:';
}

function buildContextFileSection(displayPath: string, content: string): string {
  return `## ${displayPath}\n\n${content}`;
}

/**
 * Build the "Provider system prompt" entry from the session's active model.
 *
 * pi sends the reconstructed system prompt (harness template or a custom
 * prompt, plus appended / project-context / skills / runtime sections) to the
 * active provider as the system message. The provider's own system prompt is
 * not exposed to this extension — direct API providers do not inject one, while
 * wrapper providers (e.g. GitHub Copilot Chat) may prepend hidden instructions
 * server-side. This entry names the active provider/model so the card reflects
 * the live session instead of a hardcoded provider.
 */
export function buildProviderSystemPrompt(active?: ActiveModelInfo): SystemPromptEntry {
  const provider = active?.provider;
  const modelId = active?.modelId;
  const modelLabel = active?.modelName ?? modelId;
  const modelClause = modelLabel ? ` (${modelLabel})` : '';

  if (provider) {
    return {
      source: 'provider',
      id: PROVIDER_ENTRY_ID,
      title: 'Provider system prompt',
      summary: provider,
      text: `Not directly exposed.\n\npi sends the reconstructed system prompt — built from the harness template (or a custom prompt) plus the appended, project-context, skills, and runtime entries — to ${provider}${modelClause} as the system message. Some providers also inject their own hidden instructions server-side (e.g. GitHub Copilot Chat's prelude); those are not visible to this extension.`,
      availability: 'unknown',
      toggleable: false,
    };
  }

  const text = modelId
    ? `Not resolved.\n\nThe active model (${modelId}) is not in pi's model registry, so its provider cannot be named here. pi still sends the reconstructed system prompt to it as the system message.`
    : `Not resolved yet.\n\nNo active model has been selected for this session. Once a model is chosen, this entry names its provider and describes the system prompt pi sends to it.`;
  return {
    source: 'provider',
    id: PROVIDER_ENTRY_ID,
    title: 'Provider system prompt',
    summary: 'Unknown',
    text,
    availability: 'unknown',
    toggleable: false,
  };
}

export function buildSessionSystemPrompts(options: {
  harnessPrompt?: string;
  promptOptions?: SdkBuildSystemPromptOptions;
  formatSkillsForPrompt?: ((skills: SdkSkill[]) => string) | undefined;
  tools?: SdkToolInfo[];
  /** Active provider/model for the provider entry. Omit to render a neutral "not resolved" state. */
  activeProvider?: ActiveModelInfo;
  /** Entry ids the user has toggled off for this session. Each built entry is
   *  marked `disabled: true` when its id is in this set so the webview can hide
   *  it from the transcript and render the toggle menu state. */
  disabledEntries?: readonly string[];
}): SystemPromptEntry[] {
  const { harnessPrompt, promptOptions, formatSkillsForPrompt } = options;
  const entries: SystemPromptEntry[] = [buildProviderSystemPrompt(options.activeProvider)];

  const customPrompt = normalizePromptText(promptOptions?.customPrompt);
  const { mainText: harnessMainTextWithTools, runtimeText: harnessRuntimeText } = splitRuntimeContext(harnessPrompt);
  // Tools have their own independently-toggleable row; do not duplicate that
  // block in the harness card or its token estimate.
  const harnessMainText = harnessMainTextWithTools?.replace(TOOLS_BLOCK_RE, '').trim();

  if (customPrompt) {
    entries.push({
      source: 'user',
      id: CUSTOM_ENTRY_ID,
      title: 'Custom system prompt',
      summary: summarizePrompt(customPrompt),
      text: customPrompt,
      availability: 'available',
    });
  } else {
    entries.push(
      harnessMainText
        ? {
            source: 'harness',
            id: HARNESS_ENTRY_ID,
            title: 'Harness system prompt',
            summary: summarizePrompt(harnessMainText),
            text: harnessMainText,
            availability: 'available',
          }
        : {
            source: 'harness',
            id: HARNESS_ENTRY_ID,
            title: 'Harness system prompt',
            summary: 'Unavailable',
            text: 'The PI harness prompt could not be reconstructed for this session.',
            availability: 'missing',
          },
    );
  }

  const appendSystemPrompt = normalizePromptText(promptOptions?.appendSystemPrompt);
  if (appendSystemPrompt) {
    const headingMatch = appendSystemPrompt.match(/^#\s+(.+)$/m);
    const title = headingMatch ? headingMatch[1] : 'Appended system prompt';
    entries.push({
      source: 'user',
      id: APPEND_ENTRY_ID,
      title,
      summary: summarizePrompt(appendSystemPrompt),
      text: appendSystemPrompt,
      availability: 'available',
    });
  }

  const contextFiles = prepareContextFiles(promptOptions?.contextFiles)
    .map((contextFile) => ({
      path: contextFile.path,
      displayPath: contextFile.displayPath,
      content: normalizePromptText(contextFile.content),
    }))
    .filter((contextFile): contextFile is { path: string; displayPath: string; content: string } => !!contextFile.content);

  if (contextFiles.length > 0) {
    entries.push({
      source: 'user',
      id: PROJECT_CONTEXT_ENTRY_ID,
      title: 'Project Context',
      summary: 'Project-specific instructions and guidelines',
      text: buildProjectContextPrelude(),
      availability: 'available',
    });

    for (const contextFile of contextFiles) {
      entries.push({
        source: 'user',
        id: contextFileEntryId(contextFile.path),
        title: contextFile.displayPath,
        tooltip: contextFile.path !== contextFile.displayPath ? contextFile.path : undefined,
        summary: summarizePrompt(contextFile.content),
        text: buildContextFileSection(contextFile.displayPath, contextFile.content),
        availability: 'available',
      });
    }
  }

  const tools = options.tools ?? [];
  if (tools.length > 0) {
    const toolSummary = tools.map((t) => t.name).join(', ');
    const toolText = tools.map((t) => {
      let entry = `## ${t.name}\n\n${t.description || '(no description)'}`;
      if (t.parameters) {
        try {
          entry += '\n\n**Parameters:**\n```json\n' + JSON.stringify(t.parameters, null, 2) + '\n```';
        } catch { /* ignore serialization errors */ }
      }
      return entry;
    }).join('\n\n---\n\n');
    entries.push({
      source: 'harness',
      id: TOOLS_ENTRY_ID,
      title: 'Tools',
      summary: toolSummary.length > SUMMARY_MAX_LENGTH ? `${toolSummary.slice(0, SUMMARY_MAX_LENGTH)}...` : toolSummary,
      text: toolText,
      availability: 'available',
    });
  }

  // Keep the Skills row available while the Tools row is manually disabled.
  // Pi normally omits skills when `read` is inactive, but the picker must not
  // lose the independent Skills toggle merely because all schemas are hidden.
  const toolsDisabled = options.disabledEntries?.includes(TOOLS_ENTRY_ID) ?? false;
  const shouldIncludeSkills = toolsDisabled
    || !promptOptions?.selectedTools
    || promptOptions.selectedTools.includes('read');
  const skills = (promptOptions?.skills ?? []).filter(
    (s): s is SdkSkill => !!s && typeof s.name === 'string',
  );
  if (shouldIncludeSkills && formatSkillsForPrompt && skills.length > 0) {
    try {
      const formattedSkills = normalizePromptText(formatSkillsForPrompt(skills));
      if (formattedSkills) {
        entries.push({
          source: 'user',
          id: SKILLS_ENTRY_ID,
          title: 'Skills',
          summary: buildSkillSummary(skills),
          text: formattedSkills,
          availability: 'available',
        });
      }
    } catch { /* SDK formatSkillsForPrompt may crash on malformed skill data */ }
  }

  const runtimeContext = customPrompt
    ? buildRuntimeContext(promptOptions?.cwd)
    : harnessRuntimeText;
  if (runtimeContext) {
    entries.push({
      source: 'user',
      id: RUNTIME_ENTRY_ID,
      title: 'Current date / working directory',
      summary: summarizePrompt(runtimeContext),
      text: runtimeContext,
      availability: 'available',
    });
  }

  const disabledSet = options.disabledEntries && options.disabledEntries.length > 0
    ? new Set(options.disabledEntries)
    : null;
  return disabledSet ? markDisabledEntries(entries, disabledSet) : entries;
}
