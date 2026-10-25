import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import { test, expect } from './ui-smoke-fixtures.js';

const sessionPath = '/tmp/ui-smoke-system-instructions.jsonl';
const secondSessionPath = '/tmp/ui-smoke-system-instructions-other.jsonl';
const session = (path: string) => ({ path, name: 'System instructions fixture', cwd: '/tmp', modifiedAt: '2026-10-25T00:00:00.000Z', messageCount: 0 });

const prompts = [
  { source: 'provider', id: 'provider', title: 'Provider instructions', text: 'Provider-owned hidden text.', summary: 'Unknown provider prompt', availability: 'unknown', toggleable: false },
  { source: 'harness', id: 'harness-main', title: 'Harness instructions', text: '# Workspace rules\n\n- Keep changes focused.\n- Read [the guide](https://example.test/guide).', summary: 'Workspace guidance', availability: 'available' },
  { source: 'user', id: 'append-system', title: 'APPEND_SYSTEM.md', text: 'Append **user guidance** here.', summary: 'User additions', availability: 'available' },
  { source: 'harness', id: 'agents', title: 'AGENTS.md', tooltip: 'C:\\dev\\AGENTS.md', text: `# Agent operating guide

This file applies to everything under \`C:\\dev\`.

## Directory contract

- \`repos\\\`: Git repositories and repository worktrees.
- \`data\\\`: Durable local development data that does not belong in a repository.
- \`scratch\\\`: Disposable build experiments, downloads, and generated artifacts.

## Working rules

- Follow the local project conventions.
- Keep each repository’s instructions in its own \`AGENTS.md\`.
- Use ordinary branches in the primary checkout; do not create or use Git worktrees.
- Keep temporary artifacts outside source trees.
- Treat \`data\\\` as durable and potentially irreplaceable.`, summary: 'Agent operating guide', availability: 'available' },
  { source: 'harness', id: 'tools', title: 'Tool schemas', text: 'schema-marker: fixture_tool({ value: string })', summary: 'Available tool definitions', availability: 'available' },
  { source: 'harness', id: 'skills', title: 'Skills', text: 'Skill instruction marker.', summary: 'Loaded skills', availability: 'available' },
  { source: 'harness', id: 'runtime', title: 'Runtime instructions', text: 'Runtime prompt marker.', summary: 'Runtime guidance', availability: 'available' },
  { source: 'harness', id: 'missing', title: 'Unavailable source', text: 'Must not appear in resolved preview.', summary: 'Missing source', availability: 'missing' },
  { source: 'harness', id: 'disabled', title: 'Disabled source', text: 'Must also not appear in resolved preview.', summary: 'Disabled source', availability: 'available', disabled: true },
] as const;

const testSession = session(sessionPath);
test.use({ viewState: {
  backendReady: true,
  workspaceCwd: '/tmp',
  systemPrompts: [...prompts],
  sessions: [testSession],
  openTabPaths: [sessionPath],
  activeSession: testSession,
  modelSettings: { defaultModel: 'fixture-model', defaultProvider: 'fixture', defaultThinkingLevel: 'medium' },
} });

async function openInstructions(page: import('@playwright/test').Page) {
  const direct = page.getByRole('button', { name: 'System instructions', exact: true });
  if (await direct.isVisible()) {
    await direct.click();
  } else {
    await page.getByRole('button', { name: 'More composer options' }).click();
    await page.getByRole('button', { name: 'System instructions', exact: true }).click();
  }
  return page.getByRole('dialog', { name: 'System instructions' });
}

async function captureScreenshot(page: import('@playwright/test').Page, testInfo: import('@playwright/test').TestInfo, name: string) {
  const directory = process.env.PIE_INSTRUCTIONS_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}-${testInfo.workerIndex}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await testInfo.attach(name, { path: file, contentType: 'image/png' });
}

