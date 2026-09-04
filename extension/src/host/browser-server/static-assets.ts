/**
 * Manifest-backed static serving for the browser server (browser server plan
 * §6.1).
 *
 * The compiled webview bundle (`out/webview/panel`) is served over HTTP using
 * the same Vite manifest the sidebar uses. Manifest/allowlist resolution, not
 * arbitrary path joining: only files referenced by the manifest (entry, CSS,
 * transitively imported chunks, and trusted entry-referenced worker chunks)
 * are ever served, plus an optional favicon.
 *
 * Generic manifest loading, entry discovery, asset hashing, and HTML metadata
 * are extracted here so the VS Code renderer (`host/webview/assets.ts`) and
 * the browser renderer share one source of truth; each keeps its own HTML/CSP
 * rendering (VS Code URIs/CSP vs ordinary HTTP URLs/CSP).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { resolvePublishedWebviewDir } from '../webview/published-generations';

interface ViteManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
  /** Lazy-loaded chunks (`import('./...')`), keyed by their src path. */
  dynamicImports?: string[];
  css?: string[];
  assets?: string[];
}

interface ViteManifest {
  [key: string]: ViteManifestChunk;
}

export function loadViteManifest(baseDir: string): Promise<ViteManifest> {
  const manifestPath = path.join(baseDir, '.vite', 'manifest.json');
  return fs.readFile(manifestPath, 'utf8').then((text) => JSON.parse(text) as ViteManifest);
}

export function findEntryChunk(manifest: ViteManifest): ViteManifestChunk | null {
  for (const chunk of Object.values(manifest)) {
    if (chunk.isEntry) return chunk;
  }
  return null;
}

/** Stable content hash of the manifest (the webview asset version). */
export function assetVersionFromManifest(manifest: ViteManifest): string {
  return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
}

/** MIME types for the hashed asset extensions the manifest can reference. */
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json; charset=utf-8',
};

export function contentTypeFor(fileName: string): string | null {
  return MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] ?? null;
}

/** Resolved static assets for one asset directory. */
export interface ResolvedBrowserAssets {
  assetVersion: string;
  /** Absolute filesystem paths (under the asset dir) that may be served. */
  files: ReadonlyMap<string, string>;
  /** Absolute path of the entry JS file. */
  entryPath: string;
  /** Absolute paths of the entry CSS files. */
  cssPaths: string[];
}

/** Absolute path → `/assets/<file>` URL. */
export function toAssetUrl(absolutePath: string, assetDir: string): string {
  const relative = path.relative(path.resolve(assetDir), absolutePath).split(path.sep).join('/');
  const nestedAssetsIndex = relative.lastIndexOf('/assets/');
  const manifestRelative = nestedAssetsIndex >= 0
    ? relative.slice(nestedAssetsIndex + 1)
    : relative;
  return `/assets/${urlKeyFor(manifestRelative)}`;
}

/** Minimal attribute escaping for meta content (defense in depth). */
function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * URL key for a manifest-relative file. Vite's output config places every
 * artifact under `assets/`, so manifest `file` paths already carry that
 * prefix; the documented HTTP surface is `/assets/<hashed-file>` (plan §6.1),
 * so the prefix is stripped here. A doubled `/assets/assets/...` URL would
 * break the browser's relative dynamic-import resolution: the entry chunk
 * imports `./transcript-host-<hash>.js` relative to its own URL, so the
 * entry must live at `/assets/panel-<hash>.js` for the chunk to resolve to
 * `/assets/transcript-host-<hash>.js`.
 */
function urlKeyFor(manifestRelativeFile: string): string {
  return manifestRelativeFile.startsWith('assets/')
    ? manifestRelativeFile.slice('assets/'.length)
    : manifestRelativeFile;
}

/**
 * Collect every file the manifest references (entry + css + statically and
 * dynamically imported chunks + chunk assets). This is the serving allowlist:
 * nothing outside it is ever resolved, and no directory listing exists.
 */
