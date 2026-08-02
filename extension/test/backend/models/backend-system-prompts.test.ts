import assert from 'node:assert/strict';
import test from 'node:test';

import type { SdkBuildSystemPromptOptions, SdkSkill, SdkToolInfo } from '../../../src/backend/sdk';
import {
  APPEND_ENTRY_ID,
  HARNESS_ENTRY_ID,
  PROJECT_CONTEXT_ENTRY_ID,
  RUNTIME_ENTRY_ID,
  SKILLS_ENTRY_ID,
  TOOLS_ENTRY_ID,
  applySystemPromptTogglesToOptions,
  buildProviderSystemPrompt,
  buildSessionSystemPrompts,
  buildToggledSystemPrompt,
  captureOriginalSystemPromptOptions,
  contextFileEntryId,
  installAutonomousModeToolGuard,
  installSystemPromptToggleRebuildGuard,
  installSystemPromptToolToggleGuard,
  isSupersetSystemPromptOptions,
  markDisabledEntries,
  stripDisabledSectionsFromPrompt,
} from '../../../src/backend/system-prompts';

function makeSkill(name: string): SdkSkill {
  return {
    name,
    description: `${name} description`,
    filePath: `/repo/skills/${name}/SKILL.md`,
    baseDir: '/repo/skills',
    sourceInfo: null,
    disableModelInvocation: false,
  };
}

test('buildSessionSystemPrompts mirrors the actual model-context order for a custom prompt session', () => {
  const promptOptions: SdkBuildSystemPromptOptions = {
    cwd: '/repo',
    customPrompt: 'Custom instructions',
    appendSystemPrompt: 'Append instructions',
    contextFiles: [
      { path: '/repo/AGENTS.md', content: 'Repo rules' },
      { path: '/home/user/.pi/agent/AGENTS.md', content: 'Global rules' },
    ],
    skills: [makeSkill('design-system'), makeSkill('frontend-design')],
  };

  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions,
    formatSkillsForPrompt: (skills) => skills.map((skill) => skill.name).join('\n'),
  });

  assert.deepEqual(
    prompts.map((prompt) => prompt.title),
    [
      'Provider system prompt',
      'Custom system prompt',
      'Appended system prompt',
      'Project Context',
      'repo/AGENTS.md',
      'agent/AGENTS.md',
      'Skills',
      'Current date / working directory',
    ],
  );

  assert.equal(prompts[1]?.text, 'Custom instructions');
  assert.equal(prompts[2]?.text, 'Append instructions');
  assert.equal(prompts[3]?.text, '# Project Context\n\nProject-specific instructions and guidelines:');
  assert.equal(prompts[4]?.tooltip, '/repo/AGENTS.md');
  assert.equal(prompts[4]?.text, '## repo/AGENTS.md\n\nRepo rules');
  assert.equal(prompts[5]?.tooltip, '/home/user/.pi/agent/AGENTS.md');
  assert.equal(prompts[5]?.text, '## agent/AGENTS.md\n\nGlobal rules');
  assert.equal(prompts[6]?.summary, 'design-system, frontend-design');
  assert.match(prompts[7]?.text ?? '', /^Current date: \d{4}-\d{2}-\d{2}\nCurrent working directory: \/repo$/);
});

test('buildSessionSystemPrompts deduplicates project context files that differ only by Windows path casing', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: d:/Projects/StandAloneProjects/pi-config',
    promptOptions: {
      cwd: 'd:/Projects/StandAloneProjects/pi-config',
      contextFiles: [
        {
          path: 'D:\\Projects\\StandAloneProjects\\pi-config\\AGENTS.md',
          content: 'Repo rules',
        },
        {
          path: 'd:/Projects/StandAloneProjects/pi-config/AGENTS.md',
          content: 'Duplicate repo rules',
        },
      ],
      skills: [],
    },
    formatSkillsForPrompt: () => '',
  });

  assert.deepEqual(
    prompts.map((prompt) => prompt.title),
    [
      'Provider system prompt',
      'Harness system prompt',
      'Project Context',
      'pi-config/AGENTS.md',
      'Current date / working directory',
    ],
  );
  assert.equal(prompts[3]?.tooltip, 'D:/Projects/StandAloneProjects/pi-config/AGENTS.md');
  assert.equal(prompts[3]?.text, '## pi-config/AGENTS.md\n\nRepo rules');
});