test('system instructions dialog fits desktop and narrow composer layouts', async ({ page }, testInfo) => {
  for (const viewport of [{ width: 1440, height: 1000, label: 'desktop' }, { width: 390, height: 844, label: 'narrow' }, { width: 320, height: 480, label: 'short' }]) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('/');
    const overflowPopover = page.locator('.composer-toolbar-overflow-popover');
    const overflowWasMounted = await overflowPopover.count() > 0;
    const dialog = await openInstructions(page);
    await expect(page.locator('.system-prompts')).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeLessThanOrEqual(520);
    const list = dialog.locator('.system-instructions-list');
    const preview = dialog.locator('.system-instructions-preview').first();
    const listBounds = await list.boundingBox();
    const previewBounds = await preview.boundingBox();
    expect(listBounds!.y + listBounds!.height).toBeLessThanOrEqual(previewBounds!.y + 1);
    expect(previewBounds!.height, 'selected source keeps readable space even in a short sidebar').toBeGreaterThan(100);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Apply changes' })).toBeInViewport();
    await dialog.getByRole('button', { name: 'AGENTS.md', exact: true }).click();
    await expect(dialog.locator('.system-instructions-document h1')).toHaveText('Agent operating guide');
    await captureScreenshot(page, testInfo, `system-instructions-${viewport.label}`);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'System instructions', exact: true }).first()).toBeFocused();
    if (overflowWasMounted) await expect(overflowPopover).toBeAttached();
  }
});

test('source preview and resolved preview exclude hidden inputs; edits send only on Apply', async ({ page }, testInfo) => {
  const commands: Record<string, unknown>[] = [];
  await page.routeWebSocket('**/*', socket => {
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type === 'setSystemPromptToggles') commands.push(message);
      server.send(raw);
    });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const dialog = await openInstructions(page);
  await dialog.getByRole('button', { name: 'Harness instructions' }).click();
  const sourcePreview = dialog.locator('.system-instructions-preview');
  await expect(sourcePreview.locator('h1')).toHaveText('Workspace rules');
  await expect(sourcePreview.locator('li').first()).toContainText('Keep changes focused.');
  await expect(sourcePreview.getByRole('link', { name: 'the guide' })).toHaveAttribute('href', 'https://example.test/guide');
  await dialog.getByRole('button', { name: 'AGENTS.md' }).click();
  await expect(sourcePreview).toContainText('local project conventions');
  const agentsCheckbox = dialog.getByRole('checkbox', { name: 'Include AGENTS.md' });
  await agentsCheckbox.uncheck();
  expect(commands).toHaveLength(0);
  await dialog.getByRole('tab', { name: 'Resolved preview' }).click();
  const resolved = dialog.getByRole('tabpanel', { name: 'Resolved preview' });
  await expect(resolved).toContainText('Workspace rules');
  await expect(resolved).toContainText('APPEND_SYSTEM.md');
  await expect(resolved).toContainText('Tool definitions · separate from system message');
  await expect(resolved).toContainText('schema-marker: fixture_tool');
  await expect(resolved).not.toContainText('Provider instructions');
  await expect(resolved).not.toContainText('Must not appear');
  await expect(resolved.getByRole('button', { name: 'Copy' })).toBeVisible();
  await captureScreenshot(page, testInfo, 'system-instructions-resolved');
  await dialog.getByRole('tab', { name: 'Sources', exact: true }).click();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(commands).toHaveLength(0);

  const applied = await openInstructions(page);
  await applied.getByRole('checkbox', { name: 'Include AGENTS.md' }).uncheck();
  expect(commands).toHaveLength(0);
  await applied.getByRole('button', { name: 'Apply changes' }).click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({ type: 'setSystemPromptToggles', sessionPath, disabledEntries: ['agents', 'disabled'] });
});

test('switching session closes instructions and discards the draft', async ({ page, isolatedHost }) => {
  const commands: Record<string, unknown>[] = [];
  await page.routeWebSocket('**/*', socket => {
    const server = socket.connectToServer();
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (message.type === 'setSystemPromptToggles') commands.push(message);
      server.send(raw);
    });
  });
  await page.goto('/');
  const dialog = await openInstructions(page);
  await dialog.getByRole('checkbox', { name: 'Include APPEND_SYSTEM.md' }).uncheck();
  isolatedHost.publishState({
    sessions: [testSession, session(secondSessionPath)],
    openTabPaths: [sessionPath, secondSessionPath],
    activeSession: session(secondSessionPath),
  });
  await expect(dialog).toHaveCount(0);
  expect(commands).toHaveLength(0);
  const reopened = await openInstructions(page);
  await expect(reopened.getByRole('checkbox', { name: 'Include APPEND_SYSTEM.md' })).toBeChecked();
  expect(commands).toHaveLength(0);
});
