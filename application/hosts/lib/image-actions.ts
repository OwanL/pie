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
  /** Optional OS-temp parent and clock for deterministic lifecycle tests. */
  tempRoot?: string;
  now?: () => number;
}

const IMAGE_ACTION_TEMP_DIRECTORY = 'pie-image-actions';
const IMAGE_ACTION_TEMP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const IMAGE_ACTION_TEMP_FILE = /^image-action-(\d+)-[0-9a-f-]+\.(?:html|png|jpe?g|gif|webp|bmp)$/i;

/** Retain artifacts for delayed browser/file consumers; later image actions reap owned files after 7 days. */
export async function performImageAction(request: ImageActionRequest, adapter: ImageActionAdapter): Promise<void> {
  const tempDirectory = await prepareImageActionTemp(adapter);
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
    filePath = imageActionTempFile(tempDirectory, adapter.now?.() ?? Date.now(), extension);
    try {
      await fs.writeFile(filePath, bytes, { flag: 'wx' });
      const preview = await readImagePreviewWithFallback({ path: filePath }, {
        ...adapter, exists: async () => true, readFile: readBoundedImageFile,
      });
      if (!preview) throw new Error('Image data does not match a supported image format.');
    } catch (error) {
      await fs.rm(filePath, { force: true });
      throw error;
    }
    // Keep the OS-temp copy: reveal/browser consumers may read it after return.
  }
  switch (request.action) {
    case 'copy':
      try { await adapter.copyImage(filePath); }
      finally {
        if (request.source.kind === 'inline') await fs.rm(filePath, { force: true });
      }
      return;
    case 'openInBrowser': {
      // An image file association may launch an editor, not a browser. A tiny
      // HTML wrapper uses the host's browser association and preserves bytes.
      const preview = await readImagePreviewWithFallback({ path: filePath }, {
        ...adapter, exists: async () => true, readFile: readBoundedImageFile,
      });
      if (request.source.kind === 'inline') await fs.rm(filePath, { force: true });
      if (!preview) throw new Error('Image is unavailable.');
      const browserPath = imageActionTempFile(tempDirectory, adapter.now?.() ?? Date.now(), '.html');
      await fs.writeFile(browserPath, `<!doctype html><meta charset="utf-8"><title>Image</title><style>body{margin:0;background:#222;display:grid;place-items:center;min-height:100vh}img{max-width:100%;height:auto}</style><img src="${preview.dataUrl}" alt="Image">`, { flag: 'wx' });
      return adapter.openInBrowser(browserPath);
    }
    case 'reveal': return adapter.reveal(filePath);
  }
}

function imageActionTempFile(directory: string, now: number, extension: string): string {
  return path.join(directory, `image-action-${Math.floor(now)}-${crypto.randomUUID()}${extension}`);
}

async function prepareImageActionTemp(adapter: ImageActionAdapter): Promise<string> {
  const directory = path.join(adapter.tempRoot ?? os.tmpdir(), IMAGE_ACTION_TEMP_DIRECTORY);
  await fs.mkdir(directory, { recursive: true });
  const now = adapter.now?.() ?? Date.now();
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch { return directory; }
  await Promise.all(entries.filter((entry) => entry.isFile() && IMAGE_ACTION_TEMP_FILE.test(entry.name)).map(async (entry) => {
    const match = IMAGE_ACTION_TEMP_FILE.exec(entry.name);
    if (!match || now - Number(match[1]) <= IMAGE_ACTION_TEMP_RETENTION_MS) return;
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isFile() && now - stat.mtimeMs > IMAGE_ACTION_TEMP_RETENTION_MS) await fs.unlink(filePath);
    } catch { /* Best-effort cleanup; action availability does not depend on reaping. */ }
  }));
  return directory;
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
export function buildWindowsClipboardCommand(filePath: string): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-STA', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [System.Drawing.Image]::FromFile($env:PIE_IMAGE_FILE); try { [System.Windows.Forms.Clipboard]::SetImage($image) } finally { $image.Dispose() }'],
    env: { ...process.env, PIE_IMAGE_FILE: filePath },
  };
}

export async function copyNativeImage(filePath: string): Promise<void> {
  if (process.platform === 'win32') {
    const invocation = buildWindowsClipboardCommand(filePath);
    await run(invocation.command, invocation.args, invocation.env);
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
