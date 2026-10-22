/** Suppress preview activation only during synchronous restoration focus events. */
let restoringTarget: HTMLElement | null = null;

export function isImageFocusRestoration(target: EventTarget | null): boolean {
  return target !== null && target === restoringTarget;
}

export function restoreImageFocus(target: HTMLElement | null): void {
  if (!target?.isConnected) return;
  const previous = restoringTarget;
  restoringTarget = target;
  try {
    target.focus();
  } finally {
    restoringTarget = previous;
  }
}
