/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { WebviewToHostMessage } from '../../lib/protocol/index.js';
import { filePathPreviewRequestFromTarget } from './file-path-interactions';
import { MARKDOWN_FILE_PATH_SELECTOR } from './markdown-file-path';
import {
  registerImagePreviewRequest,
  type ImagePreviewResult,
} from './image-preview-store';

const PREVIEW_DELAY_MS = 350;
const PREVIEW_TIMEOUT_MS = 8_000;
const DISMISS_DELAY_MS = 220;

interface PreviewState {
  requestId: string;
  status: 'loading' | 'ready' | 'unavailable';
  data?: ImagePreviewResult['data'];
  top: number;
  left: number;
}

interface ActivePreview {
  anchor: HTMLElement;
  sessionPath: string;
  path: string;
  reference: string;
  workingDirectory?: string;
  requestId?: string;
  pointerOver: boolean;
  focused: boolean;
  popoverHovered: boolean;
  showTimer?: number;
  hideTimer?: number;
  timeout?: number;
  unregister?: () => void;
  descriptionId?: string;
}

interface ImagePathPreviewProps {
  rootRef: RefObject<HTMLDivElement>;
  sessionPath: string | null;
  workingDirectory: string | null;
  postMessage: (message: WebviewToHostMessage) => unknown;
}

let previewRequestSequence = 0;

function nextPreviewRequestId(): string {
  previewRequestSequence += 1;
  return `image-preview:${Date.now().toString(36)}:${previewRequestSequence.toString(36)}`;
}

function pathElement(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const candidate = target.closest<HTMLElement>(MARKDOWN_FILE_PATH_SELECTOR);
  return candidate && root.contains(candidate) ? candidate : null;
}

