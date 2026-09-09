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

export function runtimeRendererSelection(context: { extensionPath: string }): { fallbackDir: string; notBefore: number } {
  return {
    fallbackDir: path.join(runtimeOutputDirectory(context), 'webview', 'panel'),
    notBefore: locations.get(context)?.publishedAt ?? 0,
  };
}
