/** One-shot image actions. Payloads must never be retained in ViewState. */
export type ImageAction = 'copy' | 'openInBrowser' | 'reveal';

export type ImageActionSource =
  | { kind: 'file'; path: string; reference?: string; workingDirectory?: string }
  | { kind: 'inline'; base64: string; mimeType: string };

export interface ImageActionRequest {
  action: ImageAction;
  source: ImageActionSource;
}
