type HeightMotion = { cancel: () => void };
const motions = new WeakMap<HTMLElement, HeightMotion>();

/** Stop an owned animation and restore the caller's inline styles. */
export function cancelHeightMotion(element: HTMLElement): void {
  motions.get(element)?.cancel();
}

/** Commit the real DOM change synchronously, animating only its occupied box. */
export function animateHeightChange(
  element: HTMLElement,
  update: () => void,
  options: { duration?: number; from?: number; easing?: string } = {},
): void {
  const active = motions.has(element);
  const from = active ? element.getBoundingClientRect().height
    : options.from ?? element.getBoundingClientRect().height;
  cancelHeightMotion(element);
  update();
  const to = element.getBoundingClientRect().height;
  const media = element.ownerDocument.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (media?.matches || typeof element.animate !== 'function' || Math.abs(from - to) < 0.5 || options.duration === 0) return;

  const properties = ['overflow', 'box-sizing'] as const;
  const saved = properties.map((key) => [key, element.style.getPropertyValue(key), element.style.getPropertyPriority(key)]);
  element.style.setProperty('overflow', 'hidden');
  element.style.setProperty('box-sizing', 'border-box');
  element.setAttribute('data-height-moving', 'true');
  const animation = element.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: options.duration ?? 200, easing: options.easing ?? 'ease-in-out', fill: 'both',
  });
  const finish = (notify = true) => {
    if (motions.get(element) !== motion) return;
    motions.delete(element);
    media?.removeEventListener('change', onChange);
    animation.cancel();
    for (const [key, value, priority] of saved) {
      if (value) element.style.setProperty(key, value, priority);
      else element.style.removeProperty(key);
    }
    element.removeAttribute('data-height-moving');
    if (notify) {
      const EventType = element.ownerDocument.defaultView?.Event ?? Event;
      element.dispatchEvent(new EventType('height-motion-end'));
    }
  };
  const onChange = () => { if (media?.matches) finish(); };
  const motion = { cancel: () => finish(false) };
  motions.set(element, motion);
  media?.addEventListener('change', onChange);
  void animation.finished.then(() => finish(), () => finish());
}
