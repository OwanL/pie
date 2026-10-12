import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { installDom } from '../helpers/dom';
import { ComposerSettingsMenu } from '../../settings/settings-menu';
import { ProviderSetupPreview } from '../../settings/provider-setup-preview';
import { DEFAULT_CHAT_PREFS, DEFAULT_PRUNING_SETTINGS, DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, EMPTY_PROVIDER_GATE_STATS } from '../../../lib/protocol/index';
import type { ProviderSetupCommand, ProviderSetupFlow, ProviderSetupPreviewProps, ProviderSetupPreviewView } from '../../../lib/protocol/provider-setup-preview';
import { createProviderSetupDraft, prepareProviderSetupSave, projectProviderSetupPreview } from '../../../backend/settings/provider-setup-preview';
import { readProviderConfig } from '../../../../harness/model-providers/catalog/provider-config';
import { editProviderConfig } from '../../../../harness/model-providers/catalog/provider-config-writer';
import { resolveProviderModelList } from '../../../../harness/model-providers/catalog/provider-model-resolution';
installDom();

const fixture = '# isolated demo\nversion: 1\nproviders:\n  demo:\n    enabled: false # keep this comment\n    manualModels: [model-a]\n    modelOverrides:\n      model-a: {name: Demo model, pricing: unknown}\n';
const demoKey = 'demo-only-private-key-not-a-real-credential';
function button(label: RegExp): HTMLButtonElement {
  const result = Array.from(document.querySelectorAll('button')).find(node => label.test(node.getAttribute('aria-label') || node.textContent || ''));
  assert.ok(result, `Missing ${label} button`);
  return result;
}
function click(label: RegExp): void { act(() => button(label).click()); }
function input(selector: string, value: string): void {
  const node = document.querySelector<HTMLInputElement>(selector);
  assert.ok(node, `Missing ${selector}`);
  act(() => { node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); });
}
function dialog(): Element {
  const node = document.querySelector('dialog.provider-setup-preview[open]');
  assert.ok(node, 'controlled dialog is open');
  return node;
}

for (const injected of [false, true]) test(`Provider management tab is ${injected ? 'explicitly injected' : 'absent by default'}`, () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const commands: ProviderSetupCommand[] = [];
  let liveWrites = 0;
  const view: ProviderSetupPreviewView = { mode: 'preview', flow: { open: false, screen: 'manage' }, providers: [], protocols: [], draft: null, status: 'idle' };
  try {
    const redraw = () => render(h(ComposerSettingsMenu, {
      prefs: DEFAULT_CHAT_PREFS, pruningSettings: DEFAULT_PRUNING_SETTINGS,
      pruningCatalog: { skills: [], tools: [] }, pruningResult: null,
      toolResultPruningSettings: DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
      availableExtensions: [], availableModels: [], providerGateStats: EMPTY_PROVIDER_GATE_STATS,
      mcpServers: [], mcpPendingApply: false,
      onSetPrefs: () => { liveWrites++; }, onMcpListRequested: () => undefined,
      onMcpSetServerEnabled: () => undefined, onSetPruningSettings: () => { liveWrites++; },
      onSetToolResultPruningSettings: () => { liveWrites++; },
      ...(injected ? { providerSetupPreview: { view, onCommand: (command: ProviderSetupCommand) => commands.push(command) } } : {}),
    }), container);
    act(redraw);
    act(() => container.querySelector<HTMLButtonElement>('.toolbar-settings-trigger')!.click());
    const providersTab = document.querySelector<HTMLButtonElement>('[data-tab=providers]');
    assert.equal(!!providersTab, injected);
    if (providersTab) act(() => providersTab.click());
    assert.equal(document.querySelector('dialog.provider-setup-preview[open]'), null);
    assert.equal(!!document.querySelector('.provider-setup-preview-home'), injected);
    assert.equal(!!Array.from(document.querySelectorAll('button')).find(node => node.textContent === 'Add provider'), injected);
    assert.deepEqual(commands, []);
    assert.equal(liveWrites, 0);
    assert.equal(!!document.querySelector('[data-settings-section="provider management"]'), injected);
    if (injected) {
      const addProvider = Array.from(document.querySelectorAll('button')).find(node => node.textContent === 'Add provider');
      assert.ok(addProvider);
      act(() => addProvider.click());
      assert.deepEqual(commands, [{ type: 'add' }]);
      assert.ok(document.querySelector('[role=dialog][aria-label=Settings]'), 'provider tab leaves parent settings mounted');
    }
  } finally { act(() => render(null, container)); container.remove(); }
});

