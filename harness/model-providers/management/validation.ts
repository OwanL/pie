import type { ProviderManagementRequest, ProviderManagementSnapshot } from './contracts';

type ObjectValue = Record<string, unknown>;
const record = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: ObjectValue, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max = 2048): value is string => typeof value === 'string' && value.length <= max;
const identity = (value: unknown) => text(value) && value.length > 0;
const boolean = (value: unknown) => typeof value === 'boolean';
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const choice = (value: unknown, options: readonly string[]) => typeof value === 'string' && options.includes(value);
const revision = (value: unknown) => value === null || typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const array = (value: unknown, check: (entry: unknown) => boolean, max = 10_000) => Array.isArray(value) && value.length <= max && value.every(check);
const optional = (value: ObjectValue, key: string, check: (entry: unknown) => boolean) => !Object.hasOwn(value, key) || check(value[key]);
const rate = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const preference = (value: unknown) => choice(value, ['unset', 'yes', 'no']);
const pricing = (value: unknown) => record(value) && keys(value, ['kind', 'input', 'output', 'cacheRead', 'cacheWrite', 'tiered'])
  && choice(value.kind, ['unknown', 'partial', 'known']) && boolean(value.tiered)
  && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => optional(value, key, rate));
const model = (value: unknown) => record(value) && keys(value, ['id', 'name', 'visible', 'subagentEligible', 'pricing'])
  && identity(value.id) && text(value.name) && preference(value.visible) && preference(value.subagentEligible) && pricing(value.pricing);
const draft = (value: unknown) => record(value)
  && keys(value, ['originalId', 'id', 'enabled', 'api', 'baseUrl', 'credentialSource', 'environmentName', 'models', 'manualModelIds'])
  && (value.originalId === null || identity(value.originalId)) && identity(value.id) && boolean(value.enabled)
  && text(value.api, 256) && text(value.baseUrl, 8192) && text(value.environmentName, 256)
  && choice(value.credentialSource, ['default', 'saved', 'environment', 'none', 'legacy']) && array(value.models, model)
  && optional(value, 'manualModelIds', ids => array(ids, identity));
const method = (value: unknown) => choice(value, ['oauth', 'api-key', 'local']);

/** Private RPC ingress. Failure summaries must never interpolate the supplied data. */
export function isProviderManagementRequest(value: unknown): value is ProviderManagementRequest {
  if (!record(value) || !identity(value.operationId)) return false;
  switch (value.type) {
    case 'read': return keys(value, ['type', 'operationId']);
    case 'read-provider': case 'refresh': return keys(value, ['type', 'operationId', 'id']) && identity(value.id);
    case 'remove': return keys(value, ['type', 'operationId', 'expectedRevision', 'id']) && revision(value.expectedRevision) && identity(value.id);
    case 'cancel': return keys(value, ['type', 'operationId', 'targetOperationId']) && identity(value.targetOperationId);
    case 'auth-response': return keys(value, ['type', 'operationId', 'targetOperationId', 'promptId', 'value'])
      && identity(value.targetOperationId) && identity(value.promptId) && text(value.value, 32_768);
    case 'save': return keys(value, ['type', 'operationId', 'expectedRevision', 'draft']) && revision(value.expectedRevision) && draft(value.draft);
    case 'connect': return keys(value, ['type', 'operationId', 'expectedRevision', 'draft', 'method', 'apiKey'])
      && revision(value.expectedRevision) && draft(value.draft) && method(value.method)
      && optional(value, 'apiKey', key => value.method === 'api-key' && text(key, 32_768));
    default: return false;
  }
}
const definition = (value: unknown) => record(value) && keys(value, ['id', 'name', 'kind', 'api', 'baseUrl', 'authMethods', 'discovery'])
  && identity(value.id) && text(value.name) && choice(value.kind, ['chatgpt', 'openai', 'anthropic', 'copilot', 'ollama', 'custom'])
  && text(value.api, 256) && text(value.baseUrl, 8192) && array(value.authMethods, method, 3)
  && choice(value.discovery, ['openai', 'copilot', 'ollama', 'unsupported']);
const summary = (value: unknown) => record(value) && keys(value, ['id', 'name', 'configured', 'enabled', 'modelCount', 'credentials', 'discovery', 'origin', 'readOnly', 'capabilities'])
  && optional(value, 'origin', v => choice(v, ['managed', 'existing'])) && optional(value, 'readOnly', boolean)
  && optional(value, 'capabilities', v => record(v) && keys(v, ['settings', 'editConnection', 'remove', 'forgetCredential'])
    && ['settings', 'editConnection', 'remove', 'forgetCredential'].every(key => boolean(v[key])))
  && (value.origin !== 'existing' || value.readOnly === true || record(value.capabilities) && value.capabilities.settings === true)
  && identity(value.id) && text(value.name) && boolean(value.configured) && boolean(value.enabled) && integer(value.modelCount)
  && choice(value.credentials, ['saved', 'missing', 'environment', 'default', 'none'])
  && choice(value.discovery, ['idle', 'refreshing', 'fresh', 'cached', 'error', 'unsupported']);
const auth = (value: unknown) => {
  if (!record(value) || !identity(value.operationId)) return false;
  switch (value.kind) {
    case 'browser': return keys(value, ['kind', 'operationId', 'url', 'instructions']) && text(value.url, 32_768) && optional(value, 'instructions', text);
    case 'device': return keys(value, ['kind', 'operationId', 'url', 'code']) && text(value.url, 32_768) && text(value.code);
    case 'progress': return keys(value, ['kind', 'operationId', 'message']) && text(value.message);
    case 'input': return keys(value, ['kind', 'operationId', 'promptId', 'message', 'placeholder', 'allowEmpty'])
      && identity(value.promptId) && text(value.message) && optional(value, 'placeholder', text) && optional(value, 'allowEmpty', boolean);
    case 'select': return keys(value, ['kind', 'operationId', 'promptId', 'message', 'options']) && identity(value.promptId) && text(value.message)
      && array(value.options, option => record(option) && keys(option, ['id', 'label']) && identity(option.id) && text(option.label), 1000);
    default: return false;
  }
};
/** Global host event data is a closed, credential-free projection, not configuration authority. */
export function isProviderManagementSnapshot(value: unknown): value is ProviderManagementSnapshot {
  return record(value) && keys(value, ['revision', 'configRevision', 'loaded', 'providers', 'definitions', 'protocols', 'auth', 'authBrowser', 'mutation', 'error'])
    && integer(value.revision) && revision(value.configRevision) && boolean(value.loaded)
    && array(value.providers, summary) && array(value.definitions, definition, 1000) && array(value.protocols, entry => text(entry, 256), 1000)
    && optional(value, 'auth', auth)
    && optional(value, 'authBrowser', browser => record(browser) && keys(browser, ['operationId', 'url', 'instructions', 'code'])
      && identity(browser.operationId) && text(browser.url, 32_768) && optional(browser, 'instructions', text) && optional(browser, 'code', text))
    && optional(value, 'mutation', mutation => record(mutation) && keys(mutation, ['operationId', 'phase']) && identity(mutation.operationId) && mutation.phase === 'saving')
    && optional(value, 'error', text);
}
