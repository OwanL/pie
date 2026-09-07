/**
 * Shared Pie-owned system-prompt construction.
 *
 * Pi remains responsible for constructing the dynamic prompt inputs and for
 * honoring explicit custom prompts. This module only replaces the pinned Pi
 * stock prompt's owned introduction, tool-section label, and documentation
 * guidance. The rest of the SDK-built appendix is retained verbatim so
 * appends, context files, skills, and runtime metadata keep their normal Pi
 * semantics.
 */

const PI_INTRO =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';

const PI_TOOLS_START = 'Available tools:\n';
const PI_TOOLS_END = '\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\n';
const PI_GUIDANCE_START = 'Guidelines:\n';
const PI_DOCS_START = 'Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):';
const PI_DOCS_END = '- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)';

const PIE_INTRO =
  'You are a coding assistant operating inside Pie, a development harness built on the Pi runtime. Pie provides project-aware guidance, specialized agents, dynamically available tools and skills, and session workflows.';
const PIE_ROLE =
  'You may be assisting the user directly or completing a delegated task. Follow the assigned task and any role-specific instructions.';
const PIE_CAPABILITIES =
  "The current tool definitions and guidance describe this session's capabilities. Do not assume upstream Pi features are available in Pie.";

export interface PieSystemPromptOptions {
  cwd: string;
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: readonly unknown[];
  activeExtensions?: string[];
}

export type PieSystemPromptBuilder<T extends PieSystemPromptOptions = PieSystemPromptOptions> =
  (options: T) => string;

function promptPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/$/, '');
}

