import * as path from 'node:path';

import * as vscode from 'vscode';

import { type RunObserver } from '../stats-service';
import type {
  ComposerInput,
  ComposerInputDraft,
  UserContentPart,
} from '../../shared/protocol';
import { modelSupportsInputKind } from './model-capability';
import type { GetArchState } from './model-capability';
import { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_INPUT_BYTES } from '../../shared/image-constraints';

import type { Event } from './events';

// Re-export for existing importers (composer attach path, tests). The pure
// model-capability check lives in the pure-spine `model-capability` module so
// the reducer can use it without pulling `vscode` into its module graph.
export { modelSupportsInputKind } from './model-capability';
export type { GetArchState } from './model-capability';
export type DispatchArchEvent = (event: Event) => void;

export function normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
  return uris.filter((uri) => uri.scheme === 'file');
}

export function validateAndMaterializeComposerInput(
  sessionPath: string,
  inputDraft: ComposerInputDraft,
  createComposerInputId: () => string,
  scheduleRender: () => void,
  runObserver: RunObserver,
  getArchState: GetArchState,
  dispatchArchEvent: DispatchArchEvent,
): ComposerInput | null {
  if (inputDraft.kind === 'filesystemPathRef') {
    const filesystemPath = inputDraft.path.trim();
    if (!filesystemPath) {
      dispatchArchEvent({ kind: 'NoticeShown', notice: 'Cannot attach file path: path is empty.' });
      scheduleRender();
      return null;
    }

    return {
      id: createComposerInputId(),
      kind: 'filesystemPathRef',
      path: filesystemPath,
      name: inputDraft.name.trim() || path.basename(filesystemPath) || filesystemPath,
      source: inputDraft.source,
    };
  }

  if (inputDraft.kind === 'imageBlob') {
    const mimeType = inputDraft.mimeType.trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      dispatchArchEvent({ kind: 'NoticeShown', notice: `Cannot attach image: unsupported type ${inputDraft.mimeType}.` });
      scheduleRender();
      return null;
    }
    if (!Number.isFinite(inputDraft.sizeBytes) || inputDraft.sizeBytes <= 0) {
      dispatchArchEvent({ kind: 'NoticeShown', notice: 'Cannot attach image: invalid size.' });
      scheduleRender();
      return null;
    }
    if (inputDraft.sizeBytes > MAX_IMAGE_INPUT_BYTES) {
      dispatchArchEvent({ kind: 'NoticeShown', notice: `Cannot attach image: exceeds the ${MAX_IMAGE_INPUT_BYTES} byte limit.` });
      scheduleRender();
      return null;
    }
    if (!inputDraft.dataBase64.trim()) {
      dispatchArchEvent({ kind: 'NoticeShown', notice: 'Cannot attach image: missing image data.' });
      scheduleRender();
      return null;
    }
    if (
      inputDraft.width !== undefined
      && (!Number.isFinite(inputDraft.width) || inputDraft.width <= 0)
    ) {
      dispatchArchEvent({ kind: 'NoticeShown', notice: 'Cannot attach image: invalid width.' });
      scheduleRender();
      return null;
    }
    if (
      inputDraft.height !== undefined
      && (!Number.isFinite(inputDraft.height) || inputDraft.height <= 0)
    ) {
      dispatchArchEvent({ kind: 'NoticeShown', notice: 'Cannot attach image: invalid height.' });
      scheduleRender();
      return null;
    }
    if (modelSupportsInputKind(sessionPath, undefined, 'image', getArchState) === false) {
      dispatchArchEvent({ kind: 'NoticeShown', notice: 'The selected model does not support image inputs.' });
      scheduleRender();
      return null;
    }

    return {
      id: createComposerInputId(),
      kind: 'imageBlob',
      mimeType,
      name: inputDraft.name.trim() || 'image',
      sizeBytes: inputDraft.sizeBytes,
      dataBase64: inputDraft.dataBase64,
      width: inputDraft.width,
      height: inputDraft.height,
      source: inputDraft.source,
    };
  }

  runObserver.onUnsupportedInputAttempt(sessionPath);
  dispatchArchEvent({ kind: 'NoticeShown', notice:
    'Arbitrary pasted file attachments are not supported yet. Please attach a filesystem path instead.',
  });
  scheduleRender();
  return null;
}

export function buildPromptText(text: string, inputs: ComposerInput[]): string {
  const sections: string[] = [];
  const pathPrelude = inputs
    .filter((input): input is Extract<ComposerInput, { kind: 'filesystemPathRef' }> =>
      input.kind === 'filesystemPathRef')
    .map((input) => `@${input.path}`);
  if (pathPrelude.length > 0) {
    sections.push(pathPrelude.join('\n'));
  }
  if (text.trim()) {
    sections.push(text);
  }
  return sections.join('\n\n');
}

export function buildOptimisticUserParts(
  text: string,
  inputs: ComposerInput[],
): UserContentPart[] | undefined {
  const userParts: UserContentPart[] = [];
  const promptText = buildPromptText(text, inputs);
  if (promptText) {
    userParts.push({ kind: 'text', text: promptText });
  }

  for (const input of inputs) {
    if (input.kind !== 'imageBlob') {
      continue;
    }
    userParts.push({
      kind: 'image',
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
      name: input.name,
      width: input.width,
      height: input.height,
    });
  }

  return userParts.length > 0 ? userParts : undefined;
}