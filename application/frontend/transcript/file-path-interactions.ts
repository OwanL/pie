import type { TranscriptContextMenuHandler } from './types';
import { resolveClosestCapableTarget } from '../lib/components/closest-capable-target';
import {
  MARKDOWN_FILE_PATH_ATTRIBUTE,
  MARKDOWN_FILE_PATH_SELECTOR,
  resolveLocalFilePath,
} from './markdown-file-path';
import { IMAGE_PREVIEW_MIME_BY_EXTENSION } from '../../lib/protocol/image-preview.js';

interface FilePathElement {
  getAttribute?: (name: string) => string | null;
}

/** Find a rendered local-path element from a delegated event target. */
export function filePathReferenceFromTarget(target: EventTarget | null): string | null {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) return null;

  const element = candidate.closest(MARKDOWN_FILE_PATH_SELECTOR) as FilePathElement | null;
  const value = element?.getAttribute?.(MARKDOWN_FILE_PATH_ATTRIBUTE)?.trim();
  return value || null;
}

/** Resolve a rendered path target using the session's active working directory. */
export function resolvedFilePathFromTarget(target: EventTarget | null, workingDirectory: string | null): string | null {
  const reference = filePathReferenceFromTarget(target);
  return reference ? resolveLocalFilePath(reference, workingDirectory) : null;
}

export function filePathOpenRequestFromTarget(
  target: EventTarget | null,
  workingDirectory: string | null,
): { path: string; reference: string; workingDirectory?: string } | null {
  const reference = filePathReferenceFromTarget(target);
  if (!reference) return null;
  const path = resolveLocalFilePath(reference, workingDirectory);
  if (!path) return null;
  return {
    path,
    reference,
    ...(workingDirectory !== null ? { workingDirectory } : {}),
  };
}

/** The image-path hover affordance shares click's exact path/cwd resolution. */
export function filePathPreviewRequestFromTarget(
  target: EventTarget | null,
  workingDirectory: string | null,
): { path: string; reference: string; workingDirectory?: string } | null {
  const request = filePathOpenRequestFromTarget(target, workingDirectory);
  if (!request) return null;
  const leaf = request.path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '';
  const extension = /\.[^.]+$/u.exec(leaf)?.[0]?.toLowerCase();
  return extension && IMAGE_PREVIEW_MIME_BY_EXTENSION[extension] ? request : null;
}

interface DelegatedEvent {
  target: EventTarget | null;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function hasTextSelection(): boolean {
  const selection = typeof window !== 'undefined' ? window.getSelection?.() : null;
  return !!selection && !selection.isCollapsed;
}

function suppressPathDefault(event: DelegatedEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/** Handle a click received by a markdown body rather than by injected HTML. */
export function handleDelegatedFilePathClick(
  event: DelegatedEvent,
  workingDirectory: string | null,
  onOpenFile: (path: string, reference?: string, workingDirectory?: string) => void,
): boolean {
  const request = filePathOpenRequestFromTarget(event.target, workingDirectory);
  if (!request) return false;

  // A drag-selection ending on a path also emits click. Match native-link
  // behavior: suppress the anchor's default navigation while leaving the
  // selection available for copying instead of opening the file.
  if (hasTextSelection()) {
    suppressPathDefault(event);
    return true;
  }

  suppressPathDefault(event);
  onOpenFile(request.path, request.reference, request.workingDirectory);
  return true;
}

/** Keyboard activation for the non-native inline-code link affordance. */
export function handleDelegatedFilePathKeyDown(
  event: DelegatedEvent & { key: string; repeat?: boolean },
  workingDirectory: string | null,
  onOpenFile: (path: string, reference?: string, workingDirectory?: string) => void,
): boolean {
  if (event.key !== 'Enter' && event.key !== ' ') return false;

  const request = filePathOpenRequestFromTarget(event.target, workingDirectory);
  if (!request) return false;

  // Prevent the native anchor activation for every recognized keydown. This
  // also makes holding Enter/Space safe: auto-repeat is consumed but opens
  // nothing after the first keydown.
  suppressPathDefault(event);
  if (event.repeat || hasTextSelection()) return true;

  onOpenFile(request.path, request.reference, request.workingDirectory);
  return true;
}

/** Open the path-specific menu before the enclosing message menu can handle it. */
export function handleDelegatedFilePathContextMenu(
  event: DelegatedEvent,
  workingDirectory: string | null,
  onContextMenu: TranscriptContextMenuHandler,
): boolean {
  const request = filePathOpenRequestFromTarget(event.target, workingDirectory);
  if (!request) return false;
  event.preventDefault();
  event.stopPropagation();
  onContextMenu('filePath', request.path, event as MouseEvent, undefined, {
    reference: request.reference,
    ...(request.workingDirectory !== undefined ? { workingDirectory: request.workingDirectory } : {}),
  });
  return true;
}
