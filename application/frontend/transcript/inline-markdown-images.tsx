/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { RefObject } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { animateHeightChange, cancelHeightMotion } from '../lib/components/height-motion';
import type { WebviewToHostMessage } from '../../lib/protocol/index.js';
import { INLINE_IMAGE_ATTRIBUTE, INLINE_IMAGE_SELECTOR, localRasterImageReference } from './inline-markdown-image';
import { resolveLocalFilePath } from './markdown-file-path';
import { registerImagePreviewRequest } from './image-preview-store';

// Bounds cover queued, in-flight AND ready images (including their DOM bytes).
export const MAX_INLINE_IMAGE_OWNERS = 8;
const MAX_CONCURRENT_REQUESTS = 2;
const TIMEOUT_MS = 8_000;
let sequence = 0;
const nextId = () => `inline-image:${Date.now().toString(36)}:${++sequence}`;

interface Props {
  rootRef: RefObject<HTMLDivElement>;
  sessionPath: string | null;
  workingDirectory: string | null;
  postMessage: (message: WebviewToHostMessage) => unknown;
}
interface Owner {
  reference: string;
  state: 'queued' | 'pending' | 'settled';
  unregister?: () => void;
  timer?: number;
  image?: HTMLImageElement;
}

/** Hydrate only mounted, visible placeholders. All ownership and bytes die
 * with the root/session/cwd; neither markdown caches nor snapshots hold bytes. */
