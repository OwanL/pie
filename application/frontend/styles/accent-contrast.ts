/**
 * Pick a readable foreground color for text sitting on top of an accent
 * background. Returns near-black for light accents (matches the bundled
 * default `--panel-accent-contrast: #090704`) and warm-white (`--panel-foreground`
 * `#f2eee4`) for dark accents, using the WCAG sRGB relative-luminance formula.
 *
 * Returns null for values that are not 3- or 6-digit hex so the caller can
 * leave the stylesheet default in place rather than guessing. The native
 * `<input type="color">` always produces 6-digit hex, so the UI path is always
 * parseable; the null branch is purely defensive.
 *
 * The bundled gold accent `#d7a942` has luminance ~0.43, so at the default the
 * dark contrast is preserved unchanged.
 */
export function accentContrastColor(accent: string): string | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(accent.trim());
  if (!m) return null;
  const digits = m[1];
  let r: number, g: number, b: number;
  if (digits.length === 3) {
    r = parseInt(digits[0] + digits[0], 16);
    g = parseInt(digits[1] + digits[1], 16);
    b = parseInt(digits[2] + digits[2], 16);
  } else {
    r = parseInt(digits.slice(0, 2), 16);
    g = parseInt(digits.slice(2, 4), 16);
    b = parseInt(digits.slice(4, 6), 16);
  }
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance =
    0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  return luminance > 0.4 ? '#090704' : '#f2eee4';
}
