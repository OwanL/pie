/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import Viewer from '../vendor/viewerjs/viewer.esm';
import type { AppAdapter } from '../shell/app';
import { ImageActionsMenu, type ImageAction, type ImageActionsMenuState } from './image-actions-menu';
import { restoreImageFocus } from './image-focus-restoration';
import { clearImageViewer, inlineViewerSource, openImageViewer, subscribeImageViewer, type ViewerImage } from './image-viewer-store';

const THUMBNAILS = '.message-user-image-element, .tool-call-result-image, .attachment-card-image, .image-path-preview img, [data-pie-inline-image] img';
const createViewer = (element: HTMLImageElement, options: Viewer.Options) => new Viewer(element, options);
/** Only the library lifecycle is injected; gestures, toolbar and rendering belong to Viewer.js. */
export type ViewerFactory = (element: HTMLImageElement, options: Viewer.Options) => { show(): unknown; destroy(): unknown };

function thumbnailImage(target: EventTarget | null): ViewerImage | null {
  if (!(target instanceof HTMLImageElement) || target.closest('.viewer-container, a[href]') || !target.matches(THUMBNAILS)) return null;
  const source = target.dataset.pieImagePath
    ? { kind: 'file' as const, path: target.dataset.pieImagePath, reference: target.dataset.pieImageReference, workingDirectory: target.dataset.pieImageCwd }
    : inlineViewerSource(target.src);
  if (!source && !/^data:image\/svg\+xml[;,]/i.test(target.src)) return null;
  return { src: target.src, alt: target.alt || 'Image', source };
}

export function ImageViewer({ adapter, viewerFactory = createViewer }: { adapter: AppAdapter; viewerFactory?: ViewerFactory }) {
  const [image, setImage] = useState<ViewerImage | null>(null);
  const [menu, setMenu] = useState<ImageActionsMenuState | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [capabilities, setCapabilities] = useState(adapter.initialState?.imageActionCapabilities);
  const availableActions = useRef(capabilities);
  availableActions.current = capabilities;
  const openingTrigger = useRef<HTMLElement | null>(null);
  const retire = useRef<() => void>(() => {});
  const actionRequest = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const resetAction = () => { clearTimeout(timer.current); actionRequest.current = null; setPending(false); };

  useEffect(() => subscribeImageViewer(setImage), []);
  useEffect(() => {
    let lifecycle: string | null = null;
    const dismiss = () => { retire.current(); clearImageViewer(); setMenu(null); resetAction(); setError(''); };
    const open = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
      if (event instanceof MouseEvent && event.button !== 0) return;
      const next = thumbnailImage(event.target);
      if (!next) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const target = event.target as HTMLImageElement;
      target.focus();
      const activation = { returnFocus: target as HTMLElement };
      target.dispatchEvent(new window.CustomEvent('pie-image-viewer-open', { bubbles: true, detail: activation }));
      openingTrigger.current = activation.returnFocus;
      setMenu(null); resetAction();
      openImageViewer(next);
    };
    const context = (event: MouseEvent) => {
      const next = thumbnailImage(event.target);
      if (!next?.source || !Object.values(availableActions.current ?? {}).some(Boolean)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      resetAction(); setError('');
      setMenu({ x: event.clientX, y: event.clientY, triggerEl: event.target as HTMLElement, image: next });
    };
    document.addEventListener('click', open, true);
    document.addEventListener('keydown', open, true);
    document.addEventListener('contextmenu', context, true);
    const disconnect = adapter.transport.onConnectionStateChange(state => { if (state !== 'connected') dismiss(); });
    const unsubscribe = adapter.transport.subscribe(message => {
      if (message.type === 'state') {
        const key = `${message.hostInstanceId}:${message.state.activeSessionPath ?? message.state.activeSession?.path ?? ''}`;
        if (lifecycle !== null && lifecycle !== key) dismiss();
        lifecycle = key;
        setCapabilities(message.state.imageActionCapabilities);
      }
      if (message.type === 'imageActionResult' && message.requestId === actionRequest.current) {
        resetAction(); setError(message.success ? '' : message.error || 'Image action failed.');
      }
    });
    return () => {
      document.removeEventListener('click', open, true);
      document.removeEventListener('keydown', open, true);
      document.removeEventListener('contextmenu', context, true);
      disconnect(); unsubscribe(); dismiss();
    };
  }, [adapter]);

  useEffect(() => {
    if (!image) return;
    setError('');
    const trigger = openingTrigger.current ?? document.activeElement as HTMLElement | null;
    openingTrigger.current = null;
    // Original bytes go straight to a browser img (including animated GIF/WebP).
    // No canvas, dimension probe or re-encoding is involved.
    const source = document.createElement('img');
    source.alt = image.alt;
    let instance: ReturnType<ViewerFactory> | undefined;
    let retired = false;
    const errorImages = new Set<HTMLImageElement>([source]);
    const cleanup = () => {
      if (retired) return;
      retired = true;
      for (const img of errorImages) img.removeEventListener('error', failed);
      const active = document.activeElement;
      const restore = !active || active === document.body || !!(active instanceof Element && active.closest('.viewer-container'));
      instance?.destroy();
      source.removeAttribute('src');
      if (restore) restoreImageFocus(trigger);
    };
    const failed = () => {
      if (retired) return;
      cleanup(); clearImageViewer(); setError('Image could not be loaded.');
    };
    retire.current = cleanup;
    source.addEventListener('error', failed);
    source.src = image.src;
    try {
      instance = viewerFactory(source, {
        // Avoid teardown waiting on CSS transitions, including during loading.
        // All controls and their presentation otherwise use library defaults.
        transition: false,
        hidden: () => { if (!retired) { cleanup(); clearImageViewer(); } },
        view: event => {
          if (retired) return;
          const img = event.detail.image;
          errorImages.add(img); img.addEventListener('error', failed);
        },
      });
      if (retired) instance.destroy();
      else instance.show();
    } catch {
      cleanup(); clearImageViewer(); setError('Image viewer could not be opened.');
    }
    return cleanup;
  }, [image, viewerFactory]);

  const performAction = (action: ImageAction) => {
    if (!menu?.image.source || !capabilities?.[action] || actionRequest.current) return;
    const requestId = `image-action:${Date.now()}:${Math.random()}`;
    actionRequest.current = requestId; setPending(true); setError('');
    timer.current = setTimeout(() => {
      if (actionRequest.current === requestId) { resetAction(); setError('Image action timed out. Please retry.'); }
    }, 15000);
    try { adapter.postMessage({ type: 'performImageAction', requestId, action, source: menu.image.source }); }
    catch { resetAction(); setError('Image action unavailable.'); }
  };
  return <>
    {menu && <ImageActionsMenu menu={menu} capabilities={capabilities} pending={pending} onAction={performAction} onClose={() => setMenu(null)} />}
    {(error || pending) && <div class="image-action-feedback" role={error ? 'alert' : 'status'}>{error || 'Working…'}{error && <button type="button" onClick={() => setError('')} aria-label="Dismiss image error">Dismiss</button>}</div>}
  </>;
}
