import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  buildPieSystemPrompt,
  installPieSystemPromptRebuildGuard,
  rebasePieToolPrompt,
  rewritePieBuiltSystemPrompt,
  type PieSystemPromptOptions,
} from '../../../shared/pie-harness-prompt.js';
import {
  buildSessionSystemPrompts,
  HARNESS_ENTRY_ID,
  RUNTIME_ENTRY_ID,
  TOOLS_ENTRY_ID,
  contextFileEntryId,
  installSystemPromptToggleRebuildGuard,
} from '../../src/backend/system-prompts';
import { TRAVERSAL_POLICY_PROMPT } from '../../../shared/traversal-policy.js';

const piIntro = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';
const pieIntro = 'You are a coding assistant operating inside Pie, a development harness built on the Pi runtime. Pie provides project-aware guidance, specialized agents, dynamically available tools and skills, and session workflows.';
const pieRole = 'You may be assisting the user directly or completing a delegated task. Follow the assigned task and any role-specific instructions.';
const pieCapabilities = "The current tool definitions and guidance describe this session's capabilities. Do not assume upstream Pi features are available in Pie.";

async function loadSdkPrompt(): Promise<{
  buildSystemPrompt(options: PieSystemPromptOptions): string;
}> {
  const modulePath = path.join(
    process.cwd(),
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'core',
    'system-prompt.js',
  );
  return await import(pathToFileURL(modulePath).href) as {
    buildSystemPrompt(options: PieSystemPromptOptions): string;
  };
}

test('root AGENTS policy mirror cannot drift from the canonical prompt', () => {
  const agents = readFileSync(path.join(process.cwd(), '..', 'AGENTS.md'), 'utf8');
  const match = agents.match(/<!-- canonical-traversal-policy:start -->([\s\S]*?)<!-- canonical-traversal-policy:end -->/u);
  assert.ok(match, 'AGENTS.md must carry the canonical traversal-policy block');
  assert.equal(match[1]!.replace(/\s+/gu, ' ').trim(), TRAVERSAL_POLICY_PROMPT);
});

test('Pie base uses the approved static wording and preserves live SDK tool sections', async () => {
  const sdkPrompt = await loadSdkPrompt();
  const dynamicSnippet = 'Live SDK dynamic snippet';
  const dynamicGuideline = 'Live SDK dynamic guideline';
  const result = buildPieSystemPrompt({
    cwd: 'C:/work',
    selectedTools: ['read'],
    toolSnippets: { read: dynamicSnippet },
    promptGuidelines: [dynamicGuideline],
  }, sdkPrompt.buildSystemPrompt, 'C:/pie');

  assert.ok(result.startsWith(`${pieIntro}\n\n${pieRole}\n\n${pieCapabilities}`));
  assert.ok(result.includes(`Available tools:\n- read: ${dynamicSnippet}`));
  assert.ok(result.includes(`Tool guidance:\n- ${dynamicGuideline}`));
  assert.ok(result.includes('Harness documentation\nConsult harness documentation only when the task concerns Pie or its underlying Pi runtime.'));
  assert.ok(result.includes('- For Pie development or configuration, load: C:/pie/skills/develop-pie/SKILL.md'));
  assert.ok(result.includes('Read the full normative contract when changing its invariants.'));
  assert.ok(result.includes('Stop when the relevant requirements and constraints are understood.'));
  assert.doesNotMatch(result, /Read relevant (?:documents|docs) completely/u);
  assert.ok(result.includes('README: '));
  assert.ok(result.includes('Documentation: '));
  assert.ok(result.includes('Examples: '));
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  assert.ok(result.endsWith(`Current date: ${localDate}\nCurrent working directory: C:/work`));
  assert.ok(!result.includes(TRAVERSAL_POLICY_PROMPT), 'the approved base does not inject traversal prose');
  assert.ok(!result.includes('You are an expert coding assistant operating inside pi'));
});

