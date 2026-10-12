/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { createPortal } from 'preact/compat';
import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ProviderSetupPreviewProps, ProviderSetupKind, ProviderSetupPreference, ProviderSetupCredentialSource } from '../../lib/protocol/provider-setup-preview.js';

const names: Record<ProviderSetupKind, string> = { chatgpt: 'ChatGPT', openai: 'OpenAI API', anthropic: 'Anthropic', copilot: 'GitHub Copilot', custom: 'Other provider' };
const providerNames: Readonly<Record<string, string>> = { 'openai-codex': 'ChatGPT', 'github-copilot': 'GitHub Copilot', openai: 'OpenAI API', anthropic: 'Anthropic' };
const friendly = (id: string) => Object.hasOwn(providerNames, id) ? providerNames[id]! : id;
const safeUrl = (url: string) => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };

/** Host-controlled management surface; private inputs never enter commands or views. */
export function ProviderSetupPreview({ view, onCommand, onConnect, onAuthResponse, presentation = 'launcher', disabled = false }: ProviderSetupPreviewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const authInput = useRef<HTMLInputElement>(null);
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
  const auth = view.auth;
  const preview = view.mode === 'preview';
  const definition = view.definitions?.find(item => item.id === view.flow?.definitionId) || view.definitions?.find(item => item.id === draft?.id);
  const methods = definition?.authMethods || (preview ? (kind === 'chatgpt' || kind === 'copilot' ? ['oauth'] as const : kind === 'custom' ? ['local', 'api-key'] as const : ['api-key'] as const) : []);
  const method = view.flow?.connectionMethod || methods[0];
  const command: typeof onCommand = value => { if (!locked) onCommand(value); };
  const close = () => { if (!disabled && !saving) onCommand({ type: connecting ? 'cancel' : 'close' }); };
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = dialog.current;
    if (!node) return;
    if (!node.open) {
      if (typeof node.showModal === 'function') node.showModal(); else node.setAttribute('open', '');
    }
    return () => {
      if (password.current) password.current.value = '';
      if (authInput.current) authInput.current.value = '';
      if (node.open && typeof node.close === 'function') node.close(); else node.removeAttribute('open');
      if (previous?.isConnected && !node.contains(previous)) previous.focus();
    };
  }, [open]);
  const authFocusKey = `${auth?.kind || ''}:${auth?.operationId || ''}:${auth && 'promptId' in auth ? auth.promptId : ''}`;
  useLayoutEffect(() => {
    if (!open) return;
    const node = dialog.current;
    if (!node || node.contains(document.activeElement)) return;
    node.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')?.focus();
  }, [open, screen, authFocusKey]);
  useLayoutEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [open]);
  const connect = () => {
    if (locked || !onConnect || !method) return;
    const input = password.current;
    try { onConnect(method === 'oauth' ? { method: 'signin' } : method === 'local' ? { method: 'local' } : { method: 'api-key', apiKey: input?.value || '' }); }
    finally { if (input) input.value = ''; }
  };
  const preference = (id: string, field: 'visible' | 'subagentEligible', value: ProviderSetupPreference) => <select aria-label={`${field === 'visible' ? 'Visibility' : 'Subagent eligibility'} for ${draft?.models.find(model => model.id === id)?.name}`} value={value} disabled={locked} onChange={event => command({ type: 'model-preference', id, field, value: event.currentTarget.value as ProviderSetupPreference })}><option value="unset">Inherit</option><option value="yes">{field === 'visible' ? 'Show' : 'Allow'}</option><option value="no">{field === 'visible' ? 'Hide' : 'Exclude'}</option></select>;
  const home = <div class="provider-setup-preview-home"><p>Connect the providers you want to use with Pie.</p>{!view.providers.length && (view.mode === 'management' && view.loaded !== true ? <p role={view.status === 'error' ? 'alert' : 'status'}>{view.status === 'error' ? view.message || 'Could not load providers.' : 'Loading providers…'}</p> : <p>No providers yet.</p>)}<ul class="provider-setup-preview-list">{view.providers.map(provider => <li key={provider.id}><div><strong>{provider.name || friendly(provider.id)}</strong><small>{provider.configured ? `${provider.modelCount} models${provider.discovery === 'cached' ? ' · cached' : provider.discovery === 'error' ? ' · refresh failed; add model IDs manually' : provider.discovery === 'unsupported' ? ' · add model IDs manually' : provider.discovery === 'refreshing' ? ' · refreshing' : ''}` : 'Not configured'}</small></div><div class="provider-setup-preview-actions"><button disabled={locked} onClick={() => command({ type: 'edit', id: provider.id })}>Edit</button><button disabled={locked} onClick={() => command({ type: 'models', id: provider.id })}>Models</button><button disabled={locked} onClick={() => command({ type: 'refresh', id: provider.id })}>Refresh</button></div></li>)}</ul><button class="provider-setup-preview-primary" disabled={locked || !canAdd} onClick={() => command({ type: 'add' })}>Add provider</button></div>;
  return <>
    {presentation === 'tab' ? home : <button type="button" disabled={locked} onClick={() => command({ type: 'open' })}>Manage providers</button>}
    {open && createPortal(<dialog ref={dialog} class="provider-setup-preview" aria-labelledby="provider-setup-title" aria-busy={saving || connecting} onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onCancel={event => { event.stopPropagation(); event.preventDefault(); close(); }}>
      <header><h2 id="provider-setup-title">{screen === 'manage' ? 'Manage providers' : screen === 'choose' ? 'Choose a provider' : screen === 'connect' ? `Connect ${definition?.name || names[kind]}` : screen === 'done' ? preview ? 'Provider added' : 'Provider saved' : 'Models'}</h2><button type="button" disabled={disabled || saving} onClick={close}>{connecting ? 'Cancel' : 'Close'}</button></header>
      {preview && <p class="provider-setup-preview-note">Demo · no real connections</p>}
      <div class="provider-setup-preview-content">
        {screen === 'manage' && home}
        {screen === 'choose' && <div class="provider-setup-preview-choices">{view.definitions?.length ? view.definitions.map(option => <button disabled={locked} key={option.id} onClick={() => command({ type: 'choose', kind: option.kind, definitionId: option.id })}>{option.name}<span aria-hidden="true">→</span></button>) : preview ? (Object.keys(names) as ProviderSetupKind[]).map(option => <button disabled={locked} key={option} onClick={() => command({ type: 'choose', kind: option })}>{names[option]}<span aria-hidden="true">→</span></button>) : <p>{view.loaded ? 'No providers available.' : 'Loading providers…'}</p>}</div>}
        {screen === 'connect' && <form onSubmit={event => { event.preventDefault(); connect(); }}>
          {methods.length > 1 && <label>Connection method<select disabled={locked} value={method} onChange={event => command({ type: 'auth-method', method: event.currentTarget.value as 'oauth' | 'api-key' | 'local' })}>{methods.map(value => <option key={value} value={value}>{value === 'oauth' ? 'Sign in' : value === 'api-key' ? 'API key' : 'Local server'}</option>)}</select></label>}
          {method !== 'oauth' && kind === 'custom' && <><label>Server URL<input type="url" required disabled={locked} value={draft?.baseUrl || ''} onInput={event => command({ type: 'change', field: 'baseUrl', value: event.currentTarget.value })} /></label><details><summary>Advanced</summary><label>Protocol<select value={draft?.api || ''} disabled={locked} onChange={event => command({ type: 'change', field: 'api', value: event.currentTarget.value })}><option value="">Default integration</option>{view.protocols.map(api => <option key={api} value={api}>{api}</option>)}</select></label><label>Credential reference<select disabled={locked} value={draft?.credentialSource} onChange={event => command({ type: 'credential', value: event.currentTarget.value as Exclude<ProviderSetupCredentialSource, 'none'> })}><option value="none" disabled>No credential (local server)</option><option value="default">Default</option><option value="saved">Saved credential</option><option value="environment">Environment variable</option></select></label>{draft?.credentialSource === 'environment' && <label>Variable name<input disabled={locked} value={draft.environmentName} onInput={event => command({ type: 'change', field: 'environmentName', value: event.currentTarget.value })} /></label>}</details></>}
          {method === 'api-key' && <label>API key<input key={`${view.flow?.definitionId}:${draft?.id}:${method}`} ref={password} type="password" disabled={locked} required={draft?.credentialSource !== 'saved'} autoComplete="off" /></label>}
          <button class="provider-setup-preview-primary" type="submit" disabled={locked || !onConnect || !method}>{method === 'oauth' ? 'Sign in' : 'Connect'}</button>
          {draft?.credentialSource === 'saved' && <button type="button" disabled={locked} onClick={() => command({ type: 'save' })}>Save existing</button>}
        </form>}
        {auth && <section class="provider-setup-preview-auth" aria-label="Sign in instructions">{(auth.kind === 'browser' || auth.kind === 'device') && <>{safeUrl(auth.url) && <a href={auth.url} target="_blank" rel="noopener noreferrer">Open sign-in page</a>}{auth.kind === 'device' ? <p>Device code: <strong>{auth.code}</strong></p> : auth.instructions && <p>{auth.instructions}</p>}</>}{auth.kind === 'progress' && <p role="status">{auth.message}</p>}{(auth.kind === 'input' || auth.kind === 'select') && <form key={`${auth.operationId}:${auth.promptId}`} onSubmit={event => { event.preventDefault(); const input = auth.kind === 'input' ? authInput.current : authSelect.current; if (!disabled && !saving && onAuthResponse && input) { try { onAuthResponse({ operationId: auth.operationId, promptId: auth.promptId, value: input.value }); } finally { input.value = ''; } } }}><label>{auth.message}{auth.kind === 'input' ? <input ref={authInput} type="password" autoComplete="off" placeholder={auth.placeholder} required={!auth.allowEmpty} disabled={disabled || saving} /> : <select ref={authSelect} disabled={disabled || saving}>{auth.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>}</label><button disabled={disabled || saving || !onAuthResponse}>Continue</button></form>}</section>}
        {screen === 'done' && <><p>{preview ? 'Your demo provider is saved.' : 'Your provider settings have been saved.'}</p><button disabled={locked} onClick={() => command({ type: 'close' })}>Close</button><button class="provider-setup-preview-primary" disabled={locked || !canAdd} onClick={() => command({ type: 'add' })}>Add another provider</button></>}
        {screen === 'models' && <><p>Choose which models appear in your model picker.</p><button disabled={locked || !draft} onClick={() => draft && command({ type: 'refresh', id: draft.id })}>Refresh models</button><form onSubmit={event => { event.preventDefault(); const input = manualId.current; if (input?.value.trim()) { command({ type: 'manual-model-add', id: input.value.trim() }); input.value = ''; } }}><label>Exact model ID<input ref={manualId} disabled={locked} required /></label><button disabled={locked}>Add model</button></form>{draft?.models.map(model => <div class="provider-setup-preview-model" key={model.id}><label><strong>{model.name}</strong>{preference(model.id, 'visible', model.visible)}</label><details><summary>Advanced</summary><label>Subagent eligibility{preference(model.id, 'subagentEligible', model.subagentEligible)}</label>{model.pricing.kind !== 'known' && <small>Price unknown</small>}</details></div>)}{!draft?.models.length && <p>No models available. Refresh or add an exact model ID.</p>}{view.mode === 'management' && <small>Saved preferences apply to new chats only.</small>}<button class="provider-setup-preview-primary" disabled={locked || !draft} onClick={() => command({ type: 'save' })}>{view.mode === 'management' ? 'Save model visibility preferences' : 'Save'}</button></>}
        {(view.status === 'error' || view.status === 'conflict') && <div role="alert"><p>{view.status === 'conflict' ? 'Settings changed elsewhere. Reload before trying again.' : view.mode === 'management' && view.message ? view.message : 'Could not complete this step. Please try again.'}</p><button disabled={locked} onClick={() => command({ type: 'reload' })}>Reload</button></div>}
        {(saving || connecting) && <p role="status">{saving ? 'Saving…' : 'Connecting…'}</p>}
      </div>
      {screen !== 'manage' && screen !== 'done' && <footer><button disabled={locked} onClick={() => command({ type: 'back' })}>Back</button></footer>}
    </dialog>, document.body)}
  </>;
}
