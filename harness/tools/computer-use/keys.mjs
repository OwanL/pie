const TOP_ROW_DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

export const KEY_ALIASES = Object.freeze({
  ctrl: 'LeftControl', control: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt', meta: 'LeftSuper',
  super: 'LeftSuper', win: 'LeftWin', cmd: 'LeftCmd', command: 'LeftCmd', enter: 'Enter',
  ...Object.fromEntries(TOP_ROW_DIGIT_NAMES.flatMap((name, digit) => [
    [String(digit), `Num${digit}`], [name, `Num${digit}`], [`digit${digit}`, `Num${digit}`],
  ])),
});

export function normalizeKeyAlias(value) {
  return KEY_ALIASES[String(value).toLowerCase()] ?? value;
}

export function deduplicateCanonicalKeys(keys, normalize = normalizeKeyAlias) {
  return [...new Set(keys.map(normalize))];
}