export function InlineMarkdownImages({ rootRef, sessionPath, workingDirectory, postMessage }: Props) {
  const postRef = useRef(postMessage);
  postRef.current = postMessage;
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !sessionPath) return;
    let disposed = false;
    let active = 0;
    let pumping = false;
    let scanScheduled = false;
    const scheduleScan = () => {
      if (disposed || scanScheduled) return;
      scanScheduled = true;
      queueMicrotask(() => {
        scanScheduled = false;
        if (!disposed) scan();
      });
    };
    const owners = new Map<HTMLElement, Owner>();
    const attempted = new WeakSet<HTMLElement>();
    const visible = new WeakSet<HTMLElement>();
    const observed = new Set<HTMLElement>();
    const valid = (node: HTMLElement, owner: Owner) => !disposed && node.isConnected
      && root.contains(node) && owners.get(node) === owner && node.getAttribute(INLINE_IMAGE_ATTRIBUTE) === owner.reference;
    const resetDom = (node: HTMLElement, owner: Owner) => {
      cancelHeightMotion(node);
      if (owner.image) {
        owner.image.removeAttribute('src');
        owner.image.remove();
        owner.image = undefined;
      }
      node.querySelector<HTMLElement>('.inline-markdown-image-fallback')?.removeAttribute('hidden');
    };
    const cancel = (node: HTMLElement, owner: Owner) => {
      owner.unregister?.();
      if (owner.timer !== undefined) window.clearTimeout(owner.timer);
      if (owner.state === 'pending') active--;
      owner.state = 'settled';
      resetDom(node, owner);
      owners.delete(node);
    };
    // Attempt history survives release: fallback-only nodes never retry, but
    // must not consume a slot needed by other visible placeholders.
    const releaseEmpty = (node: HTMLElement, owner: Owner) => {
      if (owner.state === 'settled' && !owner.image && owners.get(node) === owner) {
        owners.delete(node);
        scheduleScan();
      }
    };
    const pump = () => {
      if (disposed) return;
      if (pumping) { scheduleScan(); return; }
      pumping = true;
      try {
        for (const [node, owner] of owners) {
          if (!valid(node, owner)) { cancel(node, owner); continue; }
          if (active >= MAX_CONCURRENT_REQUESTS) break;
          if (owner.state !== 'queued' || (intersection && !visible.has(node))) continue;
          const path = resolveLocalFilePath(owner.reference, workingDirectory);
          if (!path) { owner.state = 'settled'; releaseEmpty(node, owner); continue; }
          owner.state = 'pending';
          active++;
          const requestId = nextId();
          const finish = () => {
            if (owner.state !== 'pending') return false;
            owner.state = 'settled';
            active--;
            owner.unregister?.();
            owner.unregister = undefined;
            if (owner.timer !== undefined) window.clearTimeout(owner.timer);
            owner.timer = undefined;
            return true;
          };
          owner.unregister = registerImagePreviewRequest(requestId, sessionPath, (result) => {
            if (!finish()) return;
            if (valid(node, owner) && result?.status === 'ready' && result.data) {
              const image = node.ownerDocument.createElement('img');
              image.alt = node.getAttribute('data-pie-image-alt') ?? '';
              if (node.title) image.title = node.title;
              image.draggable = false;
              // A linked preview is label content, not a second keyboard action.
              // Keep focus/Enter activation on the native anchor itself.
              if (!node.closest('a[href]')) {
                image.tabIndex = 0;
                image.setAttribute('role', 'button');
                image.setAttribute('aria-label', `View ${image.alt || 'image'}`);
              }
              image.dataset.pieImagePath = path;
              image.dataset.pieImageReference = owner.reference;
              if (workingDirectory) image.dataset.pieImageCwd = workingDirectory;
              owner.image = image;
              const current = () => valid(node, owner) && owner.image === image;
              const fail = () => {
                if (!current()) return;
                resetDom(node, owner);
                releaseEmpty(node, owner);
              };
              let loading = false;
              let alreadyLoaded = false;
              const reveal = () => {
                if (!current() || image.parentNode) return;
                if (!image.naturalWidth || !image.naturalHeight) { fail(); return; }
                // Reserve the decoded aspect ratio before inserting into layout.
                image.width = image.naturalWidth;
                image.height = image.naturalHeight;
                animateHeightChange(node, () => {
                  node.appendChild(image);
                  node.querySelector<HTMLElement>('.inline-markdown-image-fallback')?.setAttribute('hidden', '');
                }, alreadyLoaded ? { duration: 0 } : undefined);
              };
              const loaded = () => {
                if (loading || !current()) return;
                loading = true;
                // Decode off-DOM: neither load nor a later intrinsic decode may
                // change the visible placeholder's occupied space independently.
                if (typeof image.decode === 'function') image.decode().then(reveal, fail);
                else reveal();
              };
              image.addEventListener('error', fail, { once: true });
              image.addEventListener('load', loaded, { once: true });
              image.src = result.data.dataUrl;
              // A synchronously available browser-cached image need not replay
              // hydration motion when revisiting mounted history.
              alreadyLoaded = image.complete && image.naturalWidth > 0;
              if (alreadyLoaded) loaded();
            }
            releaseEmpty(node, owner);
            // Disconnect reset cancels every owner before copied store callbacks
            // run, so finish() above rejects them. A wrong-session response can
            // still free capacity for other current owners without any retry.
            pump();
          });
          owner.timer = window.setTimeout(() => {
            if (finish()) { releaseEmpty(node, owner); pump(); }
          }, TIMEOUT_MS);
          try {
            const accepted = postRef.current({
              type: 'requestImagePreview', requestId, sessionPath, path, reference: owner.reference,
              ...(workingDirectory !== null ? { workingDirectory } : {}),
            });
            if (accepted === false && finish()) releaseEmpty(node, owner);
          } catch {
            if (finish()) releaseEmpty(node, owner);
          }
        }
      } finally {
        pumping = false;
      }
    };
    const enqueue = (node: HTMLElement) => {
      if (owners.size >= MAX_INLINE_IMAGE_OWNERS || attempted.has(node) || !node.isConnected || !root.contains(node)) return;
      const reference = node.getAttribute(INLINE_IMAGE_ATTRIBUTE);
      if (!reference || !localRasterImageReference(reference)) return;
      attempted.add(node);
      owners.set(node, { reference, state: 'queued' });
    };
    const intersection = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        if (entry.isIntersecting) { visible.add(node); enqueue(node); }
        else visible.delete(node);
      }
      pump();
    }, { root });
    const scan = () => {
      if (disposed) return;
      for (const [node, owner] of owners) if (!valid(node, owner)) cancel(node, owner);
      for (const node of observed) {
        if (!root.contains(node) || !node.hasAttribute(INLINE_IMAGE_ATTRIBUTE)) {
          intersection?.unobserve(node);
          observed.delete(node);
        }
      }
      for (const node of root.querySelectorAll<HTMLElement>(INLINE_IMAGE_SELECTOR)) {
        if (!observed.has(node)) { observed.add(node); intersection?.observe(node); }
        // Non-layout DOM tests do not implement IntersectionObserver.
        if (!intersection || visible.has(node)) enqueue(node);
      }
      pump();
    };
    // A renderer-local lifecycle subscription, deliberately NOT a wire request.
    // Keep it before actual requests so clearImagePreviewRequests resets ready
    // DOM and cancels queued work too, without starting a disconnect retry loop.
    const resetId = nextId();
    let unregisterReset: () => void;
    const subscribeReset = () => registerImagePreviewRequest(resetId, sessionPath, () => {
      // Do not let the DOM mutations caused by removing ready images enqueue
      // previously capacity-blocked placeholders during a disconnect/reset.
      // Existing placeholders stay readable until the row/session remounts.
      for (const node of observed) attempted.add(node);
      for (const [node, owner] of owners) cancel(node, owner);
      if (!disposed) unregisterReset = subscribeReset();
    });
    unregisterReset = subscribeReset();
    const mutations = new MutationObserver(scan);
    mutations.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: [INLINE_IMAGE_ATTRIBUTE] });
    scan();
    return () => {
      disposed = true;
      mutations.disconnect();
      intersection?.disconnect();
      unregisterReset();
      for (const [node, owner] of owners) cancel(node, owner);
      observed.clear();
    };
  }, [rootRef, sessionPath, workingDirectory]);
  return null;
}