test('shared builder preserves SDK append and context-file appendix semantics', async () => {
  const sdkPrompt = await loadSdkPrompt();
  const append = '# Personal additions\nKeep the response concise.';
  const context = { path: 'C:/work/AGENTS.md', content: 'Project rules.' };
  const result = buildPieSystemPrompt({
    cwd: 'C:/work',
    selectedTools: ['read'],
    toolSnippets: { read: 'Read files' },
    promptGuidelines: [],
    appendSystemPrompt: append,
    contextFiles: [context],
    skills: [{
      name: 'release-checks',
      description: 'Verify release changes.',
      filePath: 'C:/pie/skills/release-checks/SKILL.md',
      disableModelInvocation: false,
    }],
  }, sdkPrompt.buildSystemPrompt, 'C:/pie');

  assert.ok(result.includes(`\n\n${append}`));
  assert.ok(result.includes(`<project_instructions path="${context.path}">\n${context.content}`));
  assert.ok(result.includes('<available_skills>'));
  assert.ok(result.includes('<name>release-checks</name>'));
  assert.ok(result.endsWith('Current working directory: C:/work'));
});

test('explicit custom replacement is preserved even when it starts with the stock Pi introduction', async () => {
  const sdkPrompt = await loadSdkPrompt();
  const customPrompt = `${piIntro}\n\nProject-specific replacement.`;
  const options = {
    cwd: 'C:/work',
    customPrompt,
    selectedTools: ['read'],
    toolSnippets: { read: 'Read files' },
    promptGuidelines: [],
  };
  const expected = sdkPrompt.buildSystemPrompt(options);
  assert.equal(buildPieSystemPrompt(options, sdkPrompt.buildSystemPrompt, 'C:/pie'), expected);
  assert.equal(rewritePieBuiltSystemPrompt(expected, options, 'C:/pie'), expected);
});

test('parent-style rebuild wrapping rewrites the initial and later SDK prompts', async () => {
  const sdkPrompt = await loadSdkPrompt();
  const options = {
    cwd: 'C:/work',
    selectedTools: ['read'],
    toolSnippets: { read: 'Read files', bash: 'Run commands' },
    promptGuidelines: ['Use read carefully.'],
  };
  const state: any = {
    _baseSystemPromptOptions: options,
    _baseSystemPrompt: sdkPrompt.buildSystemPrompt(options),
    agent: { state: { systemPrompt: sdkPrompt.buildSystemPrompt(options) } },
    _rebuildSystemPrompt(toolNames: string[]) {
      const next = { ...options, selectedTools: toolNames };
      this._baseSystemPromptOptions = next;
      return sdkPrompt.buildSystemPrompt(next);
    },
  };

  installPieSystemPromptRebuildGuard(state, 'C:/pie');
  assert.match(state._baseSystemPrompt, /^You are a coding assistant operating inside Pie/);
  assert.equal(state.agent.state.systemPrompt, state._baseSystemPrompt);
  const rebuilt = state._rebuildSystemPrompt(['bash']);
  assert.match(rebuilt, /^You are a coding assistant operating inside Pie/);
  assert.match(rebuilt, /- bash: Run commands/u);
  assert.doesNotMatch(rebuilt, /- read: Read files/u);
});

