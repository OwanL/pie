import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { rewritePieHarnessPrompt } from '../../../shared/pie-harness-prompt.js';

const intro = 'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.';
const docs = `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: C:\\sdk\\README.md
- Additional docs: C:\\sdk\\docs
- Examples: C:\\sdk\\examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;

test('rewrites only the static identity and documentation while preserving dynamic sections', () => {
  const dynamic = `Available tools:
- read: Read file contents
- custom: Dynamically supplied tool

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
- Use read to examine files instead of cat
- Custom dynamic guideline`;
  const trailing = `# Guidelines

- Verify changes.

<project_context>project</project_context>
Current date: 2026-07-13
Current working directory: C:/work`;
  const input = `${intro}\n\n${dynamic}\n\n${docs}\n\n${trailing}`;

  const result = rewritePieHarnessPrompt(input, 'C:\\Users\\me\\pie\\');

  assert.match(result, /^You are a coding agent operating inside pie, an extended harness built on pi/);
  assert.ok(result.includes('Pie overview and docs index: C:/Users/me/pie/README.md; C:/Users/me/pie/docs/INDEX.md'));
  assert.ok(result.includes('Underlying pi: C:\\sdk\\README.md; docs: C:\\sdk\\docs; examples: C:\\sdk\\examples'));
  assert.ok(result.includes(dynamic));
  assert.ok(result.endsWith(trailing));
  assert.ok(!result.includes('You are an expert coding assistant operating inside pi'));
  assert.ok(!result.includes('When asked about: extensions'));
});

test('matches and rewrites the locked SDK harness template', async () => {
  const modulePath = path.join(
    process.cwd(),
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'core',
    'system-prompt.js',
  );
  const sdkPrompt = await import(pathToFileURL(modulePath).href) as {
    buildSystemPrompt(options: {
      cwd: string;
      selectedTools: string[];
      toolSnippets: Record<string, string>;
      promptGuidelines: string[];
    }): string;
  };
  const dynamicSnippet = 'Live SDK dynamic snippet';
  const dynamicGuideline = 'Live SDK dynamic guideline';
  const input = sdkPrompt.buildSystemPrompt({
    cwd: 'C:/work',
    selectedTools: ['read'],
    toolSnippets: { read: dynamicSnippet },
    promptGuidelines: [dynamicGuideline],
  });

  const result = rewritePieHarnessPrompt(input, 'C:/pie');

  assert.match(result, /^You are a coding agent operating inside pie/);
  assert.ok(result.includes(`- read: ${dynamicSnippet}`));
  assert.ok(result.includes(`- ${dynamicGuideline}`));
  assert.ok(result.includes('Pie overview and docs index: C:/pie/README.md; C:/pie/docs/INDEX.md'));
  assert.ok(!result.includes('Pi documentation (read only'));
});

test('leaves custom and unknown prompt shapes untouched', () => {
  const custom = 'You are a project-specific assistant.\n\nAvailable tools:\n- read';
  assert.equal(rewritePieHarnessPrompt(custom, 'C:\\pie'), custom);
});

test('still updates the identity if an upstream docs block is unavailable', () => {
  const input = `${intro}\n\nAvailable tools:\n(none)`;
  const result = rewritePieHarnessPrompt(input, '/opt/pie');

  assert.match(result, /^You are a coding agent operating inside pie/);
  assert.ok(result.endsWith('Available tools:\n(none)'));
});
