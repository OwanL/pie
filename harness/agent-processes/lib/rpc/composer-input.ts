/** Browser-to-host-to-backend composer attachment DTOs. */
export interface FilesystemPathComposerInput {
  id: string;
  kind: 'filesystemPathRef';
  path: string;
  name: string;
  source: 'picker' | 'drop';
}

export interface ImageBlobComposerInput {
  id: string;
  kind: 'imageBlob';
  mimeType: string;
  name: string;
  sizeBytes: number;
  dataBase64: string;
  width?: number;
  height?: number;
  source: 'paste' | 'drop';
}

export interface FileBlobComposerInput {
  id: string;
  kind: 'fileBlob';
  mimeType: string;
  name: string;
  sizeBytes: number;
  dataBase64: string;
  source: 'paste' | 'drop';
}

export type ComposerInput =
  | FilesystemPathComposerInput
  | ImageBlobComposerInput
  | FileBlobComposerInput;
