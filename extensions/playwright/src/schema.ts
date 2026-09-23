import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import {
  MAX_CODE_CHARS, MAX_EVENT_LIMIT, MAX_ID_CHARS, MAX_KEY_CHARS, MAX_OBSERVATION_DEPTH,
  MAX_PATH_CHARS, MAX_SELECTOR_CHARS, MAX_SELECT_VALUES, MAX_SELECT_VALUE_CHARS, MAX_TEXT_CHARS,
  MAX_TIMEOUT_MS, MAX_UPLOAD_PATHS, MAX_URL_CHARS, MIN_OBSERVATION_DEPTH, MIN_TIMEOUT_MS,
  VIEWPORT_LIMITS,
} from './types.js';

const strict = { additionalProperties: false } as const;

const targetSchema = Type.Object({
  ref: Type.Optional(Type.String({ description: 'Accessibility [ref=eN] from the latest observation revision of its page; refs never go in selectors. Exactly one of ref(+revision) or selector.', maxLength: MAX_ID_CHARS, minLength: 1 })),
  revision: Type.Optional(Type.Integer({ description: 'Observation revision the ref came from; required with ref, invalid with selector.', minimum: 1 })),
  selector: Type.Optional(Type.String({ description: 'Playwright selector alternative to ref; must not use the aria-ref engine.', maxLength: MAX_SELECTOR_CHARS, minLength: 1 })),
}, strict);

const waitConditionSchema = Type.Object({
  timeMs: Type.Optional(Type.Integer({ description: 'Wait this many milliseconds; exactly one condition field is allowed.', maximum: MAX_TIMEOUT_MS, minimum: MIN_TIMEOUT_MS })),
  url: Type.Optional(Type.String({ description: 'Wait until the page URL matches (glob); exactly one condition field is allowed.', maxLength: MAX_URL_CHARS, minLength: 1 })),
  text: Type.Optional(Type.String({ description: 'Wait until this text is visible on the page; exactly one condition field is allowed.', maxLength: MAX_TEXT_CHARS, minLength: 1 })),
  selector: Type.Optional(Type.String({ description: 'Wait until this selector resolves (aria-ref engine unsupported); exactly one condition field is allowed.', maxLength: MAX_SELECTOR_CHARS, minLength: 1 })),
}, strict);

