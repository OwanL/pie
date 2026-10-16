/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppAdapter } from '../shell/app';
import { clearImageViewer, inlineViewerSource, openImageViewer, subscribeImageViewer, type ViewerImage } from './image-viewer-store';

/** Image bytes are ephemeral UI state, never renderer persistence or snapshots. */
export function ImageViewer({ adapter }: { adapter: AppAdapter }) {
  const [image, setImage] = useState<ViewerImage | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [capabilities, setCapabilities] = useState(adapter.initialState?.imageActionCapabilities);
  const lifecycle = useRef('');
  const request = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const dialog = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const dragged = useRef(false);
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
      if (message.type === 'imageActionResult' && message.requestId === request.current) {
        clearTimeout(timer.current); request.current = null; setPending(false);
        setError(message.success ? '' : message.error || 'Image action failed.');
      }
    });
    return () => { document.removeEventListener('click', open, true); document.removeEventListener('keydown', open, true); disconnect(); unsubscribe(); clearImageViewer(); };
  }, [adapter]);
  useEffect(() => {
    request.current = null; clearTimeout(timer.current); drag.current = null; dragged.current = false; setPending(false); setError(''); setZoom(1); setPan({ x: 0, y: 0 });
    if (!image) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector('button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); clearImageViewer(); }
      if (event.key === 'Tab') {
        const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault(); event.stopImmediatePropagation();
        buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
    };
    const focus = (event: FocusEvent) => { if (!dialog.current?.contains(event.target as Node)) dialog.current?.querySelector('button')?.focus(); };
    document.addEventListener('keydown', trap, true); document.addEventListener('focusin', focus);
    return () => { document.removeEventListener('keydown', trap, true); document.removeEventListener('focusin', focus); clearTimeout(timer.current); previous?.isConnected && previous.focus(); };
  }, [image]);
  if (!image) return null;
  const action = (action: 'copy' | 'openInBrowser' | 'reveal') => {
    if (!image.source || !capabilities?.[action] || pending) return;
    const requestId = `image-action:${Date.now()}:${Math.random()}`;
    request.current = requestId; setPending(true); setError('');
    timer.current = setTimeout(() => { if (request.current === requestId) { request.current = null; setPending(false); setError('Image action timed out. Please retry.'); } }, 15000);
    try { adapter.postMessage({ type: 'performImageAction', requestId, action, source: image.source }); }
    catch { clearTimeout(timer.current); request.current = null; setPending(false); setError('Image action unavailable.'); }
  };
  const changeZoom = (factor: number) => setZoom(current => Math.min(16, Math.max(0.1, current * factor)));
  return <div class="image-viewer" ref={dialog} role="dialog" aria-modal="true" aria-label={image.alt}
    onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) clearImageViewer(); }}
    onDblClick={event => event.stopPropagation()} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}>
    <div class="image-viewer-toolbar">
      <button aria-label="Zoom out" onClick={() => changeZoom(1 / 1.25)}>−</button>
      <button aria-label="Reset image view" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Fit · {Math.round(zoom * 100)}%</button>
      <button aria-label="Zoom in" onClick={() => changeZoom(1.25)}>+</button>
      {image.source && capabilities?.copy && <button disabled={pending} onClick={() => action('copy')}>Copy image</button>}
      {image.source && capabilities?.openInBrowser && <button disabled={pending} onClick={() => action('openInBrowser')}>Open in browser</button>}
      {image.source && capabilities?.reveal && <button disabled={pending} onClick={() => action('reveal')}>Show in file system</button>}
      <button aria-label="Close image viewer" onClick={clearImageViewer}>×</button>
    </div>
    <div class="image-viewer-status" role="status">{error || (pending ? 'Working…' : image.alt)}</div>
    <div class="image-viewer-stage" onClick={event => { if (dragged.current) { dragged.current = false; return; } if (event.target === event.currentTarget) clearImageViewer(); }}
      onWheel={event => { event.preventDefault(); changeZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12); }}
      onPointerDown={event => { if (event.button !== 0 || event.target === event.currentTarget) return; event.preventDefault(); dragged.current = false; event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }; }}
      onPointerMove={event => { const start = drag.current; if (start) { dragged.current = dragged.current || Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 3; setPan({ x: start.px + event.clientX - start.x, y: start.py + event.clientY - start.y }); } }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; dragged.current = false; }}>
      <img src={image.src} alt={image.alt} draggable={false} style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }} onError={() => setError('Image could not be loaded.')} />
    </div>
  </div>;
}
