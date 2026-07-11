import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { DEFAULT_WEBVIEW_VIEW_NAME, getWebviewAssetDir } from './hot-reload';

interface ViteManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  imports?: string[];
  css?: string[];
  assets?: string[];
}

interface ViteManifest {
  [key: string]: ViteManifestChunk;
}

function readManifest(baseDir: string): Promise<ViteManifest> {
  const manifestPath = path.join(baseDir, '.vite', 'manifest.json');
  return fs.readFile(manifestPath, 'utf8').then((text) => JSON.parse(text) as ViteManifest);
}

function findEntryChunk(manifest: ViteManifest): ViteManifestChunk | null {
  for (const chunk of Object.values(manifest)) {
    if (chunk.isEntry) {
      return chunk;
    }
  }
  return null;
}

function assetUri(webview: vscode.Webview, baseDir: string, relativePath: string): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.file(path.join(baseDir, relativePath)));
}

function renderWebviewHtmlFromManifest(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
  manifest: ViteManifest,
  assetVersionOverride?: string,
): string {
  const viewName = DEFAULT_WEBVIEW_VIEW_NAME;
  const baseDir = getWebviewAssetDir(context.extensionPath, viewName);
  const entry = findEntryChunk(manifest);
  if (!entry) {
    throw new Error(`No Vite entry chunk found in manifest at ${path.join(baseDir, '.vite', 'manifest.json')}`);
  }

  const manifestHash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
  const assetVersion = assetVersionOverride ?? manifestHash;
  const nonce = crypto.randomBytes(16).toString('hex');

  const scriptUri = assetUri(webview, baseDir, entry.file).toString();
  const styleUris = (entry.css ?? []).map((cssFile) => assetUri(webview, baseDir, cssFile).toString());

  const styleTags = styleUris
    .map((uri) => `  <link href="${uri}" rel="stylesheet" nonce="${nonce}" />`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="pie-asset-version" content="${assetVersion}" />
${styleTags}
  <title>pie</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>
`;
}

export async function resolveWebviewHtml(
  context: vscode.ExtensionContext,
  webview: vscode.Webview,
): Promise<{ html: string; assetVersion: string }> {
  const baseDir = getWebviewAssetDir(context.extensionPath, DEFAULT_WEBVIEW_VIEW_NAME);
  const manifest = await readManifest(baseDir);
  const assetVersion = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
  return {
    assetVersion,
    html: renderWebviewHtmlFromManifest(context, webview, manifest, assetVersion),
  };
}

export function getWebviewRoots(context: vscode.ExtensionContext): vscode.Uri[] {
  const viewName = DEFAULT_WEBVIEW_VIEW_NAME;
  return [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', viewName)];
}