export const inputSchema = Type.Union([
  Type.Object({ kind: StringEnum(['navigate'] as const), url: Type.String({ description: 'Required URL to navigate to.', maxLength: MAX_URL_CHARS, minLength: 1 }) }, strict),
  Type.Object({ kind: StringEnum(['back'] as const) }, strict),
  Type.Object({ kind: StringEnum(['forward'] as const) }, strict),
  Type.Object({ kind: StringEnum(['reload'] as const) }, strict),
  Type.Object({ kind: StringEnum(['click'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['double_click'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['fill'] as const), target: targetSchema, value: Type.String({ description: 'Required text that replaces the element value.', maxLength: MAX_TEXT_CHARS }) }, strict),
  Type.Object({ kind: StringEnum(['type'] as const), target: targetSchema, text: Type.String({ description: 'Required text to append to the element.', maxLength: MAX_TEXT_CHARS }) }, strict),
  Type.Object({ kind: StringEnum(['press'] as const), key: Type.String({ description: 'Required key to press; with target, pressed on that element (Playwright focuses it first).', maxLength: MAX_KEY_CHARS, minLength: 1 }), target: Type.Optional(targetSchema) }, strict),
  Type.Object({
    kind: StringEnum(['select'] as const), target: targetSchema,
    values: Type.Array(Type.String({ description: 'One option value to select.', maxLength: MAX_SELECT_VALUE_CHARS }), { description: 'Required option values (1-100).', maxItems: MAX_SELECT_VALUES, minItems: 1 }),
  }, strict),
  Type.Object({ kind: StringEnum(['check'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['uncheck'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['hover'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['focus'] as const), target: targetSchema }, strict),
  Type.Object({
    kind: StringEnum(['upload'] as const), target: targetSchema,
    paths: Type.Array(Type.String({ description: 'One file path to upload.', maxLength: MAX_PATH_CHARS, minLength: 1 }), { description: 'Required file paths (1-20).', maxItems: MAX_UPLOAD_PATHS, minItems: 1 }),
  }, strict),
  Type.Object({ kind: StringEnum(['wait'] as const), condition: waitConditionSchema }, strict),
  Type.Object({ kind: StringEnum(['tab_open'] as const), url: Type.Optional(Type.String({ description: 'Optional URL for the new tab; omitted opens a blank tab.', maxLength: MAX_URL_CHARS, minLength: 1 })) }, strict),
  Type.Object({ kind: StringEnum(['tab_select'] as const), pageId: Type.String({ description: 'Required pageId of the tab to focus.', maxLength: MAX_ID_CHARS, minLength: 1 }) }, strict),
  Type.Object({ kind: StringEnum(['tab_close'] as const), pageId: Type.Optional(Type.String({ description: 'Optional pageId to close; defaults to the active tab.', maxLength: MAX_ID_CHARS, minLength: 1 })) }, strict),
]);

export const observationSchema = Type.Object({
  mode: Type.Optional(StringEnum(['auto', 'full', 'none'] as const, { description: 'auto (default) returns a fresh bounded snapshot after state-changing actions; full forces a full-depth snapshot; none skips the snapshot and leaves old refs invalidated.' })),
  depth: Type.Optional(Type.Integer({ description: 'Maximum accessibility-tree depth (1-50) for the fresh snapshot.', maximum: MAX_OBSERVATION_DEPTH, minimum: MIN_OBSERVATION_DEPTH })),
  target: Type.Optional(targetSchema),
  screenshot: Type.Optional(Type.Boolean({ description: 'Capture an opt-in screenshot, also saved as a session artifact; text-only models receive the artifact path.' })),
  consoleLimit: Type.Optional(Type.Integer({ description: 'Maximum console messages returned (0-200).', maximum: MAX_EVENT_LIMIT, minimum: 0 })),
  pageErrorLimit: Type.Optional(Type.Integer({ description: 'Maximum page errors returned (0-200).', maximum: MAX_EVENT_LIMIT, minimum: 0 })),
  requestLimit: Type.Optional(Type.Integer({ description: 'Maximum failed requests returned (0-200).', maximum: MAX_EVENT_LIMIT, minimum: 0 })),
  downloadLimit: Type.Optional(Type.Integer({ description: 'Maximum download records returned (0-200).', maximum: MAX_EVENT_LIMIT, minimum: 0 })),
  includeTabs: Type.Optional(Type.Boolean({ description: 'Set false to omit the open-tab list from the observation.' })),
}, strict);

export const playwrightSchema = Type.Object({
  action: StringEnum(['open', 'observe', 'act', 'run_code', 'close'] as const, { description: 'Required. open starts a session (and page when url is given), observe returns the accessibility snapshot, act (requires input) performs one input action, run_code (requires code) evaluates Playwright code, close (requires scope) ends a session or the runtime. observe, act, and run_code require sessionId.' }),
  sessionId: Type.Optional(Type.String({ description: 'playwright session id from open; required for observe, act, and run_code (open generates one when omitted).', maxLength: MAX_ID_CHARS, minLength: 1 })),
  pageId: Type.Optional(Type.String({ description: 'Addressed page; defaults to the session\'s active page. Required for ref-targeted act actions so the ref is checked against its owning page.', maxLength: MAX_ID_CHARS, minLength: 1 })),

  // open
  url: Type.Optional(Type.String({ description: 'Page URL for open; omitted opens a blank page.', maxLength: MAX_URL_CHARS, minLength: 1 })),
  viewport: Type.Optional(Type.Object({
    width: Type.Integer({ description: 'Viewport width in pixels (320-1920).', maximum: VIEWPORT_LIMITS.maxWidth, minimum: VIEWPORT_LIMITS.minWidth }),
    height: Type.Integer({ description: 'Viewport height in pixels (200-1080).', maximum: VIEWPORT_LIMITS.maxHeight, minimum: VIEWPORT_LIMITS.minHeight }),
  }, strict)),
  storageStatePath: Type.Optional(Type.String({ description: 'Import cookies/local storage from a storage-state artifact previously written by close with exportStorageState.', maxLength: MAX_PATH_CHARS, minLength: 1 })),
  actionTimeoutMs: Type.Optional(Type.Integer({ description: 'Playwright action timeout in milliseconds (1000-120000, default 30000) applied to this session.', maximum: MAX_TIMEOUT_MS, minimum: MIN_TIMEOUT_MS })),
  navigationTimeoutMs: Type.Optional(Type.Integer({ description: 'Navigation timeout in milliseconds (1000-120000, default 45000) applied to this session.', maximum: MAX_TIMEOUT_MS, minimum: MIN_TIMEOUT_MS })),

  // act
  input: Type.Optional(inputSchema),
  timeoutMs: Type.Optional(Type.Integer({ description: 'Per-action cap in milliseconds (1000-120000); defaults to the session navigation/action timeout by kind.', maximum: MAX_TIMEOUT_MS, minimum: MIN_TIMEOUT_MS })),
  dialog: Type.Optional(Type.Object({
    action: StringEnum(['accept', 'dismiss'] as const, { description: 'Required. Auto-response for one dialog raised by this action; without a dialog field any raised dialog is auto-dismissed.' }),
    promptText: Type.Optional(Type.String({ description: 'Value returned to a prompt dialog; only valid with action accept.', maxLength: MAX_TEXT_CHARS })),
  }, strict)),

  // run_code
  code: Type.Optional(Type.String({ description: 'Required for run_code. JavaScript with {page, context, helpers} bindings: the Playwright Page for pageId, the session\'s primary BrowserContext, and helpers.writeArtifact(name, value) to save up to 100 helper artifacts. Pass a function expression such as ({ page }) => { ... }, or plain statements (an implicit async body, e.g. "return await page.title()"). The JSON-serialized return value is returned inline up to 8 KiB, otherwise saved as an artifact.', maxLength: MAX_CODE_CHARS, minLength: 1 })),
  timeout: Type.Optional(Type.Integer({ description: 'run_code cap in milliseconds (1000-120000, default 60000); a timeout terminates the browser runtime and invalidates every session/page/ref id.', maximum: MAX_TIMEOUT_MS, minimum: MIN_TIMEOUT_MS })),

  // close
  scope: Type.Optional(StringEnum(['session', 'runtime'] as const, { description: 'Required for close. "session" ends one playwright session; "runtime" terminates the whole browser runtime and every session in it.' })),
  exportStorageState: Type.Optional(Type.Boolean({ description: 'With close and sessionId, write the primary context\'s storage state to an artifact for later import via storageStatePath.' })),

  observation: Type.Optional(observationSchema),
}, strict);

export { targetSchema };