test('buildSessionSystemPrompts keeps the harness prompt as the main system section when no custom prompt is configured', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: {
      cwd: '/repo',
      appendSystemPrompt: '   ',
      contextFiles: [{ path: '/repo/AGENTS.md', content: '   ' }],
      skills: [],
    },
    formatSkillsForPrompt: () => '',
  });

  assert.deepEqual(
    prompts.map((prompt) => ({ title: prompt.title, availability: prompt.availability })),
    [
      { title: 'Provider system prompt', availability: 'unknown' },
      { title: 'Harness system prompt', availability: 'available' },
      { title: 'Current date / working directory', availability: 'available' },
    ],
  );

  assert.equal(prompts[1]?.text, 'Harness instructions');
  assert.equal(prompts[2]?.text, 'Current date: 2026-05-13\nCurrent working directory: /repo');
});

test('buildSessionSystemPrompts matches Pi skill inclusion rules when read is unavailable', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: {
      cwd: '/repo',
      selectedTools: ['bash'],
      skills: [makeSkill('frontend-design')],
    },
    formatSkillsForPrompt: (skills) => skills.map((skill) => skill.name).join('\n'),
  });

  assert.ok(!prompts.some((prompt) => prompt.title === 'Skills'));
});

test('buildSessionSystemPrompts includes a Tools entry when tools are provided', () => {
  const tools: SdkToolInfo[] = [
    { name: 'read', description: 'Read file contents' },
    { name: 'subagent', description: 'Delegate tasks to specialized subagents', parameters: { type: 'object', properties: { agent: { type: 'string' } } } },
  ];

  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    formatSkillsForPrompt: () => '',
    tools,
  });

  const toolEntry = prompts.find((p) => p.title === 'Tools');
  assert.ok(toolEntry, 'Tools entry should exist');
  assert.equal(toolEntry.source, 'harness');
  assert.equal(toolEntry.availability, 'available');
  assert.equal(toolEntry.summary, 'read, subagent');
  assert.match(toolEntry.text, /## read/);
  assert.match(toolEntry.text, /## subagent/);
  assert.match(toolEntry.text, /Read file contents/);
  assert.match(toolEntry.text, /Delegate tasks/);
  assert.match(toolEntry.text, /"agent"/);
});

test('buildSessionSystemPrompts omits Tools entry when tools array is empty', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    formatSkillsForPrompt: () => '',
    tools: [],
  });

  assert.ok(!prompts.some((p) => p.title === 'Tools'));
});

test('buildSessionSystemPrompts truncates long tool summary', () => {
  const tools: SdkToolInfo[] = Array.from({ length: 20 }, (_, i) => ({
    name: `tool_with_long_name_${i}`,
    description: `Description ${i}`,
  }));

  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    formatSkillsForPrompt: () => '',
    tools,
  });

  const toolEntry = prompts.find((p) => p.title === 'Tools');
  assert.ok(toolEntry);
  assert.ok(toolEntry.summary.length <= 83); // 80 + '...'
  assert.ok(toolEntry.summary.endsWith('...'));
});

test('buildProviderSystemPrompt names the active provider/model instead of hardcoding GitHub Copilot', () => {
  const entry = buildProviderSystemPrompt({ provider: 'umans', modelId: 'umans-glm-5.2', modelName: 'GLM 5.2' });

  assert.equal(entry.source, 'provider');
  assert.equal(entry.title, 'Provider system prompt');
  assert.equal(entry.availability, 'unknown');
  assert.equal(entry.summary, 'umans');
  assert.ok(!/GitHub Copilot provider prompt is not exposed/.test(entry.text), 'must not carry the stale hardcoded Copilot text');
  assert.match(entry.text, /umans/);
  assert.match(entry.text, /GLM 5\.2/);
});

