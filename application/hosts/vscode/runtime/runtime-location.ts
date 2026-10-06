import * as path from 'node:path';

export interface RuntimeLocation {
  runtimeOutDir: string;
  generation: string | null;
  publishedAt: number;
}

// Bootstrap configuration belongs to this extension context, not to session
// state or process environment shared with other extension instances.
const locations = new WeakMap<object, RuntimeLocation>();

export function configureRuntimeLocation(context: object, location: RuntimeLocation): void {
  locations.set(context, { ...location });
}

export function runtimeOutputDirectory(context: { extensionPath: string }): string {
  return locations.get(context)?.runtimeOutDir ?? path.join(context.extensionPath, 'out');
}

/** Production renderer publications remain shared under extensionPath/out;
 * development renderer builds are read from this context's selected output. */
export function runtimeWebviewAssetDirectory(
  context: { extensionPath: string },
  viewName = 'panel',
): string {
  const outputDirectory = process.env.PIE_DEVELOPMENT_PI_WORKSPACE?.trim()
    ? runtimeOutputDirectory(context)
    : path.join(context.extensionPath, 'out');
  return path.join(outputDirectory, 'webview', viewName);
}

export function runtimeRendererSelection(context: { extensionPath: string }): { fallbackDir: string; notBefore: number } {
  return {
    fallbackDir: path.join(runtimeOutputDirectory(context), 'webview', 'panel'),
    notBefore: locations.get(context)?.publishedAt ?? 0,
  };
}
