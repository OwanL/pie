/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import PhotoSwipe, { type PhotoSwipeOptions, type UIElementData } from 'photoswipe';
import type { AppAdapter } from '../shell/app';
import { clearImageViewer, inlineViewerSource, openImageViewer, subscribeImageViewer, type ViewerImage } from './image-viewer-store';

/** PhotoSwipe requires intrinsic dimensions before a slide can load or zoom. */
export type ViewerDimensions = { width: number; height: number };

const LOAD_ERROR = 'Image could not be loaded.';

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
 * zoom, pan and keyboard behavior; correlated native actions, capability
 * gating and status text keep the custom UI surface.
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
  const performActionRef = useRef<(action: 'copy' | 'openInBrowser' | 'reveal') => void>(() => undefined);

  const restoreFocus = () => {
    const previous = focusRestore.current;
    if (!previous?.isConnected) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) previous.focus();
  };

  const registerViewerActions = (instance: PhotoSwipe) => {
    const actionButton = (action: 'copy' | 'openInBrowser' | 'reveal', label: string, order: number): UIElementData => ({
      name: `pie-image-${action}`,
      html: label,
      ariaLabel: label,
      title: label,
      isButton: true,
      appendTo: 'bar',
      order,
      onInit: element => { actionElements.current[action] = element; },
      onClick: () => performActionRef.current(action),
    });
    instance.ui?.registerElement(actionButton('copy', 'Copy image', 21));
    instance.ui?.registerElement(actionButton('openInBrowser', 'Open in browser', 22));
    instance.ui?.registerElement(actionButton('reveal', 'Show in file system', 23));
    instance.ui?.registerElement({
      name: 'pie-image-status',
      tagName: 'div',
      className: 'image-viewer-status',
      appendTo: 'bar',
      order: 24,
      onInit: element => { element.setAttribute('role', 'status'); statusElement.current = element; },
    });
  };

  const openPhotoSwipe = (dimensions: ViewerDimensions) => {
    const current = image;
    if (!current) return;
    const superseded = pswp.current;
    if (superseded) { superseded.destroy(); pswp.current = null; viewerClosing.current = false; }
    let instance: PhotoSwipe;
    try {
      instance = pswpFactory({
        dataSource: [{ src: current.src, alt: current.alt, width: dimensions.width, height: dimensions.height }],
        bgOpacity: 0.88,
        wheelToZoom: true,
        arrowPrev: false,
        arrowNext: false,
        counter: false,
        mainClass: 'pie-image-viewer',
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
    instance.on('loadComplete', event => { if (!event.isError && event.slide === instance.currSlide) setError(''); });
    instance.on('loadError', () => setError(LOAD_ERROR));
    instance.on('close', () => { viewerClosing.current = true; clearImageViewer(); });
    instance.on('destroy', () => {
      if (pswp.current === instance) { pswp.current = null; setViewerOpen(false); }
    });
    // Loading failures surface through the status row, not the default box.
    instance.addFilter('contentErrorElement', element => { element.textContent = ''; return element; });
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
      if (!(target instanceof HTMLImageElement) || target.closest('.image-viewer')) return;
      if (!target.matches('.message-user-image-element, .tool-call-result-image, .attachment-card-image, .image-path-preview img, [data-pie-inline-image] img')) return;
      const source = target.dataset.pieImagePath
        ? { kind: 'file' as const, path: target.dataset.pieImagePath, reference: target.dataset.pieImageReference, workingDirectory: target.dataset.pieImageCwd }
        : inlineViewerSource(target.src);
      // Reuse supported inline embeds without granting native raster actions.
      if (!source && !/^data:image\/svg\+xml[;,]/i.test(target.src)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      target.focus();
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
      const instance = pswp.current;
      pswp.current = null;
      instance?.destroy();
      restoreFocus();
    };
  }, [adapter]);

  useEffect(() => {
    actionRequest.current = null; clearTimeout(timer.current); setPending(false);
    const superseded = pswp.current;
    if (!image) {
      if (superseded && !viewerClosing.current) superseded.destroy();
      pswp.current = null; viewerClosing.current = false; setViewerOpen(false);
      restoreFocus();
      return;
    }
    viewerClosing.current = false;
    focusRestore.current = (document.activeElement as HTMLElement | null)?.isConnected
      ? document.activeElement as HTMLElement
      : null;
    if (superseded) setViewerOpen(false);
    if (!viewerOpen) {
      const firstButton = document.querySelector<HTMLElement>('.image-viewer-toolbar button');
      if (firstButton) firstButton.focus();
    }
    const generation = ++openGeneration.current;
    measure(image.src).then(
      dimensions => { if (generation === openGeneration.current) openPhotoSwipe(dimensions); },
      () => {
        if (generation !== openGeneration.current) return;
        pswp.current = null; setViewerOpen(false);
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
    if (statusElement.current) statusElement.current.textContent = error || (pending ? 'Working…' : image?.alt || '');
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
  if (!image || viewerOpen) return null;
  return <div class="image-viewer" role="dialog" aria-modal="true" aria-label={image.alt}>
    <div class="image-viewer-toolbar">
      {image.source && capabilities?.copy && <button disabled={pending} onClick={() => performActionRef.current('copy')}>Copy image</button>}
      {image.source && capabilities?.openInBrowser && <button disabled={pending} onClick={() => performActionRef.current('openInBrowser')}>Open in browser</button>}
      {image.source && capabilities?.reveal && <button disabled={pending} onClick={() => performActionRef.current('reveal')}>Show in file system</button>}
      <button aria-label="Close image viewer" onClick={() => { restoreFocus(); clearImageViewer(); }}>×</button>
    </div>
    <div class="image-viewer-status" role="status">{error || (pending ? 'Working…' : image.alt)}</div>
  </div>;
}