test('buildProviderSystemPrompt falls back to a neutral unresolved state when no model is selected', () => {
  const entry = buildProviderSystemPrompt(undefined);

  assert.equal(entry.title, 'Provider system prompt');
  assert.equal(entry.availability, 'unknown');
  assert.equal(entry.summary, 'Unknown');
  assert.ok(!/GitHub Copilot/.test(entry.text), 'fallback must not assume a specific provider');
  assert.match(entry.text, /No active model has been selected/);
});

test('buildProviderSystemPrompt marks the card as non-toggleable (display-only)', () => {
  // The provider's own system prompt is injected server-side and cannot be
  // removed by pi, so the card must never offer a toggle in either state.
  assert.equal(buildProviderSystemPrompt({ provider: 'umans', modelId: 'umans-glm-5.2', modelName: 'GLM 5.2' }).toggleable, false);
  assert.equal(buildProviderSystemPrompt(undefined).toggleable, false);
});

test('markDisabledEntries never disables a non-toggleable entry, even when its id is in the set', () => {
  // Self-heal for sidecars persisted before the provider card became
  // non-toggleable: a stale `'provider'` in the disabled set must not hide the
  // informational card from the transcript.
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-01-01\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    disabledEntries: ['provider', HARNESS_ENTRY_ID],
  });
  const provider = prompts.find((p) => p.id === 'provider')!;
  const harness = prompts.find((p) => p.id === HARNESS_ENTRY_ID)!;
  assert.equal(provider.disabled, undefined, 'provider card stays visible');
  assert.equal(harness.disabled, true, 'toggleable entries still disable normally');
});

test('buildSessionSystemPrompts threads the active provider into the provider entry', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    formatSkillsForPrompt: () => '',
    activeProvider: { provider: 'anthropic', modelId: 'claude-3-5-sonnet' },
  });

  const provider = prompts[0];
  assert.equal(provider.title, 'Provider system prompt');
  assert.equal(provider.summary, 'anthropic');
  assert.match(provider.text, /anthropic/);
  assert.match(provider.text, /claude-3-5-sonnet/);
});

test('buildSessionSystemPrompts stamps a stable id on every entry', () => {
  const promptOptions: SdkBuildSystemPromptOptions = {
    cwd: '/repo',
    appendSystemPrompt: '# Appended\nextra',
    contextFiles: [{ path: '/repo/AGENTS.md', content: 'rules' }],
    skills: [makeSkill('frontend-design')],
  };
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-01-01\nCurrent working directory: /repo',
    promptOptions,
    formatSkillsForPrompt: (skills) => skills.map((s) => s.name).join('\n'),
  });
  assert.deepEqual(
    prompts.map((p) => p.id),
    ['provider', HARNESS_ENTRY_ID, APPEND_ENTRY_ID, PROJECT_CONTEXT_ENTRY_ID, contextFileEntryId('/repo/AGENTS.md'), SKILLS_ENTRY_ID, RUNTIME_ENTRY_ID],
  );
  // No entry is disabled by default.
  assert.ok(prompts.every((p) => !p.disabled));
});

test('buildSessionSystemPrompts marks disabled entries when disabledEntries is provided', () => {
  const promptOptions: SdkBuildSystemPromptOptions = {
    cwd: '/repo',
    contextFiles: [{ path: '/repo/AGENTS.md', content: 'rules' }],
  };
  const disabled = [HARNESS_ENTRY_ID, contextFileEntryId('/repo/AGENTS.md')];
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-01-01\nCurrent working directory: /repo',
    promptOptions,
    disabledEntries: disabled,
  });
  const harness = prompts.find((p) => p.id === HARNESS_ENTRY_ID)!;
  const file = prompts.find((p) => p.id === contextFileEntryId('/repo/AGENTS.md'))!;
  const runtime = prompts.find((p) => p.id === RUNTIME_ENTRY_ID)!;
  assert.equal(harness.disabled, true);
  assert.equal(file.disabled, true);
  assert.equal(runtime.disabled, undefined);
});