function extractBullet(block: string, label: string): string | undefined {
  const prefix = `- ${label}: `;
  const line = block.split('\n').find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

function extractStockPromptSections(prompt: string): {
  toolSummaries: string;
  toolGuidelines: string;
  docs: string;
  suffix: string;
} | undefined {
  if (!prompt.startsWith(PI_INTRO)) return undefined;

  const toolsStart = prompt.indexOf(PI_TOOLS_START, PI_INTRO.length);
  if (toolsStart < 0) return undefined;
  const toolsEnd = prompt.indexOf(PI_TOOLS_END, toolsStart + PI_TOOLS_START.length);
  if (toolsEnd < 0) return undefined;

  const guidanceStart = toolsEnd + PI_TOOLS_END.length;
  if (!prompt.startsWith(PI_GUIDANCE_START, guidanceStart)) return undefined;
  const docsStart = prompt.indexOf(`\n\n${PI_DOCS_START}`, guidanceStart + PI_GUIDANCE_START.length);
  if (docsStart < 0) return undefined;

  const docsContentStart = docsStart + 2;
  const docsEndMarker = prompt.indexOf(PI_DOCS_END, docsContentStart);
  if (docsEndMarker < 0) return undefined;
  const docsEnd = docsEndMarker + PI_DOCS_END.length;

  return {
    toolSummaries: prompt.slice(toolsStart + PI_TOOLS_START.length, toolsEnd).trimEnd(),
    toolGuidelines: prompt.slice(guidanceStart + PI_GUIDANCE_START.length, docsStart).trimEnd(),
    docs: prompt.slice(docsContentStart, docsEnd),
    suffix: prompt.slice(docsEnd),
  };
}

/**
 * Rewrite one SDK-built stock prompt. The customPrompt check is deliberate:
 * a project may explicitly replace the prompt with text that happens to begin
 * with Pi's stock introduction, and that replacement must remain untouched.
 */
export function rewritePieBuiltSystemPrompt(
  prompt: string,
  options: PieSystemPromptOptions,
  agentDir: string,
): string {
  if (options.customPrompt !== undefined) return prompt;

  const sections = extractStockPromptSections(prompt);
  if (!sections) return prompt;

  const piReadme = extractBullet(sections.docs, 'Main documentation');
  const piDocs = extractBullet(sections.docs, 'Additional docs');
  const piExamples = extractBullet(sections.docs, 'Examples')?.replace(/ \(extensions, custom tools, SDK\)$/, '');
  if (!piReadme || !piDocs || !piExamples) return prompt;

  const root = promptPath(agentDir);
  const harnessDocumentation = [
    'Harness documentation',
    'Consult harness documentation only when the task concerns Pie or its underlying Pi runtime.',
    '',
    `- For Pie development or configuration, load: ${root}/skills/develop-pie/SKILL.md`,
    '- For underlying Pi APIs, use the documentation and examples shipped with the pinned SDK:',
    `  README: ${piReadme}`,
    `  Documentation: ${piDocs}`,
    `  Examples: ${piExamples}`,
    '- Resolve Pi documentation and example references against those directories, not the task\'s working directory.',
    '- Read the sections that own the behavior you are changing and follow references needed to resolve the task. Read the full normative contract when changing its invariants. Stop when the relevant requirements and constraints are understood.',
  ].join('\n');

  const ownedPrompt = [
    PIE_INTRO,
    PIE_ROLE,
    PIE_CAPABILITIES,
    `Available tools:\n${sections.toolSummaries}\n\nTool guidance:\n${sections.toolGuidelines}`,
    harnessDocumentation,
  ].join('\n\n');
  return ownedPrompt + sections.suffix;
}

/** Build the Pie-owned prompt from the SDK's canonical dynamic builder. */
export function buildPieSystemPrompt<T extends PieSystemPromptOptions>(
  options: T,
  buildSystemPrompt: PieSystemPromptBuilder<T>,
  agentDir: string,
): string {
  return rewritePieBuiltSystemPrompt(buildSystemPrompt(options), options, agentDir);
}

/** Return a builder suitable for all Pie prompt consumers (runtime, toggles,
 * display, and inventory). Keeping this callback shared prevents those paths
 * from drifting in how they rewrite the SDK's dynamic appendix. */
export function createPieSystemPromptBuilder<T extends PieSystemPromptOptions>(
  buildSystemPrompt: PieSystemPromptBuilder<T>,
  agentDir: string,
): PieSystemPromptBuilder<T> {
  return (options) => buildPieSystemPrompt(options, buildSystemPrompt, agentDir);
}

const PIE_BASE_PROMPT_ACCESSOR = Symbol.for('pie.systemPrompt.baseAccessor');
const PIE_BASE_PROMPT_ACCESSOR_INSTALLED = Symbol.for('pie.systemPrompt.baseAccessorInstalled');

type PiePromptContext = {
  [PIE_BASE_PROMPT_ACCESSOR]?: () => string | undefined;
};

interface PieExtensionRunnerLike {
  createContext?: () => object;
  setUIContext?: (context: unknown) => void;
  [PIE_BASE_PROMPT_ACCESSOR_INSTALLED]?: boolean;
}

interface PiePromptState<T extends PieSystemPromptOptions> {
  _baseSystemPrompt?: string;
  _baseSystemPromptOptions?: T;
  _rebuildSystemPrompt?: (toolNames: string[]) => string;
  agent?: { state?: { systemPrompt?: string } };
  extensionRunner?: PieExtensionRunnerLike;
}

/** Read Pie's current rebuilt base prompt from an extension event context.
 * The symbol-backed seam exists only on sessions guarded by Pie. */
export function getPieBaseSystemPrompt(context: unknown): string | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const accessor = (context as PiePromptContext)[PIE_BASE_PROMPT_ACCESSOR];
  if (typeof accessor !== 'function') return undefined;
  try {
    return accessor();
  } catch {
    return undefined;
  }
}

interface PromptBodySpan {
  bodyStart: number;
  bodyEnd: number;
}

function findPromptBody(
  prompt: string,
  heading: string,
  endMarkers: readonly string[],
): PromptBodySpan | undefined {
  const headingStart = prompt.indexOf(heading);
  if (headingStart < 0) return undefined;
  const bodyStart = headingStart + heading.length;
  let bodyEnd = prompt.length;
  for (const marker of endMarkers) {
    const candidate = prompt.indexOf(marker, bodyStart);
    if (candidate >= 0 && candidate < bodyEnd) bodyEnd = candidate;
  }
  return { bodyStart, bodyEnd };
}

function mergePromptBody(current: string, previous: string, fresh: string): string {
  const previousCounts = new Map<string, number>();
  for (const line of previous.split('\n')) {
    previousCounts.set(line, (previousCounts.get(line) ?? 0) + 1);
  }
  const foreignLines = current.split('\n').filter((line) => {
    const remaining = previousCounts.get(line) ?? 0;
    if (remaining === 0) return true;
    previousCounts.set(line, remaining - 1);
    return false;
  });
  return [...fresh.split('\n'), ...foreignLines].join('\n');
}

