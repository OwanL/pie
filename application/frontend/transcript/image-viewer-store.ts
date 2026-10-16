export type ViewerSource = { kind: 'file'; path: string; reference?: string; workingDirectory?: string } | { kind: 'inline'; base64: string; mimeType: string };
export interface ViewerImage { src: string; alt: string; source: ViewerSource | null }
let image: ViewerImage | null = null;
const listeners = new Set<(image: ViewerImage | null) => void>();
export function openImageViewer(next: ViewerImage): void { image = next; for (const listener of listeners) listener(image); }
export function clearImageViewer(): void { image = null; for (const listener of listeners) listener(null); }
export function subscribeImageViewer(listener: (image: ViewerImage | null) => void): () => void {
  listeners.add(listener); listener(image); return () => { listeners.delete(listener); };
}
export function inlineViewerSource(src: string): ViewerSource | null {
  const match = /^data:(image\/(?:png|jpeg|gif|webp|bmp));base64,([a-z\d+/=\s]+)$/i.exec(src);
  return match ? { kind: 'inline', mimeType: match[1], base64: match[2] } : null;
}
