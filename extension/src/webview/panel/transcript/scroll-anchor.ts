export interface MessageScrollAnchor {
  /** UI-only row identity; it may differ from the authoritative message id. */
  messageId: string;
  offsetTop: number;
}

export function captureMessageScrollAnchor(container: HTMLDivElement): MessageScrollAnchor | null {
  const containerTop = container.getBoundingClientRect().top;
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-anchor-id]'));
  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    if (rect.bottom <= containerTop) {
      continue;
    }

    const messageId = candidate.dataset.scrollAnchorId;
    if (!messageId) {
      continue;
    }

    return {
      messageId,
      offsetTop: rect.top - containerTop,
    };
  }

  return null;
}

export function restoreMessageScrollAnchor(
  container: HTMLDivElement,
  anchor: MessageScrollAnchor | null,
  programmaticScrollTargetRef?: { current: number | null },
): void {
  if (!anchor) {
    return;
  }

  const containerTop = container.getBoundingClientRect().top;
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('[data-scroll-anchor-id]'));
  const match = candidates.find((candidate) => candidate.dataset.scrollAnchorId === anchor.messageId);
  if (!match) {
    return;
  }

  const delta = match.getBoundingClientRect().top - containerTop - anchor.offsetTop;
  if (Math.abs(delta) < 1) {
    return;
  }

  // Force instant scroll: the `.transcript` rule in styles/index.css sets
  // `scroll-behavior: smooth`, so an unguarded `scrollTop` write would animate
  // (~300ms) instead of pinning the anchor message. Save/override/restore inline
  // `scroll-behavior` the same way `scrollToBottom` does, wrapped in try/finally
  // so the saved value is always restored (manual scroll keeps its smooth feel).
  const prior = container.style.scrollBehavior;
  const before = container.scrollTop;
  try {
    container.style.scrollBehavior = 'auto';
    container.scrollTop += delta;
  } finally {
    container.style.scrollBehavior = prior;
  }
  if (programmaticScrollTargetRef) {
    programmaticScrollTargetRef.current = container.scrollTop === before ? null : container.scrollTop;
  }
}
