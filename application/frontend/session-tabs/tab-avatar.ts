/**
 * Pinned-tab avatar helpers. Pinned tabs render as icon-only chips (no title),
 * so each one needs a stable, distinguishable marker — a colored letter-avatar
 * whose letter comes from the session name and whose color is hashed from the
 * session path. All helpers are pure + deterministic so a given session always
 * renders the same avatar across reloads and re-renders.
 */

/**
 * Derive the avatar label (a single character) from a session name — the first
 * alphanumeric character, uppercased. Falls back to '?' for empty or
 * symbol-only names so every pinned tab shows *something* distinguishable from
 * a truly empty state.
 */
export function getTabAvatarLabel(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const match = trimmed.match(/[A-Za-z0-9]/);
  return match ? match[0].toUpperCase() : '?';
}

/**
 * Deterministically hash a string (the session path) to a 0–360 hue. Using the
 * path — not the name — keeps the color stable across renames, so a pinned tab
 * keeps its identity color even after its session gets a real name derived
 * from the first message.
 */
export function getTabAvatarHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (Math.imul(hash, 31) + seed.charCodeAt(i)) | 0;
  }
  return (hash >>> 0) % 360;
}

/**
 * Build the inline avatar background color. Fixed saturation/lightness so the
 * white label stays readable across the full hue range and across light/dark
 * panel themes (the avatar is a filled circle, so it stands out on any surface).
 */
export function getTabAvatarColor(seed: string): string {
  const hue = getTabAvatarHue(seed);
  return `hsl(${hue} 48% 46%)`;
}
