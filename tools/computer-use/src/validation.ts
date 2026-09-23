import { normalizeKeyAlias } from './keys.mjs';
import { estimateSequenceDuration } from './sequence.mjs';
import {
  MAX_SEQUENCE_ACTIONS, MAX_SEQUENCE_MS,
  type ComputerAction, type ComputerParams, type ComputerSequence, type PointTarget,
} from './types.js';

export class ComputerValidationError extends Error {
  readonly code = 'INVALID_ARGUMENTS';
  constructor(message: string) { super(message); this.name = 'ComputerValidationError'; }
}

const KEY_NAMES = [
  'Escape', ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`), 'Print', 'ScrollLock', 'Pause',
  'Grave', ...Array.from({ length: 10 }, (_, i) => `Num${(i + 1) % 10}`), 'Minus', 'Equal', 'Backspace',
  'Insert', 'Home', 'PageUp', 'NumLock', 'Divide', 'Multiply', 'Subtract', 'Tab',
  ...'QWERTYUIOP'.split(''), 'LeftBracket', 'RightBracket', 'Backslash', 'Delete', 'End', 'PageDown',
  'NumPad7', 'NumPad8', 'NumPad9', 'Add', 'CapsLock', ...'ASDFGHJKL'.split(''), 'Semicolon', 'Quote',
  'Return', 'NumPad4', 'NumPad5', 'NumPad6', 'LeftShift', ...'ZXCVBNM'.split(''), 'Comma', 'Period',
  'Slash', 'RightShift', 'Up', 'NumPad1', 'NumPad2', 'NumPad3', 'Enter', 'LeftControl', 'LeftSuper',
  'LeftWin', 'LeftCmd', 'LeftAlt', 'Space', 'RightAlt', 'RightSuper', 'RightWin', 'RightCmd', 'Menu',
  'RightControl', 'Fn', 'Left', 'Down', 'Right', 'NumPad0', 'Decimal', 'Clear', 'AudioMute',
  'AudioVolDown', 'AudioVolUp', 'AudioPlay', 'AudioStop', 'AudioPause', 'AudioPrev', 'AudioNext',
  'AudioRewind', 'AudioForward', 'AudioRepeat', 'AudioRandom',
];
const VALID_KEYS = new Set(KEY_NAMES.map((key) => key.toLowerCase()));

function fail(message: string): never { throw new ComputerValidationError(message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function allowed(value: Record<string, unknown>, names: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!names.includes(key)) fail(`${label}.${key} is not valid for this combination.`);
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string.`);
}
function key(value: unknown, label: string): asserts value is string {
  nonempty(value, label);
  if (!VALID_KEYS.has(normalizeKeyAlias(value).toLowerCase())) fail(`${label} is not a supported NutJS key: ${value}.`);
}
function duration(value: unknown, label: string, required = false): void {
  if (value === undefined && !required) return;
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_SEQUENCE_MS) {
    fail(`${label} must be an integer from 0 to ${MAX_SEQUENCE_MS}.`);
  }
}
function revision(value: unknown): void {
  if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1)) fail('parameters.revision must be a positive integer.');
}
function usesTargetCoordinates(point: PointTarget | undefined): boolean {
  return point !== undefined && 'x' in point && (point.scope ?? 'target') === 'target';
}
export function actionUsesTargetCoordinates(action: ComputerAction): boolean {
  if ('target' in action && usesTargetCoordinates(action.target)) return true;
  if (action.kind === 'drag') return usesTargetCoordinates(action.from) || usesTargetCoordinates(action.to) || action.path?.some(usesTargetCoordinates) === true;
  return false;
}
export function sequenceUsesTargetCoordinates(sequence: ComputerSequence): boolean {
  return sequence.actions.some((step) => actionUsesTargetCoordinates(step.action));
}
export function validateRevisionForActions(actionsUseTargetCoordinates: boolean, value: unknown): void {
  revision(value);
  if (actionsUseTargetCoordinates && value === undefined) fail('parameters.revision is required for target-relative screenshot coordinates.');
}

