import { IMAGE_PREVIEW_MIME_BY_EXTENSION } from '../../lib/protocol/image-preview.js';
import { localFilePathReference } from './markdown-file-path';

export const INLINE_IMAGE_ATTRIBUTE = 'data-pie-inline-image';
export const INLINE_IMAGE_SELECTOR = `[${INLINE_IMAGE_ATTRIBUTE}]`;

/** Match the hover preview's conservative raster allowlist, excluding SVG. */
export function localRasterImageReference(href: string): string | null {
  const reference = localFilePathReference(href);
  const extension = reference && /\.[^./\\]+$/.exec(reference)?.[0]?.toLowerCase();
  return extension && IMAGE_PREVIEW_MIME_BY_EXTENSION[extension] ? reference : null;
}
