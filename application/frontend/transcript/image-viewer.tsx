/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import PhotoSwipe, { type PhotoSwipeOptions, type UIElementData } from 'photoswipe';
import type { AppAdapter } from '../shell/app';
import { restoreImageFocus } from './image-focus-restoration';
import { clearImageViewer, inlineViewerSource, openImageViewer, subscribeImageViewer, type ViewerImage } from './image-viewer-store';

/** PhotoSwipe requires intrinsic dimensions before a slide can load or zoom. */
export type ViewerDimensions = { width: number; height: number };

const LOAD_ERROR = 'Image could not be loaded.';

// PhotoSwipe's SVG markup API gives native actions the stock button sizing,
// hover states and toolbar layout, without a second set of control styles.
const ACTION_ICONS = {
  copy: '<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1Zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 16H8V7h11v14Z"/>',
  openInBrowser: '<path d="M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2v7ZM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7Z"/>',
  reveal: '<path d="M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Zm0 12H4V8h16v10Z"/>',
} as const;

/** Native probe measuring an image's intrinsic size; rejects when the bytes cannot render. */
function probeImageSize(src: string): Promise<ViewerDimensions> {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth || 320, height: probe.naturalHeight || 320 });
    probe.onerror = () => reject(new Error('image could not be probed'));
    probe.src = src;
  });
}

/**
 * Measures an image and opens the PhotoSwipe instance that owns modal,
 * zoom, pan, keyboard behavior and stock toolbar. Only host-specific actions
 * and action feedback are registered through PhotoSwipe's UI API.
 */