// A fixture controller, not production host/auth state. Its only I/O is this owned YAML.
async function withController(run: (controller: Awaited<ReturnType<typeof createController>>) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pie-provider-guided-ui-'));
  const file = join(dir, 'providers.yaml');
  const container = document.createElement('div');
  document.body.appendChild(container);
  let controller: Awaited<ReturnType<typeof createController>> | undefined;
  try {
    await writeFile(file, fixture);
    controller = await createController(file, container);
    await run(controller);
  } finally {
    await controller?.settled();
    act(() => render(null, container)); container.remove();
    await rm(dir, { recursive: true, force: true });
  }
}
async function createController(file: string, container: HTMLElement) {
  const initial = await readProviderConfig(file);
  assert.equal(initial.status, 'valid');
  if (initial.status !== 'valid') throw new Error('Invalid synthetic fixture');
  let config = initial.config, revision = initial.revision;
  let list = resolveProviderModelList({ config });
  let draft = createProviderSetupDraft(config, list, 'demo');
  let flow: ProviderSetupFlow = { open: true, screen: 'manage' };
  let status: ProviderSetupPreviewView['status'] = 'idle';
  let message: string | undefined;
  let task: Promise<void> = Promise.resolve();
  let connectionCount = 0;
  const commands: ProviderSetupCommand[] = [];
  const snapshot = () => ({ ...projectProviderSetupPreview(config, list, draft, status, message), flow: { ...flow } });
  const redraw = () => render(h(ProviderSetupPreview, { view: snapshot(), onCommand, onConnect }), container);
  const save = (connection = false) => {
    const prepared = prepareProviderSetupSave(config, draft);
    assert.equal(prepared.status, 'valid');
    if (prepared.status !== 'valid') throw new Error('Invalid synthetic draft');
    status = 'saving'; redraw();
    task = (async () => {
      const result = await editProviderConfig(file, revision, prepared.edits);
      if (result.status === 'saved') {
        config = result.config; revision = result.revision; list = resolveProviderModelList({ config });
        draft = createProviderSetupDraft(config, list, draft.id);
        status = 'saved'; if (connection) flow = { ...flow, screen: 'done' };
      } else {
        assert.equal(result.status, 'conflict'); status = 'conflict'; message = 'Preview file changed elsewhere.';
      }
      redraw();
    })();
  };
  const onConnect: NonNullable<ProviderSetupPreviewProps['onConnect']> = request => {
    assert.equal(request.method, 'api-key'); assert.equal(request.apiKey, demoKey);
    connectionCount++;
    // Deliberately discard the private callback argument: no credential-store operation.
    draft = { ...draft, credentialSource: 'saved' }; save(true);
  };
  function onCommand(command: ProviderSetupCommand): void {
    commands.push(command);
    switch (command.type) {
      case 'open': flow = { open: true, screen: 'manage' }; break;
      case 'close': flow = { ...flow, open: false }; break;
      case 'add': flow = { open: true, screen: 'choose' }; break;
      case 'choose':
        draft = { ...createProviderSetupDraft(config, list), id: 'synthetic-openai', enabled: true, api: 'openai-completions', baseUrl: 'https://example.test/v1' };
        flow = { open: true, screen: 'connect', kind: command.kind }; break;
      case 'back': flow = { ...flow, screen: flow.screen === 'connect' ? 'choose' : 'manage' }; break;
      case 'models': draft = createProviderSetupDraft(config, list, command.id); flow = { open: true, screen: 'models' }; break;
      case 'change': draft = { ...draft, [command.field]: command.value }; break;
      case 'model-preference': draft = { ...draft, models: draft.models.map(model => model.id === command.id ? { ...model, [command.field]: command.value } : model) }; break;
      case 'save': save(); return;
      case 'reload':
        task = (async () => {
          const result = await readProviderConfig(file); assert.equal(result.status, 'valid');
          if (result.status !== 'valid') return;
          config = result.config; revision = result.revision; list = resolveProviderModelList({ config });
          draft = createProviderSetupDraft(config, list, draft.id); status = 'idle'; message = undefined; redraw();
        })(); return;
    }
    redraw();
  }
  act(redraw);
  return { file, commands, snapshot, connections: () => connectionCount, settled: () => task };
}

