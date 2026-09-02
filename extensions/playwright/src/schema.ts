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
  ref: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID_CHARS })),
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_SELECTOR_CHARS })),
}, strict);

const waitConditionSchema = Type.Object({
  timeMs: Type.Optional(Type.Integer({ minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS })),
  url: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_URL_CHARS })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_TEXT_CHARS })),
  selector: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_SELECTOR_CHARS })),
}, strict);

export const inputSchema = Type.Union([
  Type.Object({ kind: StringEnum(['navigate'] as const), url: Type.String({ minLength: 1, maxLength: MAX_URL_CHARS }) }, strict),
  Type.Object({ kind: StringEnum(['back'] as const) }, strict),
  Type.Object({ kind: StringEnum(['forward'] as const) }, strict),
  Type.Object({ kind: StringEnum(['reload'] as const) }, strict),
  Type.Object({ kind: StringEnum(['click'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['double_click'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['fill'] as const), target: targetSchema, value: Type.String({ maxLength: MAX_TEXT_CHARS }) }, strict),
  Type.Object({ kind: StringEnum(['type'] as const), target: targetSchema, text: Type.String({ maxLength: MAX_TEXT_CHARS }) }, strict),
  Type.Object({ kind: StringEnum(['press'] as const), key: Type.String({ minLength: 1, maxLength: MAX_KEY_CHARS }), target: Type.Optional(targetSchema) }, strict),
  Type.Object({
    kind: StringEnum(['select'] as const), target: targetSchema,
    values: Type.Array(Type.String({ maxLength: MAX_SELECT_VALUE_CHARS }), { minItems: 1, maxItems: MAX_SELECT_VALUES }),
  }, strict),
  Type.Object({ kind: StringEnum(['check'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['uncheck'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['hover'] as const), target: targetSchema }, strict),
  Type.Object({ kind: StringEnum(['focus'] as const), target: targetSchema }, strict),
  Type.Object({
    kind: StringEnum(['upload'] as const), target: targetSchema,
    paths: Type.Array(Type.String({ minLength: 1, maxLength: MAX_PATH_CHARS }), { minItems: 1, maxItems: MAX_UPLOAD_PATHS }),
  }, strict),
  Type.Object({ kind: StringEnum(['wait'] as const), condition: waitConditionSchema }, strict),
  Type.Object({ kind: StringEnum(['tab_open'] as const), url: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_URL_CHARS })) }, strict),
  Type.Object({ kind: StringEnum(['tab_select'] as const), pageId: Type.String({ minLength: 1, maxLength: MAX_ID_CHARS }) }, strict),
  Type.Object({ kind: StringEnum(['tab_close'] as const), pageId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID_CHARS })) }, strict),
]);

export const observationSchema = Type.Object({
  mode: Type.Optional(StringEnum(['auto', 'full', 'none'] as const)),
  depth: Type.Optional(Type.Integer({ minimum: MIN_OBSERVATION_DEPTH, maximum: MAX_OBSERVATION_DEPTH })),
  target: Type.Optional(targetSchema),
  screenshot: Type.Optional(Type.Boolean()),
  consoleLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_EVENT_LIMIT })),
  pageErrorLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_EVENT_LIMIT })),
  requestLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_EVENT_LIMIT })),
  downloadLimit: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_EVENT_LIMIT })),
  includeTabs: Type.Optional(Type.Boolean()),
}, strict);

export const playwrightSchema = Type.Object({
  action: StringEnum(['open', 'observe', 'act', 'run_code', 'close'] as const),
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID_CHARS })),
  pageId: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_ID_CHARS })),

  // open
  url: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_URL_CHARS })),
  viewport: Type.Optional(Type.Object({
    width: Type.Integer({ minimum: VIEWPORT_LIMITS.minWidth, maximum: VIEWPORT_LIMITS.maxWidth }),
    height: Type.Integer({ minimum: VIEWPORT_LIMITS.minHeight, maximum: VIEWPORT_LIMITS.maxHeight }),
  }, strict)),
  storageStatePath: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PATH_CHARS })),
  actionTimeoutMs: Type.Optional(Type.Integer({ minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS })),
  navigationTimeoutMs: Type.Optional(Type.Integer({ minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS })),

  // act
  input: Type.Optional(inputSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS })),
  dialog: Type.Optional(Type.Object({
    action: StringEnum(['accept', 'dismiss'] as const),
    promptText: Type.Optional(Type.String({ maxLength: MAX_TEXT_CHARS })),
  }, strict)),

  // run_code
  code: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CODE_CHARS })),
  timeout: Type.Optional(Type.Integer({ minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS })),

  // close
  scope: Type.Optional(StringEnum(['session', 'runtime'] as const)),
  exportStorageState: Type.Optional(Type.Boolean()),

  observation: Type.Optional(observationSchema),
}, strict);

export { targetSchema };