test('real SDK rebuild guards and inspector share Pie ownership without losing dynamic sections', async () => {
  const sdkPrompt = await loadSdkPrompt();
  const append = '# Child role\nPreserve this agent body.';
  const context = { path: 'C:/work/AGENTS.md', content: 'Project rules.' };
  const skill = {
    name: 'release-checks',
    description: 'Verify release changes.',
    filePath: 'C:/pie/skills/release-checks/SKILL.md',
    baseDir: 'C:/pie/skills',
    sourceInfo: null,
    disableModelInvocation: false,
  };
  const options: PieSystemPromptOptions = {
    cwd: 'C:/work',
    selectedTools: ['read', 'bash'],
    toolSnippets: { read: 'Read files', bash: 'Run commands' },
    promptGuidelines: ['Dynamic guidance from the SDK.'],
    appendSystemPrompt: append,
    contextFiles: [context],
    skills: [skill],
  };
  const stockBuild = sdkPrompt.buildSystemPrompt;
  const stockPrompt = stockBuild(options);
  const state: any = {
    _baseSystemPromptOptions: options,
    _baseSystemPrompt: stockPrompt,
    agent: { state: { systemPrompt: stockPrompt } },
    _rebuildSystemPrompt(toolNames: string[]) {
      const next = { ...options, selectedTools: toolNames };
      this._baseSystemPromptOptions = next;
      return stockBuild(next);
    },
  };

  installPieSystemPromptRebuildGuard(state, 'C:/pie');
  assert.match(state._baseSystemPrompt, /^You are a coding assistant operating inside Pie/u);
  assert.equal(state.agent.state.systemPrompt, state._baseSystemPrompt);

  let disabled: string[] = [TOOLS_ENTRY_ID];
  installSystemPromptToggleRebuildGuard(
    state,
    () => disabled,
    (promptOptions) => buildPieSystemPrompt(promptOptions, stockBuild, 'C:/pie'),
  );
  const rebuild = (toolNames: string[]): string => {
    const prompt = state._rebuildSystemPrompt(toolNames);
    // AgentSession's setActiveToolsByName assigns these two fields from the
    // synchronous rebuild result; mirror that caller around the private seam.
    state._baseSystemPrompt = prompt;
    state.agent.state.systemPrompt = prompt;
    return prompt;
  };

  const toolsDisabled = rebuild(['read', 'bash']);
  assert.match(toolsDisabled, /^You are a coding assistant operating inside Pie/u);
  assert.doesNotMatch(toolsDisabled, /Available tools:/u);
  assert.match(toolsDisabled, /Dynamic guidance from the SDK\./u);

  disabled = [HARNESS_ENTRY_ID];
  const harnessDisabled = rebuild(['read', 'bash']);
  assert.doesNotMatch(harnessDisabled, /^You are a coding assistant operating inside Pie/u);
  assert.match(harnessDisabled, /Available tools:/u);
  assert.ok(harnessDisabled.includes(append));

  disabled = [];
  const restored = rebuild(['bash']);
  assert.match(restored, /^You are a coding assistant operating inside Pie/u);
  assert.match(restored, /- bash: Run commands/u);
  assert.doesNotMatch(restored, /- read: Read files/u);
  assert.ok(restored.includes(append));

  const inspector = buildSessionSystemPrompts({
    harnessPrompt: buildPieSystemPrompt(options, stockBuild, 'C:/pie'),
    promptOptions: options as any,
    formatSkillsForPrompt: (skills) => skills.map((entry) => entry.name).join('\n'),
    tools: [
      { name: 'read', description: 'Read files' },
      { name: 'bash', description: 'Run commands' },
    ],
  });
  const harnessEntry = inspector.find((entry) => entry.id === HARNESS_ENTRY_ID);
  assert.ok(harnessEntry);
  const expectedHarness = buildPieSystemPrompt(options, stockBuild, 'C:/pie')
    .replace(/\nCurrent date: [^\n]+\nCurrent working directory: [^\n]+$/u, '')
    .replace(/Available tools:\n[\s\S]*?\n(?=Tool guidance:\n)/u, '')
    .trim();
  assert.equal(harnessEntry.text, expectedHarness, 'inspector harness is the shared Pie prompt minus tool/runtime rows');
  assert.equal(inspector.find((entry) => entry.id === RUNTIME_ENTRY_ID)?.text,
    buildPieSystemPrompt(options, stockBuild, 'C:/pie').match(/Current date: [^\n]+\nCurrent working directory: [^\n]+$/u)?.[0]?.trim());
  assert.equal(inspector.find((entry) => entry.id === 'append')?.text, append);
  assert.match(inspector.find((entry) => entry.id === contextFileEntryId(context.path))?.text ?? '', /Project rules\./u);
  assert.equal(inspector.find((entry) => entry.id === 'skills')?.text, skill.name);
  assert.equal(inspector.find((entry) => entry.id === TOOLS_ENTRY_ID)?.summary, 'read, bash');
});

test('tool refresh supports a harness-disabled tools-only prompt and rejects unknown custom shapes', () => {
  const previous = 'Available tools:\n- read: Read files\n- web_search: Search the web\nCurrent date: 2026-07-13';
  const fresh = 'Available tools:\n- read: Read files\nCurrent date: 2026-07-13';
  const chained = `EARLIER PREFIX\n${previous}\nLATER SUFFIX`;
  assert.equal(
    rebasePieToolPrompt(chained, previous, fresh),
    `EARLIER PREFIX\n${fresh}\nLATER SUFFIX`,
  );
  assert.equal(
    rebasePieToolPrompt('Foreign custom replacement', 'Custom old', 'Custom fresh'),
    undefined,
  );
});

test('unknown or non-stock prompt shapes remain untouched', () => {
  const prompt = `${piIntro}\n\nAvailable tools:\n- read`;
  assert.equal(rewritePieBuiltSystemPrompt(prompt, { cwd: 'C:/work' }, 'C:/pie'), prompt);
});
