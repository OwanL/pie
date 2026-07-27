import { useCallback, useRef, useState } from 'preact/hooks';

import {
  captureMessageScrollAnchor,
  type MessageScrollAnchor,
} from './scroll-anchor';

export function useScrollState(scrollRef: { current: HTMLDivElement | null }) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  // Reactive mirror of `autoFollowRef.current`. The ref gives synchronous
  // reads inside the rAF loop / scroll handlers; this state is the reactive
  // signal that lets `useSmoothAutoFollow`'s effect re-run (rebuilding the rAF
  // loop) when auto-follow transitions false->true while fully idle — without
  // it, scrolling back to the bottom (autoFollow false->true) while not
  // streaming/positioning changes no reactive dep, so the stopped loop never
  // restarts and a late non-busy height change (image/markdown load) drifts
  // the view off the bottom. `setAutoFollow` only transitions the state on an
  // actual boundary change, so per-scroll-event callers do not churn the state
  // (and thus the effect) every frame.
  const [autoFollow, setAutoFollowState] = useState(true);
  const autoFollowRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  // True only during recent downward scroll events. The scrolled-up anchor
  // yields while this is set so continuous scrollbar/middle-button dragging
  // toward the live edge cannot be counteracted by streaming row remeasures.
  const isScrollingTowardBottomRef = useRef(false);

  // Co-located setter: updates the ref (synchronous reads in the rAF loop's
  // idle gate) AND the reactive state together, so the two never diverge.
  // Gated on an actual value change: scroll events fire every frame, but
  // `follow` only differs from the current value on a bottom-boundary
  // crossing, so this never re-renders / rebuilds the rAF effect per-frame.
  const setAutoFollow = useCallback((next: boolean) => {
    if (autoFollowRef.current === next) return;
    autoFollowRef.current = next;
    setAutoFollowState(next);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Jumps must be instant: force non-smooth behavior around the snap so an
    // in-flight CSS smooth-scroll (or any `scroll-behavior: smooth` rule) can't
    // turn this into a slow ease that the auto-follow loop would then interrupt
    // and replace with frame-by-frame easing. Restored afterwards so the loop
    // continues to own smoothness while streaming.
    const prior = el.style.scrollBehavior;
    el.style.scrollBehavior = 'auto';
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = prior;
    lastScrollTopRef.current = el.scrollTop;
    setIsAtBottom(true);
  }, [scrollRef]);

  return {
    isAtBottom,
    setIsAtBottom,
    autoFollow,
    setAutoFollow,
    autoFollowRef,
    lastScrollTopRef,
    isScrollingTowardBottomRef,
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