test('applySystemPromptTogglesToOptions drops option-driven disabled sections', () => {
  const options: SdkBuildSystemPromptOptions = {
    cwd: '/repo',
    appendSystemPrompt: '# Appended\nextra',
    contextFiles: [{ path: '/repo/AGENTS.md', content: 'rules' }, { path: '/repo/other.md', content: 'more' }],
    skills: [makeSkill('frontend-design')],
  };
  const disabled = new Set([APPEND_ENTRY_ID, SKILLS_ENTRY_ID, contextFileEntryId('/repo/AGENTS.md')]);
  const filtered = applySystemPromptTogglesToOptions(options, disabled);
  assert.equal(filtered.appendSystemPrompt, undefined);
  assert.deepEqual(filtered.skills, []);
  assert.deepEqual(
    filtered.contextFiles!.map((c) => c.path),
    ['/repo/other.md'],
  );
  // customPrompt is intentionally NOT cleared (cleared would re-add the harness).
  assert.equal(filtered.customPrompt, options.customPrompt);
});

test('stripDisabledSectionsFromPrompt removes the harness prefix, tools block, and runtime trailer', () => {
  const harnessPrefix =
    'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.\n\n' +
    'Available tools:\n- read: read files\n- bash: run commands\n\n' +
    'In addition to the tools above, you may have access to other custom tools depending on the project.\n\n' +
    'Guidelines:\n- Be concise in your responses\n';
  const full =
    harnessPrefix +
    '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\nrules\n</project_instructions>\n\n</project_context>\n' +
    '\nCurrent date: 2026-01-01\nCurrent working directory: /repo';

  // Disable everything option-driven can't express: harness, tools, runtime.
  const disabled = new Set([HARNESS_ENTRY_ID, TOOLS_ENTRY_ID, RUNTIME_ENTRY_ID]);
  const stripped = stripDisabledSectionsFromPrompt(full, disabled, undefined, harnessPrefix);
  assert.ok(!stripped.startsWith('You are an expert'));
  assert.ok(!stripped.includes('Available tools'));
  assert.ok(!stripped.includes('Current date:'));
  // Project context (not disabled) survives.
  assert.ok(stripped.includes('<project_instructions'));
});

test('stripDisabledSectionsFromPrompt strips the custom prompt prefix when customPrompt is set', () => {
  const custom = 'You are a custom assistant.';
  const full = custom + '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n</project_context>\n\nCurrent date: 2026-01-01\nCurrent working directory: /repo';
  const disabled = new Set(['custom']);
  const stripped = stripDisabledSectionsFromPrompt(full, disabled, custom, undefined);
  assert.ok(!stripped.startsWith('You are a custom'));
  // Runtime (not disabled) survives.
  assert.ok(stripped.includes('Current date:'));
});

test('disabling the harness alone preserves the independently enabled tools block', () => {
  const toolsBlock =
    'Available tools:\n- read: read files\n\n' +
    'In addition to the tools above, you may have access to other custom tools depending on the project.\n\n';
  const harnessPrefix = `Harness core\n\n${toolsBlock}Guidelines`;
  const stripped = stripDisabledSectionsFromPrompt(
    `${harnessPrefix}\nCurrent date: 2026-01-01\nCurrent working directory: /repo`,
    new Set([HARNESS_ENTRY_ID]),
    undefined,
    harnessPrefix,
  );

  assert.ok(!stripped.includes('Harness core'));
  assert.ok(!stripped.includes('Guidelines'));
  assert.match(stripped, /Available tools:/);
  assert.match(stripped, /Current date:/);
});

test('disabling only the project-context prelude unwraps enabled context files', () => {
  const full =
    'Harness\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n' +
    '<project_instructions path="/repo/AGENTS.md">\nrules\n</project_instructions>\n\n' +
    '</project_context>\n\nCurrent date: 2026-01-01\nCurrent working directory: /repo';
  const stripped = stripDisabledSectionsFromPrompt(
    full,
    new Set([PROJECT_CONTEXT_ENTRY_ID]),
    undefined,
    undefined,
  );

  assert.ok(!stripped.includes('<project_context>'));
  assert.ok(!stripped.includes('</project_context>'));
  assert.ok(!stripped.includes('Project-specific instructions and guidelines:'));
  assert.match(stripped, /<project_instructions path="\/repo\/AGENTS\.md">/);
  assert.match(stripped, /Current date:/);
});

