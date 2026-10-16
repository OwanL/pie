/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { createPortal } from 'preact/compat';
import { SettingCheckbox } from './setting-checkbox';
import { useCallback, useLayoutEffect, useRef } from 'preact/hooks';
import type { ProviderSetupPreviewProps, ProviderSetupPreviewView, ProviderSetupKind, ProviderSetupPreference, ProviderSetupCredentialSource } from '../../lib/protocol/provider-setup-preview.js';

type ProviderRow = ProviderSetupPreviewView['providers'][number];
/** Capability-based guidance: existing/edit-locked rows report only the model count. */
const discoveryNote = (provider: ProviderRow): string =>
  (provider.capabilities?.editConnection ?? !provider.readOnly)
    ? provider.discovery === 'cached' ? ' · cached last known' : provider.discovery === 'error' ? ' · refresh failed; add model IDs manually' : provider.discovery === 'unsupported' ? ' · add model IDs manually' : provider.discovery === 'refreshing' ? ' · refreshing' : ''
    : '';

const names: Record<ProviderSetupKind, string> = { chatgpt: 'ChatGPT', openai: 'OpenAI API', anthropic: 'Anthropic', copilot: 'GitHub Copilot', ollama: 'Ollama', custom: 'Other provider' };
const providerNames: Readonly<Record<string, string>> = { 'openai-codex': 'ChatGPT', 'github-copilot': 'GitHub Copilot', openai: 'OpenAI API', anthropic: 'Anthropic', ollama: 'Ollama' };
const friendly = (id: string) => Object.hasOwn(providerNames, id) ? providerNames[id]! : id;
const safeUrl = (url: string) => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };

