import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

const strict = { additionalProperties: false } as const;
const pointTargetSchema = Type.Object({
  ref: Type.Optional(Type.String({ minLength: 1 })),
  x: Type.Optional(Type.Number()),
  y: Type.Optional(Type.Number()),
  scope: Type.Optional(StringEnum(['target', 'desktop'] as const)),
}, strict);

const actionSchema = Type.Object({
  kind: StringEnum([
    'move', 'mouse_down', 'mouse_up', 'click', 'double_click', 'right_click',
    'drag', 'scroll', 'key_down', 'key_up', 'press', 'hotkey', 'text', 'wait',
    'focus', 'release_all',
  ] as const),
  target: Type.Optional(pointTargetSchema),
  button: Type.Optional(StringEnum(['left', 'middle', 'right'] as const)),
  from: Type.Optional(pointTargetSchema),
  to: Type.Optional(pointTargetSchema),
  path: Type.Optional(Type.Array(pointTargetSchema, { minItems: 2, maxItems: 1000 })),
  durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600000 })),
  deltaX: Type.Optional(Type.Number()),
  deltaY: Type.Optional(Type.Number()),
  key: Type.Optional(Type.String({ minLength: 1 })),
  keys: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 32 })),
  text: Type.Optional(Type.String({ maxLength: 100000 })),
}, strict);

const selectorSchema = Type.Object({
  kind: StringEnum(['desktop', 'foreground', 'pid', 'title', 'window_id', 'process', 'path'] as const),
  pid: Type.Optional(Type.Integer({ minimum: 1 })),
  title: Type.Optional(Type.String({ minLength: 1 })),
  windowId: Type.Optional(Type.Integer({ minimum: 1 })),
  process: Type.Optional(Type.String({ minLength: 1 })),
  path: Type.Optional(Type.String({ minLength: 1 })),
  launch: Type.Optional(Type.Boolean()),
  args: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
}, strict);

const sequenceSchema = Type.Object({
  version: Type.Literal(1),
  actions: Type.Array(Type.Object({
    atMs: Type.Integer({ minimum: 0, maximum: 600000 }),
    action: actionSchema,
  }, strict), { maxItems: 10000 }),
}, strict);

export const computerSchema = Type.Object({
  action: StringEnum(['open', 'observe', 'act', 'run_sequence', 'close'] as const),
  selector: Type.Optional(selectorSchema),
  sessionId: Type.Optional(Type.String({ minLength: 1 })),
  targetId: Type.Optional(Type.String({ minLength: 1 })),
  revision: Type.Optional(Type.Integer({ minimum: 1 })),
  state: Type.Optional(Type.Boolean()),
  screenshot: Type.Optional(Type.Boolean()),
  tree: Type.Optional(Type.Boolean()),
  input: Type.Optional(actionSchema),
  sequence: Type.Optional(sequenceSchema),
  sequencePath: Type.Optional(Type.String({ minLength: 1 })),
  preserveHeld: Type.Optional(Type.Boolean()),
  closeApplication: Type.Optional(Type.Boolean()),
}, strict);

export { actionSchema, pointTargetSchema, selectorSchema, sequenceSchema };
