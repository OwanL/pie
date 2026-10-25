/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { useMenuListeners } from '../lib/components/useMenuListeners';
import { useMenuTriggerAria } from '../lib/components/useMenuTriggerAria';
import { useMenuViewportClamp } from '../lib/components/useMenuViewportClamp';
import type { ViewerImage } from './image-viewer-store';

export type ImageAction = 'copy' | 'openInBrowser' | 'reveal';
export interface ImageActionsMenuState { x: number; y: number; triggerEl: HTMLElement; image: ViewerImage }
const labels: Record<ImageAction, string> = { copy: 'Copy image', openInBrowser: 'Open in browser', reveal: 'Show in file system' };

/** Native actions live on the thumbnail, never in the stock viewer toolbar. */
export function ImageActionsMenu({ menu, capabilities, pending, onAction, onClose }: {
  menu: ImageActionsMenuState;
  capabilities?: Partial<Record<ImageAction, boolean>>;
  pending: boolean;
  onAction: (action: ImageAction) => void;
  onClose: () => void;
}) {
  const { ref, pos, prepareTabExit } = useMenuViewportClamp({ x: menu.x, y: menu.y, triggerEl: menu.triggerEl, restoreFocusOnClose: true });
  useMenuTriggerAria(menu.triggerEl);
  useMenuListeners(ref, onClose, { closeOnScroll: true, onTabExit: prepareTabExit });
  return <div ref={ref} class="block-context-menu" role="menu" aria-label="Image actions" style={`position:fixed;top:${pos.top}px;left:${pos.left}px`} onMouseDown={event => event.stopPropagation()}>
    {(Object.keys(labels) as ImageAction[]).filter(action => capabilities?.[action]).map(action =>
      <button key={action} type="button" role="menuitem" class="context-menu-item" disabled={pending} onClick={() => onAction(action)}>{labels[action]}</button>,
    )}
  </div>;
}
