/** Best-effort clipboard write used by context-menu actions. */
export async function writeTextToClipboard(text: string): Promise<boolean> {
  try {
    const writeText = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText : undefined;
    if (typeof writeText !== 'function') return false;
    await writeText.call(navigator.clipboard, text);
    return true;
  } catch {
    return false;
  }
}
