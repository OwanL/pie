// Playwright-only spec; the .pw.ts suffix keeps it out of pie's node:test discovery.
import { expect, test, type Locator } from '@playwright/test';

const configureProviderGate = process.env.npm_lifecycle_event === 'test:browser:configure-provider-gate';
const allowedProviders = new Set(['ollama', 'openai-codex']);

async function setCheckbox(checkbox: Locator, checked: boolean): Promise<void> {
  await expect(checkbox).toBeVisible();
  const current = await checkbox.getAttribute('aria-checked');
  if ((current === 'true') !== checked) await checkbox.click();
  await expect(checkbox).toHaveAttribute('aria-checked', String(checked));
}

test.describe('pie live provider safety configuration', () => {
  test.skip(!configureProviderGate, 'Run npm run test:browser:configure-provider-gate; this test updates pie preferences.');

  test('fails closed to Ollama DeepSeek for root and child calls', async ({ page }) => {
    await page.goto('/');
    const composer = page.getByRole('textbox', { name: 'Message composer' });
    await expect(composer).toBeEditable();

    const model = page.getByRole('button', { name: 'Model' });
    await expect(model).toContainText('DeepSeek V4 Flash 0731');
    await model.click();
    const selectedModel = page.getByRole('option', { selected: true });
    await expect(selectedModel).toContainText('DeepSeek V4 Flash 0731');
    await expect(selectedModel).toHaveAttribute('id', /ollama-deepseek-v4-flash:0731-cloud/u);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Reasoning level' })).toContainText('Max');

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('tab', { name: 'Providers' }).click();
    const panel = dialog.getByRole('tabpanel');
    const providerCheckboxes = panel.getByRole('checkbox');
    const providerCount = await providerCheckboxes.count();
    expect(providerCount).toBeGreaterThan(0);

    for (let index = 0; index < providerCount; index += 1) {
      const checkbox = providerCheckboxes.nth(index);
      const provider = (await checkbox.textContent())?.trim() ?? '';
      await setCheckbox(checkbox, allowedProviders.has(provider));
    }
    await expect(panel.getByRole('checkbox', { name: 'github-copilot', exact: true })).toHaveAttribute('aria-checked', 'false');
    await expect(panel.getByRole('checkbox', { name: 'ollama', exact: true })).toHaveAttribute('aria-checked', 'true');

    await dialog.getByRole('tab', { name: 'Extensions' }).click();
    await setCheckbox(dialog.getByRole('checkbox', { name: 'Ask User', exact: true }), true);
    await setCheckbox(dialog.getByRole('checkbox', { name: 'Subagent', exact: true }), true);
    const expandSubagent = dialog.getByRole('button', { name: /Expand .*subagent.* settings/iu });
    await expandSubagent.click();
    await setCheckbox(dialog.getByRole('checkbox', { name: 'Always use parent model' }), true);
    await setCheckbox(dialog.getByRole('checkbox', { name: 'Route around busy providers' }), false);
    await setCheckbox(dialog.getByRole('checkbox', { name: 'Fallback on provider failure' }), false);

    const copilotChildDefault = dialog.getByRole('checkbox', { name: 'github-copilot', exact: true });
    if (await copilotChildDefault.count() > 0) await setCheckbox(copilotChildDefault, false);

    await dialog.getByRole('button', { name: 'Close settings' }).click();
    await expect(dialog).toBeHidden();
    const autonomousMode = page.getByRole('button', { name: /Autonomous mode on|Enable autonomous mode/iu });
    if (await autonomousMode.getAttribute('aria-pressed') === 'true') await autonomousMode.click();
    await expect(autonomousMode).toHaveAttribute('aria-pressed', 'false');
    await expect(model).toContainText('DeepSeek V4 Flash 0731');
    await expect(page.getByRole('button', { name: 'Reasoning level' })).toContainText('Max');
  });
});
