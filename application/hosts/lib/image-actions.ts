import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import type { ImageActionRequest } from '../../lib/platform-contracts/image-actions.js';
import { IMAGE_PREVIEW_MIME_BY_EXTENSION, MAX_IMAGE_PREVIEW_BYTES } from '../../lib/protocol/image-preview.js';
import { readImagePreviewWithFallback, resolveFilePathWithFallback, type FilePathResolverAdapter } from './image-preview.js';

export interface ImageActionAdapter extends FilePathResolverAdapter {
  copyImage(filePath: string): Promise<void>;
  openInBrowser(filePath: string): Promise<void>;
  reveal(filePath: string): Promise<void>;
}

/** No state, cache, or transcript retention: only the action owns these bytes. */
export async function performImageAction(request: ImageActionRequest, adapter: ImageActionAdapter): Promise<void> {
  let filePath: string;
  if (request.source.kind === 'file') {
    const resolved = await resolveFilePathWithFallback(request.source, adapter);
    if (resolved.status !== 'found') throw new Error('Image file is unavailable or ambiguous.');
    filePath = resolved.path;
    const preview = await readImagePreviewWithFallback({ path: filePath }, {
      ...adapter,
      readFile: readBoundedImageFile,
    });
    if (!preview) throw new Error('Image is unsupported, unreadable, or exceeds 10 MiB.');
  } else {
    const { base64, mimeType } = request.source;
    const extension = Object.entries(IMAGE_PREVIEW_MIME_BY_EXTENSION).find(([, mime]) => mime === mimeType)?.[0];
    if (!extension || base64.length === 0 || base64.length > Math.ceil(MAX_IMAGE_PREVIEW_BYTES / 3) * 4
      || (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))) {
      throw new Error('Invalid or oversized image payload.');
    }
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > MAX_IMAGE_PREVIEW_BYTES) throw new Error('Image exceeds 10 MiB.');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-image-'));
    filePath = path.join(directory, `image${extension}`);
    try {
      await fs.writeFile(filePath, bytes);
      const preview = await readImagePreviewWithFallback({ path: filePath }, {
        ...adapter, exists: async () => true, readFile: readBoundedImageFile,
      });
      if (!preview) throw new Error('Image data does not match a supported image format.');
    } catch (error) {
      await fs.rm(directory, { recursive: true, force: true });
      throw error;
    }
    // Keep the OS-temp copy: reveal/browser consumers may read it after return.
  }
  switch (request.action) {
    case 'copy':
      try { await adapter.copyImage(filePath); }
      finally {
        if (request.source.kind === 'inline') await fs.rm(path.dirname(filePath), { recursive: true, force: true });
      }
      return;
    case 'openInBrowser': {
      // An image file association may launch an editor, not a browser. A tiny
      // HTML wrapper uses the host's browser association and preserves bytes.
      const preview = await readImagePreviewWithFallback({ path: filePath }, {
        ...adapter, exists: async () => true, readFile: readBoundedImageFile,
      });
      if (request.source.kind === 'inline') await fs.rm(path.dirname(filePath), { recursive: true, force: true });
      if (!preview) throw new Error('Image is unavailable.');
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-image-browser-'));
      const browserPath = path.join(directory, 'image.html');
      await fs.writeFile(browserPath, `<!doctype html><meta charset="utf-8"><title>Image</title><style>body{margin:0;background:#222;display:grid;place-items:center;min-height:100vh}img{max-width:100%;height:auto}</style><img src="${preview.dataUrl}" alt="Image">`);
      return adapter.openInBrowser(browserPath);
    }
    case 'reveal': return adapter.reveal(filePath);
  }
}

async function readBoundedImageFile(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Image exceeds its size bound.');
    const buffer = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < buffer.length) {
      const result = await handle.read(buffer, count, buffer.length - count, count);
      if (!result.bytesRead) break;
      count += result.bytesRead;
    }
    return buffer.subarray(0, count);
  } finally {
    await handle.close();
  }
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...(env ? { env } : {}), windowsHide: true }, (error) => error ? reject(error) : resolve());
  });
}

/** Native clipboard image, never the path or data URL as clipboard text. */
export async function copyNativeImage(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [System.Drawing.Image]::FromFile($env:PIE_IMAGE_FILE); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }'],
    { ...process.env, PIE_IMAGE_FILE: filePath });
    return;
  }
  // No portable image clipboard API exists in Node. Do not claim text is an image.
  throw new Error('Native image clipboard is unavailable on this host.');
}

export async function openNativeImage(filePath: string): Promise<void> {
  const url = pathToFileURL(filePath).href;
  if (process.platform === 'win32') return run('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  if (process.platform === 'darwin') return run('open', [url]);
  return run('xdg-open', [url]);
}

export async function revealNativeImage(filePath: string): Promise<void> {
  if (process.platform === 'win32') return run('explorer.exe', [`/select,${filePath}`]);
  if (process.platform === 'darwin') return run('open', ['-R', filePath]);
  return run('xdg-open', [path.dirname(filePath)]);
}