function collectManifestFiles(manifest: ViteManifest, entry: ViteManifestChunk, baseDir: string): Map<string, string> {
  const files = new Map<string, string>();
  const base = path.resolve(baseDir) + path.sep;
  const visited = new Set<string>();
  const addFile = (file: string): void => {
    if (!file || files.has(file)) return;
    const absolute = path.resolve(baseDir, file);
    // Manifest entries are relative to the webview dir; nothing outside may
    // be referenced. (path.resolve normalizes any `..`.)
    if (!absolute.startsWith(base)) return;
    files.set(urlKeyFor(file), absolute);
  };
  const visit = (chunk: ViteManifestChunk): void => {
    const file = chunk.file;
    if (!file || visited.has(file)) return;
    visited.add(file);
    addFile(file);
    for (const css of chunk.css ?? []) addFile(css);
    for (const asset of chunk.assets ?? []) addFile(asset);
    // Static imports AND dynamic entries: the panel lazy-loads the transcript
    // host via `import('./transcript/transcript-host')`, which Vite records
    // under `dynamicImports` — without it the chunk 404s and the browser
    // render crashes.
    for (const importedName of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
      const imported = manifest[importedName];
      if (imported) visit(imported);
    }
  };
  visit(entry);
  return files;
}

/** Browser-mode static assets, refreshed from the manifest at each HTML load. */
export class BrowserStaticAssets {
  private resolved: ResolvedBrowserAssets | null = null;
  private currentGenerationFiles: ReadonlyMap<string, string> | null = null;

  constructor(private readonly assetDir: string) {}