export function validatePointTarget(value: unknown, label = 'target'): asserts value is PointTarget {
  const p = object(value, label);
  allowed(p, ['ref', 'x', 'y', 'scope'], label);
  const hasRef = p.ref !== undefined;
  const hasCoordinate = p.x !== undefined || p.y !== undefined;
  if (hasRef === hasCoordinate) fail(`${label} must contain exactly one of ref or x/y coordinates.`);
  if (hasRef) {
    nonempty(p.ref, `${label}.ref`);
    if (p.scope !== undefined) fail(`${label}.scope is only valid with x/y coordinates.`);
    return;
  }
  if (typeof p.x !== 'number' || !Number.isFinite(p.x) || typeof p.y !== 'number' || !Number.isFinite(p.y)) {
    fail(`${label}.x and ${label}.y must be finite numbers.`);
  }
  if (p.scope !== undefined && p.scope !== 'target' && p.scope !== 'desktop') fail(`${label}.scope must be target or desktop.`);
  if ((p.scope ?? 'target') === 'target' && (p.x < 0 || p.y < 0)) fail(`${label} target-relative coordinates cannot be negative.`);
}

export function validateComputerAction(value: unknown, label = 'input'): asserts value is ComputerAction {
  const a = object(value, label);
  nonempty(a.kind, `${label}.kind`);
  const base = ['kind'];
  switch (a.kind) {
    case 'move':
      allowed(a, [...base, 'target', 'durationMs'], label); validatePointTarget(a.target, `${label}.target`); duration(a.durationMs, `${label}.durationMs`); return;
    case 'mouse_down': case 'mouse_up':
      allowed(a, [...base, 'button'], label);
      if (!['left', 'middle', 'right'].includes(String(a.button))) fail(`${label}.button must be left, middle, or right.`); return;
    case 'click': case 'double_click':
      allowed(a, [...base, 'target', 'button'], label); validatePointTarget(a.target, `${label}.target`);
      if (a.button !== undefined && !['left', 'middle', 'right'].includes(String(a.button))) fail(`${label}.button must be left, middle, or right.`); return;
    case 'right_click':
      allowed(a, [...base, 'target'], label); validatePointTarget(a.target, `${label}.target`); return;
    case 'drag': {
      allowed(a, [...base, 'from', 'to', 'path', 'durationMs', 'button'], label);
      const hasPath = a.path !== undefined; const hasPair = a.from !== undefined || a.to !== undefined;
      if (hasPath === hasPair) fail(`${label} drag requires exactly one of path or from/to.`);
      if (hasPath) {
        if (!Array.isArray(a.path) || a.path.length < 2 || a.path.length > 1000) fail(`${label}.path must contain 2 to 1000 points.`);
        a.path.forEach((p, i) => validatePointTarget(p, `${label}.path[${i}]`));
      } else { validatePointTarget(a.from, `${label}.from`); validatePointTarget(a.to, `${label}.to`); }
      if (a.button !== undefined && !['left', 'middle', 'right'].includes(String(a.button))) fail(`${label}.button must be left, middle, or right.`);
      duration(a.durationMs, `${label}.durationMs`); return;
    }
    case 'scroll':
      allowed(a, [...base, 'target', 'deltaX', 'deltaY'], label);
      if (a.target !== undefined) validatePointTarget(a.target, `${label}.target`);
      if ((!Number.isFinite(a.deltaX) && a.deltaX !== undefined) || (!Number.isFinite(a.deltaY) && a.deltaY !== undefined)) fail(`${label} scroll deltas must be finite numbers.`);
      if ((a.deltaX ?? 0) === 0 && (a.deltaY ?? 0) === 0) fail(`${label} scroll requires a non-zero deltaX or deltaY.`); return;
    case 'key_down': case 'key_up': case 'press':
      allowed(a, [...base, 'key'], label); key(a.key, `${label}.key`); return;
    case 'hotkey':
      allowed(a, [...base, 'keys'], label);
      if (!Array.isArray(a.keys) || a.keys.length < 1 || a.keys.length > 32) fail(`${label}.keys must contain 1 to 32 keys.`);
      a.keys.forEach((k, i) => key(k, `${label}.keys[${i}]`)); return;
    case 'text':
      allowed(a, [...base, 'text'], label); if (typeof a.text !== 'string' || a.text.length > 100000) fail(`${label}.text must be a string of at most 100000 characters.`); return;
    case 'wait':
      allowed(a, [...base, 'durationMs'], label); duration(a.durationMs, `${label}.durationMs`, true); return;
    case 'focus': case 'release_all': allowed(a, base, label); return;
    default: fail(`${label}.kind is unsupported: ${String(a.kind)}.`);
  }
}