export function ImagePathPreview({ rootRef, sessionPath, workingDirectory, postMessage }: ImagePathPreviewProps) {
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const previewImageRef = useRef<HTMLImageElement>(null);
  const bridgeRef = useRef<{ enter: () => void; leave: () => void } | null>(null);
  const activeRef = useRef<ActivePreview | null>(null);
  const currentSessionRef = useRef(sessionPath);
  const currentWorkingDirectoryRef = useRef(workingDirectory);
  const postMessageRef = useRef(postMessage);
  currentSessionRef.current = sessionPath;
  currentWorkingDirectoryRef.current = workingDirectory;
  postMessageRef.current = postMessage;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const clearOwnerTimers = (owner: ActivePreview) => {
      if (owner.showTimer !== undefined) window.clearTimeout(owner.showTimer);
      if (owner.hideTimer !== undefined) window.clearTimeout(owner.hideTimer);
      if (owner.timeout !== undefined) window.clearTimeout(owner.timeout);
      owner.showTimer = undefined;
      owner.hideTimer = undefined;
      owner.timeout = undefined;
      owner.unregister?.();
      owner.unregister = undefined;
      if (owner.descriptionId) {
        const descriptions = owner.anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
        const remaining = descriptions.filter((id) => id !== owner.descriptionId);
        if (remaining.length) owner.anchor.setAttribute('aria-describedby', remaining.join(' '));
        else owner.anchor.removeAttribute('aria-describedby');
        owner.descriptionId = undefined;
      }
    };

    const associateDescription = (owner: ActivePreview, descriptionId: string) => {
      const descriptions = owner.anchor.getAttribute('aria-describedby')?.split(/\s+/).filter(Boolean) ?? [];
      if (descriptions.includes(descriptionId)) return;
      owner.anchor.setAttribute('aria-describedby', [...descriptions, descriptionId].join(' '));
      owner.descriptionId = descriptionId;
    };

    const dismiss = () => {
      const owner = activeRef.current;
      if (owner) clearOwnerTimers(owner);
      activeRef.current = null;
      setPreview(null);
    };

    const scheduleDismiss = (owner: ActivePreview) => {
      if (owner.pointerOver || owner.focused || owner.popoverHovered || owner.hideTimer !== undefined) return;
      owner.hideTimer = window.setTimeout(() => {
        owner.hideTimer = undefined;
        if (activeRef.current === owner
          && !owner.pointerOver && !owner.focused && !owner.popoverHovered) dismiss();
      }, DISMISS_DELAY_MS);
    };

    const beginPreview = (anchor: HTMLElement, source: 'pointer' | 'focus') => {
      const request = filePathPreviewRequestFromTarget(anchor, currentWorkingDirectoryRef.current);
      const currentSessionPath = currentSessionRef.current;
      if (!request || !currentSessionPath) return;

      const existing = activeRef.current;
      if (existing?.anchor === anchor && existing.path === request.path && existing.sessionPath === currentSessionPath) {
        if (source === 'pointer') existing.pointerOver = true;
        else existing.focused = true;
        if (existing.hideTimer !== undefined) window.clearTimeout(existing.hideTimer);
        existing.hideTimer = undefined;
        return;
      }
      dismiss();
      const owner: ActivePreview = {
        anchor,
        sessionPath: currentSessionPath,
        path: request.path,
        reference: request.reference,
        ...(request.workingDirectory !== undefined ? { workingDirectory: request.workingDirectory } : {}),
        pointerOver: source === 'pointer',
        focused: source === 'focus',
        popoverHovered: false,
      };
      activeRef.current = owner;
      owner.showTimer = window.setTimeout(() => {
        owner.showTimer = undefined;
        if (activeRef.current !== owner || !root.contains(anchor) || !anchor.isConnected
          || currentSessionRef.current !== owner.sessionPath) {
          dismiss();
          return;
        }
        const requestId = nextPreviewRequestId();
        owner.requestId = requestId;
        associateDescription(owner, requestId);
        setPreview({ requestId, status: 'loading', top: 0, left: 0 });
        owner.unregister = registerImagePreviewRequest(requestId, owner.sessionPath, (result) => {
          if (activeRef.current !== owner || owner.requestId !== requestId) return;
          if (currentSessionRef.current !== owner.sessionPath
            || !root.contains(anchor) || !anchor.isConnected) {
            dismiss();
            return;
          }
          if (owner.timeout !== undefined) window.clearTimeout(owner.timeout);
          owner.timeout = undefined;
          owner.unregister = undefined;
          if (!result) {
            dismiss();
            return;
          }
          setPreview({
            requestId,
            status: result.status === 'ready' && result.data ? 'ready' : 'unavailable',
            ...(result.status === 'ready' && result.data ? { data: result.data } : {}),
            top: 0,
            left: 0,
          });
        });
        owner.timeout = window.setTimeout(() => {
          owner.timeout = undefined;
          owner.unregister?.();
          owner.unregister = undefined;
          if (activeRef.current === owner) {
            setPreview({ requestId, status: 'unavailable', top: 0, left: 0 });
          }
        }, PREVIEW_TIMEOUT_MS);
        postMessageRef.current({
          type: 'requestImagePreview',
          requestId,
          sessionPath: owner.sessionPath,
          path: owner.path,
          reference: owner.reference,
          ...(owner.workingDirectory !== undefined ? { workingDirectory: owner.workingDirectory } : {}),
        });
      }, PREVIEW_DELAY_MS);
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const anchor = pathElement(event.target, root);
      if (!anchor || (event.relatedTarget instanceof Node && anchor.contains(event.relatedTarget))) return;
      beginPreview(anchor, 'pointer');
    };
    const onPointerOut = (event: PointerEvent) => {
      const owner = activeRef.current;
      if (!owner || !owner.anchor.contains(event.target as Node)) return;
      if (event.relatedTarget instanceof Node && owner.anchor.contains(event.relatedTarget)) return;
      owner.pointerOver = false;
      if (event.relatedTarget instanceof Node && popoverRef.current?.contains(event.relatedTarget)) {
        owner.popoverHovered = true;
        if (owner.hideTimer !== undefined) window.clearTimeout(owner.hideTimer);
        owner.hideTimer = undefined;
        return;
      }
      scheduleDismiss(owner);
    };
    const onFocusIn = (event: FocusEvent) => {
      const anchor = pathElement(event.target, root);
      if (anchor) beginPreview(anchor, 'focus');
    };
    const onFocusOut = (event: FocusEvent) => {
      const owner = activeRef.current;
      if (!owner || !owner.anchor.contains(event.target as Node)) return;
      if (event.relatedTarget instanceof Node
        && (owner.anchor.contains(event.relatedTarget) || popoverRef.current?.contains(event.relatedTarget))) return;
      owner.focused = false;
      scheduleDismiss(owner);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !activeRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    const onAnchorActivation = (event: Event) => {
      const owner = activeRef.current;
      if (owner && event.target instanceof Node && owner.anchor.contains(event.target)) dismiss();
    };
    const onViewportChange = () => {
      const owner = activeRef.current;
      if (!owner) return;
      const rect = owner.anchor.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      if (!owner.anchor.isConnected || rect.bottom < rootRect.top || rect.top > rootRect.bottom) dismiss();
      else setPreview((current) => current ? { ...current, top: 0, left: 0 } : current);
    };

    root.addEventListener('pointerover', onPointerOver);
    root.addEventListener('pointerout', onPointerOut);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('click', onAnchorActivation, true);
    root.addEventListener('contextmenu', onAnchorActivation, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', dismiss);

    const anchorObserver = new MutationObserver(() => {
      const owner = activeRef.current;
      if (owner && (!owner.anchor.isConnected || !root.contains(owner.anchor))) dismiss();
    });
    anchorObserver.observe(root, { childList: true, subtree: true });

    // Expose only the current interaction's bridge functions to the popover.
    bridgeRef.current = {
      enter: () => {
        const owner = activeRef.current;
        if (!owner) return;
        owner.popoverHovered = true;
        if (owner.hideTimer !== undefined) window.clearTimeout(owner.hideTimer);
        owner.hideTimer = undefined;
      },
      leave: () => {
        const owner = activeRef.current;
        if (!owner) return;
        owner.popoverHovered = false;
        scheduleDismiss(owner);
      },
    };

    return () => {
      dismiss();
      root.removeEventListener('pointerover', onPointerOver);
      root.removeEventListener('pointerout', onPointerOut);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('click', onAnchorActivation, true);
      root.removeEventListener('contextmenu', onAnchorActivation, true);
      anchorObserver.disconnect();
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', dismiss);
      bridgeRef.current = null;
    };
  }, [rootRef, sessionPath, workingDirectory]);

  useLayoutEffect(() => {
    const current = preview;
    const owner = activeRef.current;
    const root = rootRef.current;
    const popover = popoverRef.current;
    if (!current || !owner || !root || !popover || owner.requestId !== current.requestId
      || !root.contains(owner.anchor) || !owner.anchor.isConnected) return;

    const anchor = owner.anchor.getBoundingClientRect();
    const bounds = root.getBoundingClientRect();
    const gutter = 8;
    const maxWidth = Math.max(0, Math.min(288, bounds.width - gutter * 2, window.innerWidth - gutter * 2));
    const maxHeight = Math.max(0, Math.min(244, bounds.height - gutter * 2, window.innerHeight - gutter * 2));
    popover.style.maxWidth = `${maxWidth}px`;
    popover.style.maxHeight = `${maxHeight}px`;
    const image = popover.querySelector('img');
    if (image) {
      image.style.maxWidth = `${Math.max(0, Math.min(272, maxWidth - gutter * 2))}px`;
      image.style.maxHeight = `${Math.max(0, Math.min(228, maxHeight - gutter * 2))}px`;
    }
    const size = popover.getBoundingClientRect();
    const minLeft = Math.max(bounds.left + gutter, gutter);
    const maxRight = Math.min(bounds.right - gutter, window.innerWidth - gutter);
    const maxLeft = Math.max(minLeft, maxRight - size.width);
    const left = Math.max(minLeft, Math.min(anchor.left, maxLeft));
    const minTop = Math.max(bounds.top + gutter, gutter);
    const maxBottom = Math.min(bounds.bottom - gutter, window.innerHeight - gutter);
    const roomBelow = maxBottom - anchor.bottom;
    const desiredTop = roomBelow >= size.height + gutter
      ? anchor.bottom + gutter
      : anchor.top - size.height - gutter;
    const maxTop = Math.max(minTop, maxBottom - size.height);
    const top = Math.max(minTop, Math.min(desiredTop, maxTop));
    if (Math.abs(top - current.top) > 0.5 || Math.abs(left - current.left) > 0.5) {
      setPreview({ ...current, top, left });
    }
  }, [preview, rootRef]);

  useLayoutEffect(() => {
    const image = previewImageRef.current;
    if (!image || preview?.status !== 'ready') return;

    const requestId = preview.requestId;
    const onLoad = () => setPreview((current) => current?.requestId === requestId
      ? { ...current }
      : current);
    const onError = () => setPreview((current) => current?.requestId === requestId
      ? { ...current, status: 'unavailable', data: undefined }
      : current);
    image.addEventListener('load', onLoad);
    image.addEventListener('error', onError);
    return () => {
      image.removeEventListener('load', onLoad);
      image.removeEventListener('error', onError);
    };
  }, [preview?.requestId, preview?.status, preview?.data?.dataUrl]);

  if (!preview) return null;
  return (
    <div
      ref={popoverRef}
      id={preview.requestId}
      class="image-path-preview"
      role="tooltip"
      aria-live="polite"
      data-testid="image-path-preview"
      style={{ top: `${preview.top}px`, left: `${preview.left}px` }}
      onMouseEnter={() => bridgeRef.current?.enter()}
      onMouseLeave={() => bridgeRef.current?.leave()}
    >
      {preview.status === 'loading' && <span>Loading preview…</span>}
      {preview.status === 'unavailable' && <span>Preview unavailable</span>}
      {preview.status === 'ready' && preview.data && (
        <img
          ref={previewImageRef}
          src={preview.data.dataUrl}
          alt={`Preview of ${activeRef.current?.reference ?? 'image'}`}
          draggable={false}
        />
      )}
    </div>
  );
}