  /** Load the manifest and resolve the serving allowlist. Throws when the
   *  webview bundle is missing/malformed (terminal server start failure). */
  async load(): Promise<void> {
    const selectedAssetDir = await resolvePublishedWebviewDir(this.assetDir);
    const manifest = await loadViteManifest(selectedAssetDir);
    const entry = findEntryChunk(manifest);
    if (!entry) {
      throw new Error(`No Vite entry chunk found in manifest at ${path.join(selectedAssetDir, '.vite', 'manifest.json')}`);
    }
    const currentFiles = collectManifestFiles(manifest, entry, selectedAssetDir);
    const entryPath = currentFiles.get(urlKeyFor(entry.file));
    if (!entryPath) throw new Error(`Entry chunk ${entry.file} is not under the webview asset dir.`);
    // Vite 6 emits `?worker&url` chunks beside the entry but does not record
    // them in manifest.json. Recover only hashed worker filenames referenced
    // literally by the trusted built entry; the strict basename pattern and
    // resolved-under-asset-dir check keep arbitrary files out of the serving
    // allowlist while making browser and VS Code worker URLs symmetric.
    const entrySource = await fs.readFile(entryPath, 'utf8');
    const workerPattern = /["']\/assets\/([A-Za-z0-9_-]+-worker-[A-Za-z0-9_-]+\.js)["']/g;
    for (const match of entrySource.matchAll(workerPattern)) {
      const fileName = match[1];
      if (!fileName) continue;
      const absolute = path.resolve(selectedAssetDir, 'assets', fileName);
      const assetBase = path.resolve(selectedAssetDir) + path.sep;
      if (absolute.startsWith(assetBase)) currentFiles.set(fileName, absolute);
    }
    // Publish the new allowlist only after every referenced artifact exists.
    // Renderer generations are immutable and selected only after verification;
    // retaining the prior allowlist also keeps an already-loaded browser page's
    // hashed requests recoverable across the next publication.
    await Promise.all([...currentFiles.values()].map((file) => fs.access(file)));
    const files = new Map(this.currentGenerationFiles ?? []);
    for (const [key, value] of currentFiles) files.set(key, value);
    this.currentGenerationFiles = currentFiles;
    this.resolved = {
      assetVersion: assetVersionFromManifest(manifest),
      files,
      entryPath,
      cssPaths: (entry.css ?? [])
        .map((css) => currentFiles.get(urlKeyFor(css)))
        .filter((p): p is string => !!p),
    };
  }

  getAssetVersion(): string {
    if (!this.resolved) throw new Error('BrowserStaticAssets.load() must complete first.');
    return this.resolved.assetVersion;
  }

  /** Whether an absolute filesystem path is inside the webview asset dir. */
  isUnderAssetDir(absolutePath: string): boolean {
    const base = path.resolve(this.assetDir) + path.sep;
    return absolutePath.startsWith(base);
  }

  /**
   * Resolve one HTTP pathname to a servable file, or null. Only manifest-
   * allowlisted files under the asset dir are served; traversal and
   * non-allowlisted paths are rejected (never arbitrary path joining).
   */
  resolveRequest(pathname: string): { absolutePath: string; contentType: string } | null {
    if (!this.resolved) return null;
    // Strict allowlist: the only servable URL forms are the exact entry
    // (handled by the HTML route) and `/assets/<manifest-relative-file>`.
    if (typeof pathname !== 'string' || !pathname.startsWith('/assets/')) return null;
    const relative = pathname.slice('/assets/'.length);
    if (relative.length === 0) return null;
    // Reject traversal and absolute escapes outright (no path joining of
    // attacker-controlled segments).
    if (relative.includes('..') || relative.includes('\\') || relative.startsWith('/') || relative.includes('\0')) {
      return null;
    }
    const absolutePath = this.resolved.files.get(relative);
    if (!absolutePath || !this.isUnderAssetDir(absolutePath)) return null;
    const contentType = contentTypeFor(relative);
    if (!contentType) return null;
    return { absolutePath, contentType };
  }

  /**
   * Manifest-derived HTML shell for the browser (browser server plan §4.3):
   * stamps only stable page data — asset version, transport kind, and the
   * WebSocket route. No renderer identity is baked into HTML (a socket
   * reconnect creates a new registration without reloading the page; the
   * `rendererHello` on every accepted socket carries the live identity).
   * Returns the HTML plus the exact CSP header for the response.
   */
  renderHtml(options: { wsRoute: string; port: number; titleSuffix?: string; faviconRoute?: string }): { html: string; csp: string } {
    if (!this.resolved) throw new Error('BrowserStaticAssets.load() is required before renderHtml().');
    const nonce = crypto.randomBytes(16).toString('hex');
    const entryUrl = toAssetUrl(this.resolved.entryPath, this.assetDir);
    const styleTags = this.resolved.cssPaths
      .map((p) => `  <link href="${toAssetUrl(p, this.assetDir)}" rel="stylesheet" nonce="${nonce}" />`)
      .join('\n');
    const cspParts = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "worker-src 'self'",
      // Inline styles are allowed: the render-crash overlay is deliberately
      // self-contained (it must work even when the app stylesheet failed to
      // load), and markdown content is DOMPurify-sanitized before injection.
      // Per CSP3 a nonce in style-src would disable 'unsafe-inline', so the
      // nonce is omitted here (same-origin stylesheets are covered by 'self').
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' ws://127.0.0.1:${options.port}`,
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ];
    const csp = cspParts.join('; ');
    // `frame-ancestors` is ignored in a <meta> element (browsers warn); the
    // response header carries it, so the meta omits it to keep the console
    // clean.
    const metaCsp = cspParts.filter((part) => !part.startsWith('frame-ancestors')).join('; ');
    const suffix = options.titleSuffix ? ` — ${options.titleSuffix}` : '';
    const faviconTag = options.faviconRoute
      ? `  <link rel="icon" type="image/svg+xml" href="${escapeHtmlAttribute(options.faviconRoute)}" />\n`
      : '';
    return {
      csp,
      html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${metaCsp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="pie-asset-version" content="${this.resolved.assetVersion}" />
  <meta name="pie-transport" content="browser" />
  <meta name="pie-ws-route" content="${escapeHtmlAttribute(options.wsRoute)}" />
${faviconTag}${styleTags}
  <title>pie${suffix}</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${entryUrl}"></script>
</body>
</html>
`,
    };
  }
}
