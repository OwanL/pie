import { useCallback, useRef, useState } from 'preact/hooks';

import {
  captureMessageScrollAnchor,
  type MessageScrollAnchor,
} from './scroll-anchor';

export function useScrollState(
  scrollRef: { current: HTMLDivElement | null },
  programmaticScrollTargetRef: { current: number | null },
) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Reactive mirror of `autoFollowRef.current`. The ref gives synchronous
  // reads inside scroll/layout handlers; this state makes `useAutoFollow`
  // re-run when follow transitions false->true while content is otherwise
  // idle. `setAutoFollow` only updates state on an actual boundary change, so
  // ordinary scroll events do not churn renders.
  const [autoFollow, setAutoFollowState] = useState(true);
  const autoFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // Manual scrollbar/wheel/touch/keyboard interaction owns scrollTop until it
  // settles. Anchor restoration and pagination must yield in both directions;
  // otherwise virtual row remeasurement can fight an upward thumb drag.
  const [manualScrollActive, setManualScrollActiveState] = useState(false);
  const manualScrollActiveRef = useRef(false);
  const setManualScrollActive = useCallback((next: boolean) => {
    if (manualScrollActiveRef.current === next) return;
    manualScrollActiveRef.current = next;
    setManualScrollActiveState(next);
  }, []);

  // Co-located setter: updates the synchronous ref and reactive state together
  // so they never diverge. It is gated on actual boundary changes.
  const setAutoFollow = useCallback((next: boolean) => {
    if (autoFollowRef.current === next) return;
    autoFollowRef.current = next;
    setAutoFollowState(next);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Jumps must be instant regardless of theme or inherited scroll behavior.
    const prior = el.style.scrollBehavior;
    const before = el.scrollTop;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = prior;
    programmaticScrollTargetRef.current = el.scrollTop === before ? null : el.scrollTop;
    lastScrollTopRef.current = el.scrollTop;
    setIsAtBottom(true);
  }, [programmaticScrollTargetRef, scrollRef]);

  return {
    isAtBottom,
    setIsAtBottom,
    autoFollow,
    setAutoFollow,
    autoFollowRef,
    lastScrollTopRef,
    manualScrollActive,
    manualScrollActiveRef,
    setManualScrollActive,
    scrollToBottom,
  };
}

export function usePaginationState(
  scrollRef: { current: HTMLDivElement | null },
  onLoadOlder: () => void,
  onLoadNewer: () => void,
) {
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const pendingOlderAnchorRef = useRef<MessageScrollAnchor | null>(null);

  const requestOlderPage = useCallback(() => {
    if (loadingOlderRef.current) return;
    const el = scrollRef.current;
    if (el) pendingOlderAnchorRef.current = captureMessageScrollAnchor(el);
    loadingOlderRef.current = true;
    setIsLoadingOlder(true);
    onLoadOlder();
  }, [onLoadOlder, scrollRef]);

  const requestNewerPage = useCallback(() => {
    if (loadingNewerRef.current) return;
    loadingNewerRef.current = true;
    setIsLoadingNewer(true);
    onLoadNewer();
  }, [onLoadNewer]);

  return {
    isLoadingOlder,
    setIsLoadingOlder,
    isLoadingNewer,
    setIsLoadingNewer,
    loadingOlderRef,
    loadingNewerRef,
    pendingOlderAnchorRef,
    requestOlderPage,
    requestNewerPage,
  };
}