test('runtime can be removed after another toggle moves it to the start', () => {
  const runtime = 'Current date: 2026-01-01\nCurrent working directory: /repo';
  assert.equal(
    stripDisabledSectionsFromPrompt(runtime, new Set([RUNTIME_ENTRY_ID]), undefined, undefined),
    '',
  );
});

function buildTestSdkPrompt(options: SdkBuildSystemPromptOptions): string {
  const toolsBlock =
    'Available tools:\n- read: read files\n\n' +
    'In addition to the tools above, you may have access to other custom tools depending on the project.\n\n';
  let prompt = `Harness core\n\n${toolsBlock}Guidelines`;
  if (options.appendSystemPrompt) prompt += `\n\n${options.appendSystemPrompt}`;
  if ((options.contextFiles?.length ?? 0) > 0) {
    prompt += '\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n';
    for (const file of options.contextFiles ?? []) {
      prompt += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
    }
    prompt += '</project_context>\n';
  }
  if ((options.skills?.length ?? 0) > 0) prompt += '\n<skills>loaded</skills>';
  prompt += '\nCurrent date: 2026-01-01\nCurrent working directory: /repo';
  return prompt;
}

test('buildToggledSystemPrompt permits a truly empty prompt when every entry is disabled', () => {
  const source = fullOptions();
  source.selectedTools = ['read'];
  source.toolSnippets = { read: 'read files' };
  const disabled = [
    HARNESS_ENTRY_ID,
    TOOLS_ENTRY_ID,
    APPEND_ENTRY_ID,
    PROJECT_CONTEXT_ENTRY_ID,
    ...source.contextFiles!.map((file) => contextFileEntryId(file.path)),
    SKILLS_ENTRY_ID,
    RUNTIME_ENTRY_ID,
  ];

  const toggled = buildToggledSystemPrompt(source, disabled, buildTestSdkPrompt);
  assert.equal(toggled.prompt, '');
  assert.equal(toggled.options.appendSystemPrompt, undefined);
  assert.deepEqual(toggled.options.contextFiles, []);
  assert.deepEqual(toggled.options.skills, []);
});

test('Tools toggle guard prevents extensions from re-exposing provider schemas', () => {
  let disabled: string[] = [TOOLS_ENTRY_ID];
  const applied: string[][] = [];
  const session = {
    setActiveToolsByName(names: string[]) { applied.push(names); },
  };

  installSystemPromptToolToggleGuard(session, () => disabled);
  session.setActiveToolsByName(['read', 'bash']);
  assert.deepEqual(applied, [[]]);

  disabled = [];
  session.setActiveToolsByName(['read', 'bash']);
  assert.deepEqual(applied, [[], ['read', 'bash']]);
});

test('Autonomous mode guard prevents extensions from re-enabling ask_user', () => {
  let autonomousMode = true;
  const applied: string[][] = [];
  const session = {
    setActiveToolsByName(names: string[]) { applied.push(names); },
  };

  installAutonomousModeToolGuard(session, () => autonomousMode);
  session.setActiveToolsByName(['read', 'ask_user', 'bash']);
  assert.deepEqual(applied, [['read', 'bash']]);

  autonomousMode = false;
  session.setActiveToolsByName(['read', 'ask_user', 'bash']);
  assert.deepEqual(applied.at(-1), ['read', 'ask_user', 'bash']);
});

test('Skills row remains toggleable while all tools are manually disabled', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-01-01\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', selectedTools: [], skills: [makeSkill('frontend-design')] },
    formatSkillsForPrompt: (skills) => skills.map((skill) => skill.name).join('\n'),
    disabledEntries: [TOOLS_ENTRY_ID],
  });
  assert.ok(prompts.some((prompt) => prompt.id === SKILLS_ENTRY_ID));
});