/** Host-controlled management surface; private inputs never enter commands or views. */
export function ProviderSetupPreview({ view, onCommand, onConnect, onAuthResponse, presentation = 'launcher', disabled = false }: ProviderSetupPreviewProps) {
  const surface = useRef<HTMLElement>(null);
  const returnFocus = useRef<number | null>(null);
  const inline = presentation === 'tab';
  const password = useRef<HTMLInputElement>(null);
  const authInput = useRef<HTMLInputElement>(null);
  // Ref detach runs even when layout cleanup sees refs already nulled.
  const passwordRef = useCallback((node: HTMLInputElement | null) => { if (password.current && password.current !== node) password.current.value = ''; password.current = node; }, []);
  const authInputRef = useCallback((node: HTMLInputElement | null) => { if (authInput.current && authInput.current !== node) authInput.current.value = ''; authInput.current = node; }, []);
  const authSelect = useRef<HTMLSelectElement>(null);
  const manualId = useRef<HTMLInputElement>(null);
  const saving = view.status === 'saving';
  const connecting = view.status === 'connecting';
  const locked = disabled || saving || connecting;
  const canAdd = view.mode === 'preview' || view.loaded === true && !!view.definitions?.length;
  const open = view.flow?.open === true && !(presentation === 'tab' && view.flow.screen === 'manage');
  const screen = view.flow?.screen || 'manage';
  const kind = view.flow?.kind || 'custom';
  const draft = view.draft;
  const draftPending = view.status === 'loading' && !draft && (screen === 'models' || screen === 'connect');
  const selected = view.providers.find(provider => provider.id === (view.flow?.providerId || draft?.originalId || draft?.id));
  const canEditConnection = selected?.capabilities?.editConnection ?? !selected?.readOnly;
  const auth = view.auth;
  const authBrowser = auth && view.authBrowser?.operationId === auth.operationId ? view.authBrowser : undefined;
  const browser = auth?.kind === 'browser' || auth?.kind === 'device' ? {
    url: auth.url,
    instructions: auth.kind === 'browser' ? auth.instructions : undefined,
    code: auth.kind === 'device' ? auth.code : undefined,
  } : authBrowser;
  const preview = view.mode === 'preview';
  const legacySettings = view.mode === 'management' && draft?.credentialSource === 'legacy';
  const definition = view.definitions?.find(item => item.id === view.flow?.definitionId) || view.definitions?.find(item => item.id === draft?.id);
  const methods = definition?.authMethods || (preview ? (kind === 'chatgpt' || kind === 'copilot' ? ['oauth'] as const : kind === 'ollama' ? ['local'] as const : kind === 'custom' ? ['local', 'api-key'] as const : ['api-key'] as const) : []);
  const method = view.flow?.connectionMethod || methods[0];
  const command: typeof onCommand = value => {
    if (locked) return;
    if (inline && !open) returnFocus.current = Array.from(surface.current?.querySelectorAll('button') || []).indexOf(document.activeElement as HTMLButtonElement);
    onCommand(value);
  };
  const close = () => { if (!disabled && !saving) onCommand({ type: connecting ? 'cancel' : 'close' }); };
  const closeRef = useRef(close);
  const back = () => command({ type: screen === 'done' || inline && view.flow?.navigationOrigin !== 'chooser' && (screen === 'connect' || screen === 'models') ? 'close' : 'back' });
  closeRef.current = () => {
    if (inline && !connecting && !disabled && !saving) back();
    else close();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = surface.current as HTMLDialogElement | null;
    if (!node) return;
    if (inline) {
      return () => {
        if (password.current) password.current.value = '';
        if (authInput.current) authInput.current.value = '';
      };
    }
    if (!node.open) {
      if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', '');
    }
    return () => {
      if (password.current) password.current.value = '';
      if (authInput.current) authInput.current.value = '';
      if (node.open && typeof node.close === 'function') node.close(); else node.removeAttribute('open');
      if (previous?.isConnected && !node.contains(previous)) previous.focus();
    };
  }, [open, inline]);
  const authFocusKey = `${auth?.kind || ''}:${auth?.operationId || ''}:${auth && 'promptId' in auth ? auth.promptId : ''}`;
  useLayoutEffect(() => {
    const node = surface.current;
    if (!node) return;
    if (!open) {
      if (inline && returnFocus.current !== null) {
        const index = returnFocus.current;
        returnFocus.current = null;
        node.querySelectorAll<HTMLElement>('button')[index]?.focus();
      }
      return;
    }
    if (node.contains(document.activeElement)) return;
    node.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')?.focus();
  }, [open, screen, authFocusKey]);
  useLayoutEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (inline && !surface.current?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open, inline]);
  const connect = () => {
    if (locked || !onConnect || !method) return;
    const input = password.current;
    try { onConnect(method === 'oauth' ? { method: 'signin' } : method === 'local' ? { method: 'local' } : { method: 'api-key', apiKey: input?.value || '' }); }
    finally { if (input) input.value = ''; }
  };
  const preference = (id: string, field: 'visible' | 'subagentEligible', value: ProviderSetupPreference) => <select aria-label={`${field === 'visible' ? 'Visibility' : 'Subagent eligibility'} for ${draft?.models.find(model => model.id === id)?.name}`} value={value} disabled={locked} onChange={event => command({ type: 'model-preference', id, field, value: event.currentTarget.value as ProviderSetupPreference })}><option value="unset">Default</option><option value="yes">{field === 'visible' ? 'Show' : 'Allow'}</option><option value="no">{field === 'visible' ? 'Hide' : 'Exclude'}</option></select>;
  const inventoryPending = view.mode === 'management' && view.loaded !== true;
  const inventoryFailed = inventoryPending && (view.status === 'error' || !!view.message);
  const home = <div class="provider-setup-preview-home"><p>Connect the providers you want to use with Pie.</p>{inventoryPending ? <p role={inventoryFailed ? 'alert' : 'status'}>{inventoryFailed ? view.message || 'Could not load providers.' : 'Loading providers…'}</p> : !view.providers.length && <p>No providers yet.</p>}<ul class="provider-setup-preview-list">{view.providers.map(provider => <li key={provider.id}><div><strong>{provider.name || friendly(provider.id)}</strong><small>{provider.configured ? `${provider.modelCount} model${provider.modelCount === 1 ? '' : 's'}${discoveryNote(provider)}` : 'Not configured'}</small>{!provider.enabled && <small class="provider-setup-preview-disabled">Disabled</small>}</div><div class="provider-setup-preview-actions">{(provider.capabilities?.settings ?? !provider.readOnly) && <button disabled={locked} onClick={() => command({ type: 'models', id: provider.id })}>Settings</button>}{(provider.capabilities?.editConnection ?? !provider.readOnly) && <button disabled={locked} onClick={() => command({ type: 'edit', id: provider.id })}>Edit</button>}{(provider.capabilities?.remove ?? !provider.readOnly) && <button class="provider-setup-preview-danger" disabled={locked} onClick={() => command({ type: 'remove', id: provider.id })}>Remove</button>}</div></li>)}</ul><button class="provider-setup-preview-primary" disabled={locked || !canAdd} onClick={() => command({ type: 'add' })}>Add provider</button></div>;
  const Surface = inline ? 'section' : 'dialog';
  // Name the provider in the heading when it is known; fall back to the plain title.
  const providerName = selected?.name || (draft && providerNames[draft.originalId || draft.id]) || providerNames[view.flow?.providerId || ''] || names[kind];
  const title = screen === 'manage' ? 'Manage providers' : screen === 'choose' ? 'Choose a provider' : screen === 'connect' ? `Connect ${definition?.name || names[kind]}` : screen === 'done' ? preview ? 'Provider added' : 'Provider saved' : screen === 'remove' ? 'Remove provider' : screen === 'models' ? `${providerName} settings` : 'Provider settings';
  const page = <Surface ref={(node: HTMLElement | null) => { surface.current = node; }} class={`provider-setup-preview${inline ? ' provider-setup-preview-inline' : ''}`} data-provider-subflow="active" data-provider-screen={screen} aria-labelledby="provider-setup-title" aria-busy={saving || connecting || draftPending} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onCancel={event => { event.stopPropagation(); event.preventDefault(); close(); }}>
      <header>{screen !== 'manage' && screen !== 'done' && screen !== 'remove' && <button type="button" disabled={disabled || saving || (!connecting && locked)} onClick={() => connecting ? close() : back()}>{connecting ? 'Cancel' : 'Back'}</button>}<h2 id="provider-setup-title">{draftPending ? 'Provider settings' : title}</h2>{!inline && <button type="button" disabled={disabled || saving} onClick={close}>{connecting ? 'Cancel' : 'Close'}</button>}</header>
      {preview && <p class="provider-setup-preview-note">Demo · no real connections</p>}
      <div class="provider-setup-preview-content">
        {screen === 'manage' && home}
        {screen === 'choose' && <div class="provider-setup-preview-choices">{view.definitions?.length ? view.definitions.map(option => <button disabled={locked} key={option.id} onClick={() => command({ type: 'choose', kind: option.kind, definitionId: option.id })}>{option.name}<span aria-hidden="true">→</span></button>) : preview ? (Object.keys(names) as ProviderSetupKind[]).map(option => <button disabled={locked} key={option} onClick={() => command({ type: 'choose', kind: option })}>{names[option]}<span aria-hidden="true">→</span></button>) : <p>{view.loaded ? 'No providers available.' : 'Loading providers…'}</p>}</div>}
        {draftPending && <p role="status">Loading provider settings…</p>}
        {screen === 'connect' && !draftPending && <form onSubmit={event => { event.preventDefault(); connect(); }}>
          {methods.length > 1 && <label>Connection method<select disabled={locked} value={method} onChange={event => command({ type: 'auth-method', method: event.currentTarget.value as 'oauth' | 'api-key' | 'local' })}>{methods.map(value => <option key={value} value={value}>{value === 'oauth' ? 'Sign in' : value === 'api-key' ? 'API key' : 'Local server'}</option>)}</select></label>}
          {kind === 'ollama' && <p>Use local models or Ollama Cloud through your local Ollama server. For Cloud models, run <code>ollama signin</code> on the server first. Models must already be available; Pie does not pull models.</p>}
          {method !== 'oauth' && kind === 'ollama' && <label>Server URL<input type="url" required disabled={locked} value={draft?.baseUrl || ''} onInput={event => command({ type: 'change', field: 'baseUrl', value: event.currentTarget.value })} /></label>}
          {method !== 'oauth' && kind === 'custom' && <><label>Server URL<input type="url" required disabled={locked} value={draft?.baseUrl || ''} onInput={event => command({ type: 'change', field: 'baseUrl', value: event.currentTarget.value })} /></label><details><summary>Advanced</summary><label>Protocol<select value={draft?.api || ''} disabled={locked} onChange={event => command({ type: 'change', field: 'api', value: event.currentTarget.value })}><option value="">Default integration</option>{view.protocols.map(api => <option key={api} value={api}>{api}</option>)}</select></label><label>Credential reference<select disabled={locked} value={draft?.credentialSource} onChange={event => command({ type: 'credential', value: event.currentTarget.value as Exclude<ProviderSetupCredentialSource, 'none' | 'legacy'> })}><option value="none" disabled>No credential (local server)</option><option value="default">Default</option><option value="saved">Saved credential</option><option value="environment">Environment variable</option></select></label>{draft?.credentialSource === 'environment' && <label>Variable name<input disabled={locked} value={draft.environmentName} onInput={event => command({ type: 'change', field: 'environmentName', value: event.currentTarget.value })} /></label>}</details></>}
          {method === 'api-key' && <label>API key<input key={`${view.flow?.definitionId}:${draft?.id}:${method}`} ref={passwordRef} type="password" disabled={locked} required={draft?.credentialSource !== 'saved'} autoComplete="off" /></label>}
          {!auth && <div class="provider-setup-preview-action-group"><button class="provider-setup-preview-primary" type="submit" disabled={locked || !onConnect || !method}>{method === 'oauth' ? 'Sign in' : 'Connect'}</button>
          {draft?.credentialSource === 'saved' && <button type="button" disabled={locked} onClick={() => command({ type: 'save' })}>Save existing</button>}</div>}
        </form>}
        {auth && <section class="provider-setup-preview-auth" aria-label="Sign in instructions">{browser && <>{safeUrl(browser.url) && <a href={browser.url} target="_blank" rel="noopener noreferrer">Open sign-in page</a>}{browser.instructions && <p>{browser.instructions}</p>}{browser.code && <p>Device code: <strong>{browser.code}</strong></p>}</>}{auth.kind === 'progress' && <p role="status">{auth.message}</p>}{(auth.kind === 'input' || auth.kind === 'select') && <form key={`${auth.operationId}:${auth.promptId}`} onSubmit={event => { event.preventDefault(); const input = auth.kind === 'input' ? authInput.current : authSelect.current; if (!disabled && !saving && onAuthResponse && input) { try { onAuthResponse({ operationId: auth.operationId, promptId: auth.promptId, value: input.value }); } finally { input.value = ''; } } }}><label>{auth.message}{auth.kind === 'input' ? <input ref={authInputRef} type="password" autoComplete="off" placeholder={auth.placeholder} required={!auth.allowEmpty} disabled={disabled || saving} /> : <select ref={authSelect} disabled={disabled || saving}>{auth.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}</label><div class="provider-setup-preview-action-group"><button class="provider-setup-preview-primary" disabled={disabled || saving || !onAuthResponse}>Continue</button></div></form>}{connecting && auth.kind !== 'progress' && <small role="status">Waiting for sign-in…</small>}</section>}
        {screen === 'done' && <><p>{preview ? 'Your demo provider is saved.' : 'Your provider settings have been saved.'}</p><footer class="provider-setup-preview-action-group"><button disabled={locked} onClick={() => command({ type: 'close' })}>{inline ? 'Back to providers' : 'Close'}</button><button class="provider-setup-preview-primary" disabled={locked || !canAdd} onClick={() => command({ type: 'add' })}>Add another provider</button></footer></>}
        {screen === 'remove' && <>
          <p>Remove {selected?.name || friendly(view.flow?.providerId || '')}?</p>
          <p>This also forgets saved Pie credentials. Existing chats may stop working. Environment variables are unchanged.</p>
          <footer class="provider-setup-preview-action-group">
            <button disabled={locked} onClick={() => command({ type: 'back' })}>Cancel</button>
            <button class="provider-setup-preview-danger provider-setup-preview-danger-confirm" disabled={locked || view.status === 'conflict' || view.status === 'loading'} onClick={() => command({ type: 'confirm-remove' })}>
              {view.status === 'error' ? 'Retry removal' : 'Remove provider'}
            </button>
          </footer>
        </>}
        {screen === 'connect' && view.status === 'saved' && <p role="status">Settings saved.</p>}
        {screen === 'models' && !draftPending && <><div class="provider-setup-preview-models-page"><SettingCheckbox label="Enabled" checked={draft?.enabled ?? false} disabled={locked || !draft} onChange={() => command({ type: 'enabled', value: !draft?.enabled })} />{!canEditConnection && <p>Connection settings can’t be changed for this provider.</p>}<p>Choose which models show in your model picker.</p><div class="provider-setup-preview-model-toolbar">{!legacySettings && <button disabled={locked || !draft} onClick={() => draft && command({ type: 'refresh', id: draft.id })}>Refresh models</button>}<small>{draft?.models.length || 0} model{draft?.models.length === 1 ? '' : 's'}</small></div>{!legacySettings && <details><summary>Add model manually</summary><form onSubmit={event => { event.preventDefault(); const input = manualId.current; if (input?.value.trim()) { command({ type: 'manual-model-add', id: input.value.trim() }); input.value = ''; } }}><label>Exact model ID<input ref={manualId} disabled={locked} required /></label><button disabled={locked}>Add model</button></form></details>}<div class="provider-setup-preview-models">{draft?.models.map(model => <div class="provider-setup-preview-model" key={model.id}><label><strong>{model.name}</strong>{preference(model.id, 'visible', model.visible)}</label><details><summary>Advanced</summary><label>Subagent eligibility{preference(model.id, 'subagentEligible', model.subagentEligible)}</label>{model.pricing.kind !== 'known' && <small>Price unknown</small>}</details></div>)}</div>{!draft?.models.length && <p>{legacySettings ? 'No models available.' : 'No models available yet. Refresh, or add one by ID.'}</p>}<small>Listed models may still be unavailable to your account.</small>{view.mode === 'management' && <small>Only new chats pick up these changes.</small>}{view.status === 'saved' && <p role="status">Settings saved.</p>}</div><footer class="provider-setup-preview-model-footer"><button class="provider-setup-preview-primary" disabled={locked || !draft} onClick={() => command({ type: 'save' })}>{view.mode === 'management' ? 'Save settings' : 'Save'}</button></footer></>}
        {(view.status === 'error' || view.status === 'conflict') && <div class="provider-setup-preview-error" role="alert"><p>{view.status === 'conflict' ? 'Settings changed elsewhere. Reload before trying again.' : view.mode === 'management' && view.message ? view.message : 'Could not complete this step. Please try again.'}</p><button disabled={locked} onClick={() => command({ type: 'reload' })}>Reload</button></div>}
        {(saving || connecting && !auth) && <p role="status">{saving ? 'Saving…' : 'Connecting…'}</p>}
      </div>
    </Surface>;
  return inline ? (open ? page : <section ref={node => { surface.current = node; }} class="provider-setup-preview provider-setup-preview-inline">{home}</section>) : <>
    <button type="button" disabled={locked} onClick={() => command({ type: 'open' })}>Manage providers</button>
    {open && createPortal(page, document.body)}
  </>;
}