/**
 * Rebase a chained before_agent_start prompt after setActiveTools rebuilt the
 * Pie base. Exact prefix/suffix wrappers are preserved by replacing the old
 * base as a unit. If an earlier extension inserted tool guidance inside that
 * base, only Pie's two tool-prose bodies are refreshed and foreign lines are
 * retained. Unknown/custom shapes fail closed with `undefined`.
 */
export function rebasePieToolPrompt(
  chainedPrompt: string,
  previousBasePrompt: string,
  freshBasePrompt: string,
): string | undefined {
  if (previousBasePrompt === freshBasePrompt) return chainedPrompt;

  const exactStart = chainedPrompt.indexOf(previousBasePrompt);
  if (exactStart >= 0 && chainedPrompt.indexOf(previousBasePrompt, exactStart + previousBasePrompt.length) < 0) {
    return chainedPrompt.slice(0, exactStart)
      + freshBasePrompt
      + chainedPrompt.slice(exactStart + previousBasePrompt.length);
  }

  const pieOwnedShape = previousBasePrompt.startsWith(PIE_INTRO)
    || previousBasePrompt.startsWith(PI_TOOLS_START);
  if (!pieOwnedShape) return undefined;

  const sections = [
    {
      heading: PI_TOOLS_START,
      ends: ['\n\nTool guidance:\n', '\nCurrent date:'],
    },
    {
      heading: 'Tool guidance:\n',
      ends: ['\n\nHarness documentation'],
    },
  ] as const;

  let rebased = chainedPrompt;
  let changed = false;
  for (const section of sections) {
    const previous = findPromptBody(previousBasePrompt, section.heading, section.ends);
    const fresh = findPromptBody(freshBasePrompt, section.heading, section.ends);
    if (!previous && !fresh) continue;
    if (!previous || !fresh) return undefined;
    const current = findPromptBody(rebased, section.heading, section.ends);
    if (!current) return undefined;

    const previousBody = previousBasePrompt.slice(previous.bodyStart, previous.bodyEnd);
    const freshBody = freshBasePrompt.slice(fresh.bodyStart, fresh.bodyEnd);
    const currentBody = rebased.slice(current.bodyStart, current.bodyEnd);
    const merged = mergePromptBody(currentBody, previousBody, freshBody);
    rebased = rebased.slice(0, current.bodyStart) + merged + rebased.slice(current.bodyEnd);
    changed = changed || merged !== currentBody;
  }
  return changed ? rebased : undefined;
}

/**
 * Install the shared Pie rewrite on an AgentSession's private synchronous
 * prompt rebuild seam. The initial SDK-built prompt is updated immediately,
 * then every later tool/resource rebuild is rewritten before it reaches the
 * agent. The original method already produced the canonical dynamic prompt.
 */
export function installPieSystemPromptRebuildGuard<T extends PieSystemPromptOptions>(
  promptState: PiePromptState<T>,
  agentDir: string,
): void {
  const runner = promptState.extensionRunner;
  const createContext = runner?.createContext;
  if (runner && typeof createContext === 'function' && !runner[PIE_BASE_PROMPT_ACCESSOR_INSTALLED]) {
    runner.createContext = function piePromptContext(this: PieExtensionRunnerLike): object {
      const context = createContext.call(this);
      Object.defineProperty(context, PIE_BASE_PROMPT_ACCESSOR, {
        configurable: false,
        enumerable: false,
        value: () => promptState._baseSystemPrompt,
        writable: false,
      });
      return context;
    };
    Object.defineProperty(runner, PIE_BASE_PROMPT_ACCESSOR_INSTALLED, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
  }

  const rebuild = promptState._rebuildSystemPrompt;
  if (typeof rebuild === 'function') {
    promptState._rebuildSystemPrompt = function pieRebuild(this: PiePromptState<T>, toolNames: string[]): string {
      const built = rebuild.call(this, toolNames);
      const options = this._baseSystemPromptOptions ?? promptState._baseSystemPromptOptions;
      return options ? rewritePieBuiltSystemPrompt(built, options, agentDir) : built;
    };
  }

  const options = promptState._baseSystemPromptOptions;
  const base = promptState._baseSystemPrompt;
  if (options && base !== undefined) {
    const rewritten = rewritePieBuiltSystemPrompt(base, options, agentDir);
    promptState._baseSystemPrompt = rewritten;
    if (promptState.agent?.state) {
      promptState.agent.state.systemPrompt = rewritten;
    }
  }
}
