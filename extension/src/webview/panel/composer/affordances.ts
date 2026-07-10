import { resolveClosestCapableTarget } from '../utils/closest-capable-target';
const GLOBAL_PASTE_BLOCKING_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(', ');

export function shouldHandleGlobalComposerPaste(target: EventTarget | null): boolean {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) {
    return true;
  }

  return candidate.closest!(GLOBAL_PASTE_BLOCKING_SELECTOR) == null;
}

export function describeImagePasteAffordance(supportsImageInputs: boolean): string {
  return supportsImageInputs
    ? 'Paste screenshots anywhere in chat'
    : 'Switch to an image-capable model to paste screenshots';
}
