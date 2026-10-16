/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { createPortal } from 'preact/compat';
import { useLayoutEffect, useState } from 'preact/hooks';
import { useMenuListeners } from '../lib/components/useMenuListeners';
import { SNOOZE_PRESETS, type SnoozeDuration } from './snooze';
import { placeSnoozeSubmenu } from './snooze-submenu-placement';

export function SnoozeSubmenu({ trigger, menuRef, label, reason, keyboard, onClose, onEnter, onLeave, onSelect }: {
  trigger: HTMLButtonElement;
  menuRef: { current: HTMLDivElement | null };
  label: string;
  reason?: string;
  keyboard: boolean;
  onClose: () => void;
  onEnter: () => void;
  onLeave: () => void;
  onSelect: (duration: SnoozeDuration) => void;
}) {
  const [pos, setPos] = useState({ left: 0, top: 0, maxHeight: window.innerHeight - 8 });
  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = trigger.getBoundingClientRect();
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    setPos(placeSnoozeSubmenu(rect, width, height, window.innerWidth, window.innerHeight));
    if (keyboard) node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [trigger, keyboard]);
  useMenuListeners(menuRef, onClose, {
    // The parent owns outside dismissal for both portal and parent surfaces.
    onOutsideClick: () => {},
    onKey: (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); onClose(); }
      if (event.key === 'ArrowRight' && document.activeElement === trigger) {
        event.preventDefault(); menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
      }
    },
    onResize: () => {},
  });
  return createPortal(<div ref={menuRef} role="menu" aria-label={`Snooze ${label}`}
    class="block-context-menu session-tab-context-menu snooze-submenu"
    style={{ position: 'fixed', left: pos.left, top: pos.top, maxHeight: pos.maxHeight, overflowY: 'auto' }}
    onMouseEnter={onEnter} onMouseLeave={onLeave} onMouseDown={(event) => event.stopPropagation()}>
    {SNOOZE_PRESETS.map(({ duration, label: preset }) => <button key={duration}
      class="context-menu-item" type="button" role="menuitem" disabled={!!reason} title={reason}
      aria-label={reason ? `${preset}: ${reason}` : undefined}
      onClick={() => { if (!reason) onSelect(duration); }}>{preset}</button>)}
  </div>, document.body);
}
