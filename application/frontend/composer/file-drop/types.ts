import type { ComposerInputDraft } from '../../../lib/protocol/index.js';

export type FileLike = File | {
  path?: string;
  type?: string;
  name?: string;
  size?: number;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

export type DataTransferItemLike = {
  kind?: string;
  type?: string;
  getAsFile?: () => FileLike | null;
};

export type DataTransferLike = {
  types?: ArrayLike<string> | readonly string[];
  files?: ArrayLike<FileLike>;
  items?: ArrayLike<DataTransferItemLike>;
  getData: (format: string) => string;
};

export interface ComposerTransferExtraction {
  inputs: ComposerInputDraft[];
  unsupportedInputs: Array<Extract<ComposerInputDraft, { kind: 'fileBlob' }>>;
  rejectedFiles: string[];
}

export type ComposerTransferSource = 'drop' | 'paste';
