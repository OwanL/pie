// Isolated synthetic provider fixture: real renderer, no SDK/settings/credentials.
import { test, expect } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BrowserServer } from '../../../application/hosts/browser/http/browser-server.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { ProviderSetupDraft } from '../../../harness/model-providers/management/contracts.js';
import { createProviderManagementState, projectProviderManagementView } from '../../../application/backend/provider-management/state.js';

test('provider feedback after-only synthetic interaction', async ({ page }) => {
  const artifacts = await mkdtemp(path.join(os.tmpdir(), 'pie-provider-feedback-after-'));
  console.log(`AFTER screenshots: ${artifacts}`);
  const p = createProviderManagementState();
  p.snapshot.loaded = true;
  const model = { id: 'shared-model', name: 'Shared synthetic model', visible: 'yes', subagentEligible: 'unset', pricing: { kind: 'unknown', tiered: false } } as const;
  const rows = ['synthetic-one', 'synthetic-two'].map(id => ({ id, name: id, enabled: true, configured: true, modelCount: 1, discovery: 'unsupported', readOnly: false }));
  p.snapshot.providers = rows as typeof p.snapshot.providers;
  const drafts: Record<string, ProviderSetupDraft> = Object.fromEntries(rows.map(row => [row.id, { id: row.id, originalId: row.id, enabled: true, api: '', baseUrl: 'http://synthetic.invalid', credentialSource: 'saved', environmentName: '', models: [{ ...model }] }]));
  const session = { path: path.join(artifacts, 'synthetic.jsonl'), name: 'Synthetic UI verification', cwd: artifacts, modifiedAt: new Date().toISOString(), messageCount: 0 };
  const viewState = { ...EMPTY_VIEW_STATE, sessions: [session], openTabPaths: [session.path], activeSession: session, backendReady: true, transcriptLoaded: true, providerManagement: projectProviderManagementView(p) };
  let server: BrowserServer;
  const publish = () => { viewState.providerManagement = projectProviderManagementView(p); server.requestState(rendererId); };
  let rendererId = '';
  server = new BrowserServer({
    getSettings: () => ({ enabled: true, port: 0, allowLan: false, requirePreferredPort: true }),
    getViewState: () => viewState,
    getRunningSessionCount: () => 0,
    assetDir: path.resolve('application/hosts/vscode/out-dev/webview/panel'),
    routeMessage: async (message, context) => {
      rendererId = context.rendererId;
      if (['ready', 'refreshState', 'requestSnapshot'].includes(message.type)) { publish(); return; }
      if (message.type !== 'providerManagementCommand') return;
      const c = message.command;
      if (c.type === 'models' || c.type === 'edit') {
        p.selectedId = c.id; p.flow = { open: true, screen: c.type === 'models' ? 'models' : 'connect', providerId: c.id, kind: 'custom' };
        p.status = 'loading'; p.draft = null; publish();
        await new Promise(resolve => setTimeout(resolve, 700));
        p.draft = structuredClone(drafts[c.id]) as typeof p.draft; p.status = 'idle';
      } else if (c.type === 'save') {
        p.status = 'saving'; publish();
        await new Promise(resolve => setTimeout(resolve, 150));
        drafts[p.draft!.id] = structuredClone(p.draft!); p.status = 'saved';
      } else if (c.type === 'enabled') { p.draft!.enabled = c.value; p.status = 'idle';
      } else if (c.type === 'model-preference') {
        const m = p.draft!.models.find(m => m.id === c.id); if (m) m[c.field] = c.value; p.status = 'idle';
      } else if (c.type === 'back' || c.type === 'close') { p.flow = { open: false, screen: 'manage' }; p.draft = null; p.status = 'idle';
      } else if (c.type === 'change') { Object.assign(p.draft!, { [c.field]: c.value }); p.status = 'idle'; }
      publish();
    },
  });
  try {
    const started = await server.start(); if (started.kind !== 'started') throw new Error('Server did not start');
    await page.goto(started.url);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Providers', exact: true }).click();
    const panel = page.getByRole('tabpanel');
    await panel.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(panel.getByRole('status')).toHaveText('Loading provider settings…');
    await expect(panel).not.toContainText('No models available');
    await expect(panel).not.toContainText('0 models');
    await page.screenshot({ path: path.join(artifacts, 'after-loading.png') });
    await expect(panel.getByRole('button', { name: 'Save settings' })).toBeVisible();
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await expect(panel.getByRole('status')).toHaveText('Settings saved.');
    await page.screenshot({ path: path.join(artifacts, 'after-save.png') });
    await panel.getByRole('checkbox', { name: 'Enabled', exact: true }).click();
    await expect(panel.getByText('Settings saved.', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: path.join(artifacts, 'after-edit.png') });
    await panel.getByRole('combobox').first().selectOption('no');
    await panel.getByRole('button', { name: 'Save settings' }).click();
    await expect(panel.getByRole('status')).toHaveText('Settings saved.');
    await panel.getByRole('button', { name: 'Back', exact: true }).click();
    await panel.getByRole('button', { name: 'Settings', exact: true }).nth(1).click();
    await expect(panel.getByRole('combobox').first()).toHaveValue('yes');
    await page.screenshot({ path: path.join(artifacts, 'after-same-id-second-provider.png') });
    await panel.getByRole('button', { name: 'Back', exact: true }).click();
    await panel.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(panel.getByRole('combobox').first()).toHaveValue('no');
    await panel.getByRole('button', { name: 'Back', exact: true }).click();
    await panel.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await expect(panel.getByRole('button', { name: 'Save existing' })).toBeVisible();
    await panel.getByRole('button', { name: 'Save existing' }).click();
    await expect(panel.getByRole('status')).toHaveText('Settings saved.');
    await page.screenshot({ path: path.join(artifacts, 'after-save-existing.png') });
    await panel.getByRole('textbox', { name: 'Server URL' }).fill('http://edited.synthetic.invalid');
    await expect(panel.getByText('Settings saved.', { exact: true })).toHaveCount(0);
  } finally { await server.stop(); server.dispose(); }
});
