const VIEWPORT_HEIGHT = '--panel-visible-viewport-height';
const VIEWPORT_OFFSET_TOP = '--panel-visible-viewport-offset-top';

interface InlineStyleValue {
  value: string;
  priority: string;
}

function readInlineStyle(element: HTMLElement, property: string): InlineStyleValue {
  return {
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  };
}

function restoreInlineStyle(element: HTMLElement, property: string, previous: InlineStyleValue): void {
  if (previous.value) element.style.setProperty(property, previous.value, previous.priority);
  else element.style.removeProperty(property);
}

/**
 * Keep the app shell aligned to the unscaled visible viewport on mobile browsers
 * whose layout viewport does not resize when the software keyboard opens.
 * CSS viewport units remain the fallback when VisualViewport is unavailable.
 */
export function bindAppToVisualViewport(app: HTMLElement): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => undefined;

  const root = app.ownerDocument.documentElement;
  const previousHeight = readInlineStyle(root, VIEWPORT_HEIGHT);
  const previousOffsetTop = readInlineStyle(root, VIEWPORT_OFFSET_TOP);
  let disposed = false;

  const update = (): void => {
    // Pinch zoom changes the visual viewport without changing the layout the
    // app should occupy. Keep the last unscaled sizing until scale returns to 1.
    if (disposed || viewport.scale !== 1) return;
    const { height, offsetTop } = viewport;
    if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(offsetTop)) return;

    root.style.setProperty(VIEWPORT_HEIGHT, `${height}px`);
    root.style.setProperty(VIEWPORT_OFFSET_TOP, `${offsetTop}px`);
  };

  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  update();

  return () => {
    if (disposed) return;
    disposed = true;
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    restoreInlineStyle(root, VIEWPORT_HEIGHT, previousHeight);
    restoreInlineStyle(root, VIEWPORT_OFFSET_TOP, previousOffsetTop);
  };
}