test('system-prompt exclusions survive synchronous SDK prompt rebuilds', () => {
  let disabled: string[] = [SKILLS_ENTRY_ID, contextFileEntryId('/repo/AGENTS.md')];
  const state: {
    _baseSystemPromptOptions?: SdkBuildSystemPromptOptions;
    _originalSystemPromptOptions?: SdkBuildSystemPromptOptions;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  } = {
    _rebuildSystemPrompt(toolNames) {
      const options = fullOptions();
      options.selectedTools = toolNames;
      this._baseSystemPromptOptions = options;
      return buildTestSdkPrompt(options);
    },
  };

  installSystemPromptToggleRebuildGuard(state, () => disabled, buildTestSdkPrompt);
  const filtered = state._rebuildSystemPrompt!(['read']);
  assert.doesNotMatch(filtered, /<skills>/);
  assert.doesNotMatch(filtered, /AGENTS\.md/);
  assert.match(filtered, /other\.md/);

  disabled = [];
  const restored = state._rebuildSystemPrompt!(['read']);
  assert.match(restored, /<skills>/);
  assert.match(restored, /AGENTS\.md/);
});

test('markDisabledEntries sets disabled only on matching ids', () => {
  const entries = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-01-01\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', appendSystemPrompt: '# Appended' },
  });
  const marked = markDisabledEntries(entries, new Set([APPEND_ENTRY_ID]));
  assert.equal(marked.find((p) => p.id === APPEND_ENTRY_ID)?.disabled, true);
  assert.equal(marked.find((p) => p.id === HARNESS_ENTRY_ID)?.disabled, undefined);
  // The non-toggleable provider card is never marked disabled.
  assert.equal(marked.find((p) => p.id === 'provider')?.disabled, undefined);
});

// ─── Display snapshot for disabled option-driven entries ───────────────────
// Regression: `applySystemPromptTogglesToBasePrompt` filters the live
// `_baseSystemPromptOptions` (removing disabled context files / skills /
// append) for the model prompt. The display entry list is built from a
// separate unfiltered snapshot so a de-selected row stays present (and
// re-toggleable) instead of disappearing.

function fullOptions(): SdkBuildSystemPromptOptions {
  return {
    cwd: '/repo',
    appendSystemPrompt: '# Appended',
    contextFiles: [
      { path: '/repo/AGENTS.md', content: 'rules' },
      { path: '/repo/other.md', content: 'more' },
    ],
    skills: [makeSkill('frontend-design')],
  };
}

test('isSupersetSystemPromptOptions is true when current has every cached entry', () => {
  const cached = fullOptions();
  // Identical -> superset.
  assert.equal(isSupersetSystemPromptOptions(fullOptions(), cached), true);
  // Current adds a file -> still a superset.
  const withExtra = fullOptions();
  withExtra.contextFiles = [
    ...(withExtra.contextFiles ?? []),
    { path: '/repo/extra.md', content: 'x' },
  ];
  assert.equal(isSupersetSystemPromptOptions(withExtra, cached), true);
});

test('isSupersetSystemPromptOptions is false when current dropped a cached entry (filtered)', () => {
  const cached = fullOptions();
  // Simulate `applySystemPromptTogglesToOptions` removing one context file.
  const filtered = applySystemPromptTogglesToOptions(
    fullOptions(),
    new Set([contextFileEntryId('/repo/AGENTS.md')]),
  );
  assert.equal(isSupersetSystemPromptOptions(filtered, cached), false);
  // Skills removed too.
  const filteredSkills = applySystemPromptTogglesToOptions(
    fullOptions(),
    new Set([SKILLS_ENTRY_ID]),
  );
  assert.equal(isSupersetSystemPromptOptions(filteredSkills, cached), false);
  // Append removed.
  const filteredAppend = applySystemPromptTogglesToOptions(
    fullOptions(),
    new Set([APPEND_ENTRY_ID]),
  );
  assert.equal(isSupersetSystemPromptOptions(filteredAppend, cached), false);
});