export function validateSequence(value: unknown): asserts value is ComputerSequence {
  const seq = object(value, 'sequence'); allowed(seq, ['version', 'actions'], 'sequence');
  if (seq.version !== 1) fail('sequence.version must be 1.');
  if (!Array.isArray(seq.actions) || seq.actions.length > MAX_SEQUENCE_ACTIONS) fail(`sequence.actions must contain at most ${MAX_SEQUENCE_ACTIONS} entries.`);
  let previous = -1;
  seq.actions.forEach((raw, index) => {
    const step = object(raw, `sequence.actions[${index}]`); allowed(step, ['atMs', 'action'], `sequence.actions[${index}]`);
    if (!Number.isInteger(step.atMs) || (step.atMs as number) < previous || (step.atMs as number) > MAX_SEQUENCE_MS) {
      fail(`sequence.actions[${index}].atMs must be a nondecreasing integer from 0 to ${MAX_SEQUENCE_MS}.`);
    }
    previous = step.atMs as number; validateComputerAction(step.action, `sequence.actions[${index}].action`);
  });
  if (estimateSequenceDuration(seq as unknown as ComputerSequence) > MAX_SEQUENCE_MS) {
    fail(`sequence total duration must not exceed ${MAX_SEQUENCE_MS}ms.`);
  }
}

export function validateComputerParams(value: unknown): asserts value is ComputerParams {
  const p = object(value, 'parameters'); nonempty(p.action, 'parameters.action');
  switch (p.action) {
    case 'open': {
      allowed(p, ['action', 'selector', 'sessionId', 'screenshot', 'tree', 'state'], 'parameters');
      const s = object(p.selector, 'selector'); nonempty(s.kind, 'selector.kind');
      const common = ['kind'];
      switch (s.kind) {
        case 'desktop': case 'foreground': allowed(s, common, 'selector'); break;
        case 'pid': allowed(s, [...common, 'pid'], 'selector'); if (!Number.isInteger(s.pid) || (s.pid as number) < 1) fail('selector.pid must be a positive integer.'); break;
        case 'title': allowed(s, [...common, 'title'], 'selector'); nonempty(s.title, 'selector.title'); break;
        case 'window_id': allowed(s, [...common, 'windowId', 'pid'], 'selector'); if (!Number.isInteger(s.windowId) || (s.windowId as number) < 1) fail('selector.windowId must be a positive integer.'); if (s.pid !== undefined && (!Number.isInteger(s.pid) || (s.pid as number) < 1)) fail('selector.pid must be a positive integer.'); break;
        case 'process': allowed(s, [...common, 'process', 'launch', 'args'], 'selector'); nonempty(s.process, 'selector.process'); if (s.args !== undefined && !Array.isArray(s.args)) fail('selector.args must be an array.'); break;
        case 'path': allowed(s, [...common, 'path', 'args'], 'selector'); nonempty(s.path, 'selector.path'); if (s.args !== undefined && !Array.isArray(s.args)) fail('selector.args must be an array.'); break;
        default: fail(`selector.kind is unsupported: ${String(s.kind)}.`);
      }
      if (p.sessionId !== undefined) nonempty(p.sessionId, 'parameters.sessionId'); return;
    }
    case 'observe': allowed(p, ['action', 'sessionId', 'targetId', 'state', 'screenshot', 'tree'], 'parameters'); break;
    case 'act':
      allowed(p, ['action', 'sessionId', 'targetId', 'revision', 'input'], 'parameters');
      validateComputerAction(p.input); validateRevisionForActions(actionUsesTargetCoordinates(p.input as ComputerAction), p.revision); break;
    case 'run_sequence':
      allowed(p, ['action', 'sessionId', 'targetId', 'revision', 'sequence', 'sequencePath', 'preserveHeld', 'screenshot', 'tree', 'state'], 'parameters');
      if ((p.sequence === undefined) === (p.sequencePath === undefined)) fail('run_sequence requires exactly one of sequence or sequencePath.');
      if (p.sequence !== undefined) {
        validateSequence(p.sequence); validateRevisionForActions(sequenceUsesTargetCoordinates(p.sequence as ComputerSequence), p.revision);
      } else { nonempty(p.sequencePath, 'parameters.sequencePath'); revision(p.revision); }
      break;
    case 'close': allowed(p, ['action', 'sessionId', 'closeApplication'], 'parameters'); break;
    default: fail(`parameters.action is unsupported: ${String(p.action)}.`);
  }
  nonempty(p.sessionId, 'parameters.sessionId'); if (p.targetId !== undefined) nonempty(p.targetId, 'parameters.targetId');
}
