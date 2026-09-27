import { resolveClosestCapableTarget } from '../lib/components/closest-capable-target';
import { hasSelectionOverlapping } from './selection-overlap';
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

function hasSelectionInMessage(candidate: { closest: (selector: string) => unknown }): boolean {
  const message = candidate.closest('[data-message-id]') as {
    contains?: (node: Node | null) => boolean;
    ownerDocument?: Document;
  } | null;
  if (!message || typeof message.contains !== 'function' || !message.ownerDocument) {
    return false;
  }

  return hasSelectionOverlapping(message as Element);
}

export function shouldOpenUserMessageEditor(target: EventTarget | null): boolean {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) {
    return true;
  }

  if (candidate.closest!(USER_MESSAGE_EDIT_BLOCKING_SELECTOR) != null) {
    return false;
  }

  return !hasSelectionInMessage(candidate);
}

export function shouldOpenSubagentContextMenu(target: EventTarget | null): boolean {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) {
    return true;
  }

  return candidate.closest!(SUBAGENT_CONTEXT_MENU_BLOCKING_SELECTOR) == null;
}
