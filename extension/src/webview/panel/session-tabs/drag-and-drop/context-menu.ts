import { useState, useCallback } from 'preact/hooks';
import type { SessionTabRunAction } from '../run-state';
import type { SessionTabContextAction, SessionTabContextMenuState, SessionTabContextTarget } from '../types';
import { getContextMenuTrigger } from '../../components/useMenuTriggerAria';

export function useTabContextMenu({
  onDuplicate,
  onClose,
  onTogglePin,
  onPinAndMerge,
  onRunAction,
}: {
  onDuplicate: (tabPath: string) => void;
  onClose: (tabPath: string) => void;
  onTogglePin: (tabPath: string) => void;
  onPinAndMerge: (tabPath: string) => void;
  onRunAction: (action: SessionTabRunAction, tabPath: string) => void;
}) {
  const [tabContextMenu, setTabContextMenu] = useState<SessionTabContextMenuState | null>(null);

  const onContextMenu = useCallback((
    event: MouseEvent,
    tabPath: string,
    target: SessionTabContextTarget = { kind: 'tab' },
    triggerEl?: HTMLElement | null,
  ) => {
    event.preventDefault();
    setTabContextMenu({
      x: event.clientX,
      y: event.clientY,
      tabPath,
      target,
      triggerEl: triggerEl === undefined ? getContextMenuTrigger(event) : triggerEl,
    });
  }, []);

  const closeContextMenu = useCallback(() => setTabContextMenu(null), []);

  const onContextAction = useCallback((action: SessionTabContextAction, tabPath: string) => {
    closeContextMenu();
    if (action === 'duplicate') {
      onDuplicate(tabPath);
    } else if (action === 'close') {
      onClose(tabPath);
    } else if (action === 'pin' || action === 'unpin') {
      onTogglePin(tabPath);
    } else if (action === 'pin-merge') {
      onPinAndMerge(tabPath);
    } else {
      onRunAction(action, tabPath);
    }
  }, [closeContextMenu, onDuplicate, onClose, onTogglePin, onPinAndMerge, onRunAction]);

  return {
    tabContextMenu,
    setTabContextMenu,
    closeContextMenu,
    onContextMenu,
    onContextAction,
  };
}