export function ImageViewer({
  adapter,
  measure = probeImageSize,
  pswpFactory = (options: PhotoSwipeOptions) => new PhotoSwipe(options),
}: {
  adapter: AppAdapter;
  /** Injectable seam; the default probe relies on the browser's decoder. */
  measure?: (src: string) => Promise<ViewerDimensions>;
  /** Injectable seam for tests; production constructs PhotoSwipe 5 core directly. */
  pswpFactory?: (options: PhotoSwipeOptions) => PhotoSwipe;
}) {
  const [image, setImage] = useState<ViewerImage | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [capabilities, setCapabilities] = useState(adapter.initialState?.imageActionCapabilities);
  const [viewerOpen, setViewerOpen] = useState(false);
  const pswp = useRef<PhotoSwipe | null>(null);
  const viewerClosing = useRef(false);
  /** Invalidates superseded measurement probes. */
  const openGeneration = useRef(0);
  const lifecycle = useRef('');
  const actionRequest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const actionElements = useRef<Record<'copy' | 'openInBrowser' | 'reveal', HTMLElement | null>>({ copy: null, openInBrowser: null, reveal: null });
  const statusElement = useRef<HTMLElement | null>(null);
  const focusRestore = useRef<HTMLElement | null>(null);
  const openingTrigger = useRef<HTMLElement | null>(null);
  const performActionRef = useRef<(action: 'copy' | 'openInBrowser' | 'reveal') => void>(() => undefined);

  const restoreFocus = () => {
    const previous = focusRestore.current;
    if (!previous?.isConnected) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) restoreImageFocus(previous);
  };

  const registerViewerActions = (instance: PhotoSwipe) => {
    const actionButton = (action: 'copy' | 'openInBrowser' | 'reveal', label: string, order: number): UIElementData => ({
      name: `pie-image-${action}`,
      className: 'image-viewer-action',
      html: { isCustomSVG: true, size: 24, inner: ACTION_ICONS[action] },
      ariaLabel: label,
      title: label,
      isButton: true,
      appendTo: 'bar',
      order,
      onInit: element => { actionElements.current[action] = element; },
      onClick: () => performActionRef.current(action),
    });
    instance.ui?.registerElement(actionButton('copy', 'Copy image', 7));
    instance.ui?.registerElement(actionButton('openInBrowser', 'Open in browser', 8));
    instance.ui?.registerElement(actionButton('reveal', 'Show in file system', 9));
    instance.ui?.registerElement({
      name: 'pie-image-status',
      tagName: 'div',
      className: 'image-viewer-status',
      appendTo: 'root',
      order: 24,
      onInit: element => { element.setAttribute('role', 'status'); statusElement.current = element; },
    });
  };

  const openPhotoSwipe = (dimensions: ViewerDimensions) => {
    const current = image;
    if (!current) return;
    const superseded = pswp.current;
    if (superseded) { pswp.current = null; superseded.destroy(); viewerClosing.current = false; }
    let instance: PhotoSwipe;
    try {
      instance = pswpFactory({
        dataSource: [{ src: current.src, alt: current.alt, width: dimensions.width, height: dimensions.height }],
        // No opening race: destroy() can only close an already-open opener.
        showHideAnimationType: 'none',
        // Own the original trigger; library destroy listeners run before DOM removal.
        returnFocus: false,
        wheelToZoom: true,
        mainClass: 'pie-image-viewer',
        errorMsg: LOAD_ERROR,
      });
    } catch {
      pswp.current = null;
      setViewerOpen(false);
      setError('Image viewer could not be opened.');
      return;
    }
    pswp.current = instance;
    // PhotoSwipe owns the backdrop, stage, gestures, keyboard and focus trap.
    instance.on('uiRegister', () => registerViewerActions(instance));
    instance.on('loadComplete', event => { if (pswp.current === instance && !event.isError && event.slide === instance.currSlide) setError(''); });
    instance.on('loadError', () => { if (pswp.current === instance) setError(LOAD_ERROR); });
    const trigger = focusRestore.current;
    instance.on('close', () => {
      if (pswp.current !== instance) return;
      viewerClosing.current = true;
      clearImageViewer();
    });
    instance.on('destroy', () => {
      if (pswp.current === instance) {
        pswp.current = null; setViewerOpen(false);
        // Wait until PhotoSwipe has removed its focused dialog from the DOM.
        queueMicrotask(() => {
          if (!pswp.current) restoreImageFocus(trigger);
        });
      }
    });
    try {
      instance.init();
      setViewerOpen(true);
    } catch {
      pswp.current = null; setViewerOpen(false);
      setError('Image viewer could not be opened.');
    }
  };

  useEffect(() => subscribeImageViewer(setImage), []);
  useEffect(() => {
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target;
      // Explicit links own their entire label, including loaded image previews.
      if (!(target instanceof HTMLImageElement) || target.closest('.image-viewer, a[href]')) return;
      if (!target.matches('.message-user-image-element, .tool-call-result-image, .attachment-card-image, .image-path-preview img, [data-pie-inline-image] img')) return;
      const source = target.dataset.pieImagePath
        ? { kind: 'file' as const, path: target.dataset.pieImagePath, reference: target.dataset.pieImageReference, workingDirectory: target.dataset.pieImageCwd }
        : inlineViewerSource(target.src);
      // Reuse supported inline embeds without granting native raster actions.
      if (!source && !/^data:image\/svg\+xml[;,]/i.test(target.src)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      target.focus();
      const activation = { returnFocus: target as HTMLElement };
      target.dispatchEvent(new window.CustomEvent('pie-image-viewer-open', { bubbles: true, detail: activation }));
      openingTrigger.current = activation.returnFocus;
      openImageViewer({ src: target.src, alt: target.alt || 'Image', source });
    };
    document.addEventListener('click', open, true);
    document.addEventListener('keydown', open, true);
    const disconnect = adapter.transport.onConnectionStateChange(state => { if (state !== 'connected') clearImageViewer(); });
    const unsubscribe = adapter.transport.subscribe(message => {
      if (message.type === 'state') {
        const key = `${message.hostInstanceId}:${message.state.activeSessionPath ?? message.state.activeSession?.path ?? ''}`;
        if (lifecycle.current && lifecycle.current !== key) clearImageViewer();
        lifecycle.current = key;
        setCapabilities(message.state.imageActionCapabilities);
      }
      if (message.type === 'imageActionResult' && message.requestId === actionRequest.current) {
        clearTimeout(timer.current); actionRequest.current = null; setPending(false);
        setError(message.success ? '' : message.error || 'Image action failed.');
      }
    });
    return () => {
      document.removeEventListener('click', open, true);
      document.removeEventListener('keydown', open, true);
      disconnect(); unsubscribe();
      clearImageViewer();
      // Viewer markup lives outside the webview mount (document.body); destroy
      // it explicitly so ephemeral image bytes and listeners cannot outlive it.
      ++openGeneration.current;
      clearTimeout(timer.current); actionRequest.current = null;
      const instance = pswp.current;
      if (instance?.element) { instance.element.hidden = true; instance.element.inert = true; }
      instance?.destroy();
      restoreFocus();
    };
  }, [adapter]);

  useEffect(() => {
    const generation = ++openGeneration.current;
    actionRequest.current = null; clearTimeout(timer.current); setPending(false);
    const superseded = pswp.current;
    if (!image) {
      if (superseded?.element) { superseded.element.hidden = true; superseded.element.inert = true; }
      if (superseded && !viewerClosing.current) superseded.destroy();
      viewerClosing.current = false; setViewerOpen(false);
      restoreFocus();
      return;
    }
    viewerClosing.current = false;
    focusRestore.current = openingTrigger.current ?? document.activeElement as HTMLElement | null;
    openingTrigger.current = null;
    if (superseded) setViewerOpen(false);
    setError('');
    measure(image.src).then(
      dimensions => { if (generation === openGeneration.current) openPhotoSwipe(dimensions); },
      () => {
        if (generation !== openGeneration.current) return;
        // Let PhotoSwipe own even decoder-error slides, including Escape,
        // backdrop dismissal and its keyboard focus trap.
        openPhotoSwipe({ width: 320, height: 320 });
        setError(LOAD_ERROR);
      },
    );
  }, [image]);

  // Mirrors custom PhotoSwipe UI state whenever it changes, open or not.
  useEffect(() => {
    for (const action of ['copy', 'openInBrowser', 'reveal'] as const) {
      const element = actionElements.current[action];
      if (element) {
        const available = image?.source && capabilities?.[action];
        element.classList.toggle('image-viewer-action-hidden', !available);
        (element as HTMLButtonElement).disabled = pending;
      }
    }
    // Decoder failures already have PhotoSwipe's stage error. Keep the normal
    // image unobscured; this region is only for host-action feedback.
    if (statusElement.current) statusElement.current.textContent = error === LOAD_ERROR ? '' : error || (pending ? 'Working…' : '');
  }, [image, pending, error, capabilities, viewerOpen]);

  performActionRef.current = (action: 'copy' | 'openInBrowser' | 'reveal') => {
    if (!image?.source || !capabilities?.[action] || pending) return;
    const requestId = `image-action:${Date.now()}:${Math.random()}`;
    actionRequest.current = requestId; setPending(true); setError('');
    timer.current = setTimeout(() => {
      if (actionRequest.current === requestId) { actionRequest.current = null; setPending(false); setError('Image action timed out. Please retry.'); }
    }, 15000);
    try { adapter.postMessage({ type: 'performImageAction', requestId, action, source: image.source }); }
    catch { clearTimeout(timer.current); actionRequest.current = null; setPending(false); setError('Image action unavailable.'); }
  };
  return null;
}