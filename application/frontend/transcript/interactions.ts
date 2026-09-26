import { resolveClosestCapableTarget } from '../lib/components/closest-capable-target';
const USER_MESSAGE_EDIT_BLOCKING_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(', ');
const SUBAGENT_CONTEXT_MENU_BLOCKING_SELECTOR = '.message';

export function shouldOpenUserMessageEditor(target: EventTarget | null): boolean {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) {
    return true;
  }

  return candidate.closest!(USER_MESSAGE_EDIT_BLOCKING_SELECTOR) == null;
}

export function shouldOpenSubagentContextMenu(target: EventTarget | null): boolean {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) {
    return true;
  }

  return candidate.closest!(SUBAGENT_CONTEXT_MENU_BLOCKING_SELECTOR) == null;
}