test('guided manage → choose → connect → done, back and close; private key never persisted', async () => {
  await withController(async controller => {
    dialog(); click(/^Add provider$/); assert.equal(controller.snapshot().flow.screen, 'choose');
    click(/^OpenAI(?:\s|→|$)/); assert.equal(controller.snapshot().flow.screen, 'connect');
    click(/^Back$/); assert.equal(controller.snapshot().flow.screen, 'choose');
    click(/^OpenAI(?:\s|→|$)/);
    input('input[type=password]', demoKey);
    assert.ok(!JSON.stringify(controller.snapshot()).includes(demoKey));
    await act(async () => { button(/^Connect$/).click(); await controller.settled(); });
    assert.equal(controller.connections(), 1); assert.equal(controller.snapshot().flow.screen, 'done');
    assert.ok(!JSON.stringify(controller.commands).includes(demoKey));
    assert.ok(!JSON.stringify(controller.snapshot()).includes(demoKey));
    const bytes = await readFile(controller.file, 'utf8');
    assert.ok(!bytes.includes(demoKey)); assert.match(bytes, /keep this comment/);
    const saved = await readProviderConfig(controller.file); assert.equal(saved.status, 'valid');
    if (saved.status === 'valid') {
      assert.deepEqual(saved.config.providers['synthetic-openai'].credentialRef, { source: 'saved' });
      assert.equal(saved.config.providers.demo.modelOverrides?.['model-a'].pricing, 'unknown');
    }
    click(/^Add another provider$/); assert.equal(controller.snapshot().flow.screen, 'choose');
    click(/^Close$/); assert.equal(controller.snapshot().flow.open, false);
    assert.equal(document.querySelector('dialog.provider-setup-preview[open]'), null);
  });
});

for (const conflict of [false, true]) test(`separate model preferences ${conflict ? 'retain draft on conflict until explicit reload' : 'save with comments and unknown metadata intact'}`, async () => {
  await withController(async controller => {
    click(/^Models$/);
    assert.equal(controller.snapshot().flow.screen, 'models');
    dialog();
    assert.equal(controller.snapshot().draft?.models[0].pricing.kind, 'unknown');
    const select = document.querySelector<HTMLSelectElement>('select[aria-label^="Visibility"]');
    assert.ok(select);
    act(() => { select.value = 'no'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    assert.equal(controller.snapshot().draft?.models[0].visible, 'no');
    if (conflict) await writeFile(controller.file, `${fixture}# external edit\n`);
    await act(async () => { button(/^Save(?: preferences)?$/).click(); await controller.settled(); });
    const bytes = await readFile(controller.file, 'utf8');
    assert.match(bytes, /keep this comment/); assert.ok(!bytes.includes(demoKey));
    if (conflict) {
      assert.equal(bytes, `${fixture}# external edit\n`);
      assert.equal(controller.snapshot().status, 'conflict'); assert.equal(select.value, 'no');
      assert.equal(controller.snapshot().draft?.models[0].visible, 'no');
      await act(async () => { button(/^Reload$/).click(); await controller.settled(); });
      assert.equal(controller.snapshot().draft?.models[0].visible, 'unset');
      assert.equal(await readFile(controller.file, 'utf8'), bytes);
    } else {
      assert.equal(controller.snapshot().status, 'saved');
      const saved = await readProviderConfig(controller.file); assert.equal(saved.status, 'valid');
      if (saved.status === 'valid') {
        assert.equal(saved.config.providers.demo.modelPreferences?.['model-a'].visible, false);
        assert.deepEqual(saved.config.providers.demo.manualModels, ['model-a']);
        assert.equal(saved.config.providers.demo.modelOverrides?.['model-a'].pricing, 'unknown');
      }
    }
    click(/^Back$/); assert.equal(controller.snapshot().flow.screen, 'manage');
    click(/^Close$/); assert.equal(controller.snapshot().flow.open, false);
  });
});