test('captureOriginalSystemPromptOptions snapshots the live options on first call', () => {
  const state: { _baseSystemPromptOptions?: SdkBuildSystemPromptOptions; _originalSystemPromptOptions?: SdkBuildSystemPromptOptions } = {
    _baseSystemPromptOptions: fullOptions(),
  };
  captureOriginalSystemPromptOptions(state);
  assert.deepEqual(
    state._originalSystemPromptOptions?.contextFiles?.map((c) => c.path),
    ['/repo/AGENTS.md', '/repo/other.md'],
  );
});

test('captureOriginalSystemPromptOptions does NOT clobber the snapshot with filtered options', () => {
  // The core regression guard: after a toggle filters the live options, the
  // snapshot must retain the full entry set so the disabled row is still built.
  const state: { _baseSystemPromptOptions?: SdkBuildSystemPromptOptions; _originalSystemPromptOptions?: SdkBuildSystemPromptOptions } = {
    _baseSystemPromptOptions: fullOptions(),
  };
  captureOriginalSystemPromptOptions(state); // captures full set

  // Simulate a toggle removing AGENTS.md from the live options.
  state._baseSystemPromptOptions = applySystemPromptTogglesToOptions(
    fullOptions(),
    new Set([contextFileEntryId('/repo/AGENTS.md')]),
  );
  captureOriginalSystemPromptOptions(state); // must NOT overwrite the snapshot

  assert.deepEqual(
    state._originalSystemPromptOptions?.contextFiles?.map((c) => c.path),
    ['/repo/AGENTS.md', '/repo/other.md'],
    'snapshot keeps the disabled file so its row stays in the picker',
  );
});

test('captureOriginalSystemPromptOptions refreshes when the SDK rebuilds a fuller set', () => {
  const state: { _baseSystemPromptOptions?: SdkBuildSystemPromptOptions; _originalSystemPromptOptions?: SdkBuildSystemPromptOptions } = {
    _baseSystemPromptOptions: fullOptions(),
  };
  captureOriginalSystemPromptOptions(state);

  // SDK rebuild adds a new context file (e.g. an extension contributed one).
  const rebuilt = fullOptions();
  rebuilt.contextFiles = [
    ...(rebuilt.contextFiles ?? []),
    { path: '/repo/new.md', content: 'new' },
  ];
  state._baseSystemPromptOptions = rebuilt;
  captureOriginalSystemPromptOptions(state); // superset -> refresh

  assert.deepEqual(
    state._originalSystemPromptOptions?.contextFiles?.map((c) => c.path),
    ['/repo/AGENTS.md', '/repo/other.md', '/repo/new.md'],
    'snapshot picks up newly-added entries',
  );
});

test('building display entries from the snapshot keeps a disabled context-file row present', () => {
  // End-to-end of the fix at the system-prompts layer: build entries from the
  // unfiltered snapshot and mark the disabled entry, instead of from filtered
  // options where it would be absent.
  const snapshot = fullOptions();
  const disabledFileId = contextFileEntryId('/repo/AGENTS.md');
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-01-01\nCurrent working directory: /repo',
    promptOptions: snapshot,
    disabledEntries: [disabledFileId],
  });
  const file = prompts.find((p) => p.id === disabledFileId)!;
  assert.ok(file, 'disabled context-file row is still built from the snapshot');
  assert.equal(file.disabled, true, 'and marked disabled so the picker shows it unchecked');
});

test('building display entries from filtered options drops the disabled row (the bug this fixes)', () => {
  // Demonstrates the failure mode the snapshot guards against: if the display
  // were built from the filtered live options, the disabled row would vanish.
  const filtered = applySystemPromptTogglesToOptions(
    fullOptions(),
    new Set([contextFileEntryId('/repo/AGENTS.md')]),
  );
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-01-01\nCurrent working directory: /repo',
    promptOptions: filtered,
  });
  assert.ok(!prompts.some((p) => p.id === contextFileEntryId('/repo/AGENTS.md')));
});

