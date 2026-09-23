import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

const strict = { additionalProperties: false } as const;
const pointTargetSchema = Type.Object({
  ref: Type.Optional(Type.String({ description: 'Semantic element reference from the latest observation revision; resolves to its exact observed element center. Exactly one of ref or x/y.', minLength: 1 })),
  x: Type.Optional(Type.Number({ description: 'X pixel; requires y. Relative to the latest observation screenshot frame by default (window visible region for window targets, full display for desktop targets); scope desktop uses desktop-absolute coordinates. Exactly one of x/y or ref.' })),
  y: Type.Optional(Type.Number({ description: 'Y pixel; requires x. Relative to the latest observation screenshot frame by default (window visible region for window targets, full display for desktop targets); scope desktop uses desktop-absolute coordinates. Exactly one of x/y or ref.' })),
  scope: Type.Optional(StringEnum(['target', 'desktop'] as const, { description: 'Coordinate space for x/y only: target (default) uses the latest observation screenshot frame (window visible region for window targets, full display for desktop targets), with exclusive upper bounds; desktop uses desktop-absolute coordinates. Never set with ref.' })),
}, strict);

const actionSchema = Type.Object({
  kind: StringEnum([
    'move', 'mouse_down', 'mouse_up', 'click', 'double_click', 'right_click',
    'drag', 'scroll', 'key_down', 'key_up', 'press', 'hotkey', 'text', 'wait',
    'focus', 'release_all',
  ] as const, { description: 'Required. Per-kind required fields: move/click/double_click/right_click target; drag path or from+to; scroll a non-zero deltaX or deltaY; key_down/key_up/press key; hotkey keys; text text; wait durationMs; mouse_down/mouse_up button; focus and release_all nothing.' }),
  target: Type.Optional(pointTargetSchema),
  button: Type.Optional(StringEnum(['left', 'middle', 'right'] as const, { description: 'Mouse button for click/double_click/drag/mouse_down/mouse_up; defaults to left for click/double_click/drag.' })),
  from: Type.Optional(pointTargetSchema),
  to: Type.Optional(pointTargetSchema),
  path: Type.Optional(Type.Array(pointTargetSchema, { description: 'Drag waypoint targets (2-1000); exactly one of path or from+to.', minItems: 2, maxItems: 1000 })),
  durationMs: Type.Optional(Type.Integer({ description: 'Duration in milliseconds (0-600000): the wait duration, or the move/drag travel duration.', minimum: 0, maximum: 600000 })),
  deltaX: Type.Optional(Type.Number({ description: 'Scroll amount in wheel units; at least one of deltaX/deltaY must be non-zero.' })),
  deltaY: Type.Optional(Type.Number({ description: 'Scroll amount in wheel units; at least one of deltaX/deltaY must be non-zero.' })),
  key: Type.Optional(Type.String({ description: 'Single key name (NutJS key name, e.g. Enter, LeftControl, F5).', minLength: 1 })),
  keys: Type.Optional(Type.Array(Type.String({ description: 'One key name of the hotkey chord.', minLength: 1 }), { description: 'Hotkey chord of 1-32 key names held simultaneously.', minItems: 1, maxItems: 32 })),
  text: Type.Optional(Type.String({ description: 'Text to type, at most 100000 characters.', maxLength: 100000 })),
}, strict);

const selectorSchema = Type.Object({
  kind: StringEnum(['desktop', 'foreground', 'pid', 'title', 'window_id', 'process', 'path'] as const, { description: 'Required. desktop/foreground need only kind; pid requires pid; title requires title; window_id requires windowId (pid optional); process requires process (launch, args optional); path requires path (args optional).' }),
  pid: Type.Optional(Type.Integer({ description: 'Process id; required for kind pid and optional for window_id.', minimum: 1 })),
  title: Type.Optional(Type.String({ description: 'Exact window title; required for kind title.', minLength: 1 })),
  windowId: Type.Optional(Type.Integer({ description: 'Window handle; required for kind window_id.', minimum: 1 })),
  process: Type.Optional(Type.String({ description: 'Process image name; required for kind process.', minLength: 1 })),
  path: Type.Optional(Type.String({ description: 'Executable path; required for kind path. Only a deterministically resolved native .exe is launched.', minLength: 1 })),
  launch: Type.Optional(Type.Boolean({ description: 'With kind process: launch a new instance when no matching running window exists.' })),
  args: Type.Optional(Type.Array(Type.String({ description: 'One launch argument.' }), { description: 'Launch arguments for kind process or path.', maxItems: 100 })),
}, strict);

const sequenceSchema = Type.Object({
  version: Type.Literal(1),
  actions: Type.Array(Type.Object({
    atMs: Type.Integer({ description: 'Offset from sequence start in milliseconds (0-600000); offsets must be nondecreasing.', minimum: 0, maximum: 600000 }),
    action: actionSchema,
  }, strict), { description: 'Scheduled input steps, at most 10000.', maxItems: 10000 }),
}, strict);

export const computerSchema = Type.Object({
  action: StringEnum(['open', 'observe', 'act', 'run_sequence', 'close'] as const, { description: 'Required. open (requires selector) discovers or launches an exact target; observe, act (requires input), and run_sequence (requires exactly one of sequence or sequencePath) operate it; close releases it. observe, act, run_sequence, and close require sessionId.' }),
  selector: Type.Optional(selectorSchema),
  sessionId: Type.Optional(Type.String({ description: 'Session id returned by open; required for observe, act, run_sequence, and close (open generates one when omitted).', minLength: 1 })),
  targetId: Type.Optional(Type.String({ description: 'Id of a target from a previous result; defaults to the session\'s active target.', minLength: 1 })),
  revision: Type.Optional(Type.Integer({ description: 'Latest observation revision from this session; required with act or run_sequence for target-relative x/y coordinates and for desktop-session input bound to the observed foreground (all action kinds except wait, focus, release_all, key_up, and mouse_up).', minimum: 1 })),
  state: Type.Optional(Type.Boolean({ description: 'Include observed target state (window foreground/minimized/onScreen, or desktop foreground binding). Defaults true for observe; inline open/run_sequence observations include it only when true (unspecified flags are false).' })),
  screenshot: Type.Optional(Type.Boolean({ description: 'Include the bounded screenshot PNG (long edge at most 1600 px). Defaults true for observe; inline open/run_sequence observations include it only when true (unspecified flags are false).' })),
  tree: Type.Optional(Type.Boolean({ description: 'Include the bounded accessibility tree (elements and markdown). Defaults true for observe; inline open/run_sequence observations include it only when true (unspecified flags are false).' })),
  input: Type.Optional(actionSchema),
  sequence: Type.Optional(sequenceSchema),
  sequencePath: Type.Optional(Type.String({ description: 'Path to a version-1 sequence JSON artifact (max 1 MiB); exactly one of sequence or sequencePath for run_sequence.', minLength: 1 })),
  preserveHeld: Type.Optional(Type.Boolean({ description: 'Keep keys/buttons newly held by the sequence down after completion (default: released).' })),
  closeApplication: Type.Optional(Type.Boolean({ description: 'With close, also terminate the application only for a window target (exact PID/HWND revalidated).' })),
}, strict);

export { actionSchema, pointTargetSchema, selectorSchema, sequenceSchema };
