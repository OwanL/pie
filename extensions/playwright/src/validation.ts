import {
  MAX_CODE_CHARS, MAX_EVENT_LIMIT, MAX_ID_CHARS, MAX_KEY_CHARS, MAX_OBSERVATION_DEPTH, MAX_PATH_CHARS,
  MAX_SELECTOR_CHARS, MAX_SELECT_VALUES, MAX_SELECT_VALUE_CHARS, MAX_TEXT_CHARS, MAX_TIMEOUT_MS,
  MAX_UPLOAD_PATHS, MAX_URL_CHARS, MIN_OBSERVATION_DEPTH, MIN_TIMEOUT_MS, REF_ACTION_KINDS, VIEWPORT_LIMITS,
  type ElementTarget, type ObservationSettings, type PlaywrightInput, type PlaywrightParams, type WaitCondition,
} from './types.js';

export class PlaywrightValidationError extends Error {
  readonly code = 'INVALID_ARGUMENTS';
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = 'PlaywrightValidationError'; }
}

function fail(message: string): never { throw new PlaywrightValidationError(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function allowed(value: Record<string, unknown>, names: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!names.includes(key)) fail(`${label}.${key} is not valid for this combination.`);
}
function string(value: unknown, label: string, maxChars: number, required = false): void {
  if (value === undefined) { if (required) fail(`${label} is required.`); return; }
  if (typeof value !== 'string' || value.length === 0) fail(`${label} must be a non-empty string.`);
  if (value.length > maxChars) fail(`${label} must be at most ${maxChars} characters.`);
}
function integerRange(value: unknown, label: string, min: number, max: number, required = false): void {
  if (value === undefined) { if (required) fail(`${label} is required.`); return; }
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${label} must be an integer from ${min} to ${max}.`);
  }
}
function timeoutMs(value: unknown, label: string, required = false): void {
  integerRange(value, label, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, required);
}
function boolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== 'boolean') fail(`${label} must be a boolean.`);
}

export function containsAriaRefEngine(selector: string): boolean {
  return /(^|[\s"'=(])aria-ref\s*=/.test(selector);
}

export function validateElementTarget(value: unknown, label: string): asserts value is ElementTarget {
  const t = object(value, label);
  allowed(t, ['ref', 'revision', 'selector'], label);
  const hasRef = t.ref !== undefined;
  const hasSelector = t.selector !== undefined;
  if (hasRef === hasSelector) fail(`${label} must contain exactly one of ref(+revision) or selector.`);
  if (hasRef) {
    string(t.ref, `${label}.ref`, MAX_ID_CHARS, true);
    integerRange(t.revision, `${label}.revision`, 1, Number.MAX_SAFE_INTEGER, true);
  } else {
    string(t.selector, `${label}.selector`, MAX_SELECTOR_CHARS, true);
    if (containsAriaRefEngine(t.selector as string)) {
      fail(`${label}.selector must not use the aria-ref engine; pass the ref and its observation revision via ${label}.ref.`);
    }
    if (t.revision !== undefined) fail(`${label}.revision is only valid with ${label}.ref.`);
  }
}

export function targetUsesRef(target: ElementTarget | undefined): target is { ref: string; revision: number } {
  return target !== undefined && 'ref' in target;
}

function validateWaitCondition(value: unknown, label: string): asserts value is WaitCondition {
  const c = object(value, label);
  allowed(c, ['timeMs', 'url', 'text', 'selector'], label);
  const kinds = ['timeMs', 'url', 'text', 'selector'].filter((name) => c[name] !== undefined);
  if (kinds.length !== 1) fail(`${label} requires exactly one of timeMs, url, text, or selector.`);
  if (c.timeMs !== undefined) integerRange(c.timeMs, `${label}.timeMs`, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, true);
  if (c.url !== undefined) string(c.url, `${label}.url`, MAX_URL_CHARS, true);
  if (c.text !== undefined) string(c.text, `${label}.text`, MAX_TEXT_CHARS, true);
  if (c.selector !== undefined) {
    string(c.selector, `${label}.selector`, MAX_SELECTOR_CHARS, true);
    if (containsAriaRefEngine(c.selector as string)) fail(`${label}.selector must not use the aria-ref engine.`);
  }
}

function requiredTarget(input: Record<string, unknown>, kind: string): void {
  if (input.target === undefined) fail(`input.target is required for ${kind}.`);
  validateElementTarget(input.target, 'input.target');
}

export function validatePlaywrightInput(value: unknown, label = 'input'): asserts value is PlaywrightInput {
  const input = object(value, label);
  string(input.kind, `${label}.kind`, 64, true);
  switch (input.kind) {
    case 'navigate':
      allowed(input, ['kind', 'url'], label); string(input.url, `${label}.url`, MAX_URL_CHARS, true); return;
    case 'back': case 'forward': case 'reload':
      allowed(input, ['kind'], label); return;
    case 'click': case 'double_click': case 'check': case 'uncheck': case 'hover': case 'focus':
      allowed(input, ['kind', 'target'], label); requiredTarget(input, String(input.kind)); return;
    case 'fill':
      allowed(input, ['kind', 'target', 'value'], label); requiredTarget(input, 'fill');
      if (typeof input.value !== 'string' || input.value.length > MAX_TEXT_CHARS) fail(`${label}.value must be a string of at most ${MAX_TEXT_CHARS} characters.`);
      return;
    case 'type':
      allowed(input, ['kind', 'target', 'text'], label); requiredTarget(input, 'type');
      if (typeof input.text !== 'string' || input.text.length > MAX_TEXT_CHARS) fail(`${label}.text must be a string of at most ${MAX_TEXT_CHARS} characters.`);
      return;
    case 'press':
      allowed(input, ['kind', 'key', 'target'], label); string(input.key, `${label}.key`, MAX_KEY_CHARS, true);
      if (input.target !== undefined) validateElementTarget(input.target, `${label}.target`);
      return;
    case 'select': {
      allowed(input, ['kind', 'target', 'values'], label); requiredTarget(input, 'select');
      if (!Array.isArray(input.values) || input.values.length < 1 || input.values.length > MAX_SELECT_VALUES) {
        fail(`${label}.values must contain 1 to ${MAX_SELECT_VALUES} entries.`);
      }
      input.values.forEach((entry, index) => string(entry, `${label}.values[${index}]`, MAX_SELECT_VALUE_CHARS));
      return;
    }
    case 'upload': {
      allowed(input, ['kind', 'target', 'paths'], label); requiredTarget(input, 'upload');
      if (!Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > MAX_UPLOAD_PATHS) {
        fail(`${label}.paths must contain 1 to ${MAX_UPLOAD_PATHS} entries.`);
      }
      input.paths.forEach((entry, index) => string(entry, `${label}.paths[${index}]`, MAX_PATH_CHARS, true));
      return;
    }
    case 'wait':
      allowed(input, ['kind', 'condition'], label); validateWaitCondition(input.condition, `${label}.condition`); return;
    case 'tab_open':
      allowed(input, ['kind', 'url'], label); string(input.url, `${label}.url`, MAX_URL_CHARS); return;
    case 'tab_select':
      allowed(input, ['kind', 'pageId'], label); string(input.pageId, `${label}.pageId`, MAX_ID_CHARS, true); return;
    case 'tab_close':
      allowed(input, ['kind', 'pageId'], label); string(input.pageId, `${label}.pageId`, MAX_ID_CHARS); return;
    default: fail(`${label}.kind is unsupported: ${String(input.kind)}.`);
  }
}

function validateObservation(value: unknown, label = 'observation'): asserts value is ObservationSettings {
  if (value === undefined) return;
  const o = object(value, label);
  allowed(o, ['mode', 'depth', 'target', 'screenshot', 'consoleLimit', 'pageErrorLimit', 'requestLimit', 'downloadLimit', 'includeTabs'], label);
  if (o.mode !== undefined && o.mode !== 'auto' && o.mode !== 'full' && o.mode !== 'none') fail(`${label}.mode must be auto, full, or none.`);
  integerRange(o.depth, `${label}.depth`, MIN_OBSERVATION_DEPTH, MAX_OBSERVATION_DEPTH);
  if (o.target !== undefined) validateElementTarget(o.target, `${label}.target`);
  boolean(o.screenshot, `${label}.screenshot`);
  integerRange(o.consoleLimit, `${label}.consoleLimit`, 0, MAX_EVENT_LIMIT);
  integerRange(o.pageErrorLimit, `${label}.pageErrorLimit`, 0, MAX_EVENT_LIMIT);
  integerRange(o.requestLimit, `${label}.requestLimit`, 0, MAX_EVENT_LIMIT);
  integerRange(o.downloadLimit, `${label}.downloadLimit`, 0, MAX_EVENT_LIMIT);
  boolean(o.includeTabs, `${label}.includeTabs`);
  if (o.mode === 'none' && (o.target !== undefined || o.depth !== undefined || o.screenshot === true)) {
    fail(`${label}.mode "none" cannot be combined with target, depth, or screenshot.`);
  }
}

function validateSessionId(value: unknown, label = 'parameters.sessionId'): void {
  string(value, label, MAX_ID_CHARS, true);
}

export function validatePlaywrightParams(value: unknown): asserts value is PlaywrightParams {
  const p = object(value, 'parameters');
  string(p.action, 'parameters.action', 64, true);
  switch (p.action) {
    case 'open': {
      allowed(p, ['action', 'sessionId', 'url', 'viewport', 'storageStatePath', 'actionTimeoutMs', 'navigationTimeoutMs', 'observation'], 'parameters');
      if (p.sessionId !== undefined) validateSessionId(p.sessionId);
      string(p.url, 'parameters.url', MAX_URL_CHARS);
      if (p.viewport !== undefined) {
        const v = object(p.viewport, 'parameters.viewport');
        allowed(v, ['width', 'height'], 'parameters.viewport');
        integerRange(v.width, 'parameters.viewport.width', VIEWPORT_LIMITS.minWidth, VIEWPORT_LIMITS.maxWidth, true);
        integerRange(v.height, 'parameters.viewport.height', VIEWPORT_LIMITS.minHeight, VIEWPORT_LIMITS.maxHeight, true);
      }
      string(p.storageStatePath, 'parameters.storageStatePath', MAX_PATH_CHARS);
      timeoutMs(p.actionTimeoutMs, 'parameters.actionTimeoutMs');
      timeoutMs(p.navigationTimeoutMs, 'parameters.navigationTimeoutMs');
      validateObservation(p.observation);
      if (p.observation && (p.observation as ObservationSettings).mode === 'none') {
        fail('parameters.observation.mode "none" is not valid for open; open must return the first accessibility observation.');
      }
      if (p.observation && (p.observation as ObservationSettings).target && targetUsesRef((p.observation as ObservationSettings).target)) {
        fail('parameters.observation.target cannot use a ref during open because no observation revision exists yet.');
      }
      return;
    }
    case 'observe': {
      allowed(p, ['action', 'sessionId', 'pageId', 'observation'], 'parameters');
      validateSessionId(p.sessionId);
      string(p.pageId, 'parameters.pageId', MAX_ID_CHARS);
      validateObservation(p.observation);
      return;
    }
    case 'act': {
      allowed(p, ['action', 'sessionId', 'pageId', 'input', 'timeoutMs', 'dialog', 'observation'], 'parameters');
      validateSessionId(p.sessionId);
      string(p.pageId, 'parameters.pageId', MAX_ID_CHARS);
      validatePlaywrightInput(p.input);
      timeoutMs(p.timeoutMs, 'parameters.timeoutMs');
      if (p.input && typeof p.input === 'object' && !Array.isArray(p.input)) {
        const input = p.input as { target?: ElementTarget };
        if (REF_ACTION_KINDS.has(String((p.input as { kind?: unknown }).kind)) && targetUsesRef(input.target) && p.pageId === undefined) {
          fail('parameters.pageId is required for ref-targeted actions so the ref is checked against its owning page.');
        }
      }
      if (p.dialog !== undefined) {
        const d = object(p.dialog, 'parameters.dialog');
        allowed(d, ['action', 'promptText'], 'parameters.dialog');
        if (d.action !== 'accept' && d.action !== 'dismiss') fail('parameters.dialog.action must be accept or dismiss.');
        string(d.promptText, 'parameters.dialog.promptText', MAX_TEXT_CHARS);
        if (d.action === 'dismiss' && d.promptText !== undefined) fail('parameters.dialog.promptText is only valid with action accept.');
      }
      validateObservation(p.observation);
      return;
    }
    case 'run_code': {
      allowed(p, ['action', 'sessionId', 'pageId', 'code', 'timeout', 'observation'], 'parameters');
      validateSessionId(p.sessionId);
      string(p.pageId, 'parameters.pageId', MAX_ID_CHARS);
      string(p.code, 'parameters.code', MAX_CODE_CHARS, true);
      timeoutMs(p.timeout, 'parameters.timeout');
      validateObservation(p.observation);
      if (p.observation && (p.observation as ObservationSettings).target !== undefined) {
        fail('parameters.observation.target is not valid for run_code; the post-code observation covers the page.');
      }
      return;
    }
    case 'close': {
      allowed(p, ['action', 'sessionId', 'scope', 'exportStorageState'], 'parameters');
      if (p.scope !== 'session' && p.scope !== 'runtime') fail('parameters.scope must be "session" or "runtime".');
      if (p.scope === 'session') validateSessionId(p.sessionId);
      if (p.scope === 'runtime' && p.sessionId !== undefined) validateSessionId(p.sessionId);
      boolean(p.exportStorageState, 'parameters.exportStorageState');
      if (p.exportStorageState === true && p.sessionId === undefined) {
        fail('parameters.sessionId is required with exportStorageState so the primary context is unambiguous.');
      }
      return;
    }
    default: fail(`parameters.action is unsupported: ${String(p.action)}.`);
  }
}
