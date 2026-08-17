import type { ExtensionInfo } from '../../shared/protocol';
import { KNOWN_EXTENSIONS } from '../../shared/bundled-extensions.js';

function extensionLabel(id: string): string {
  return id
    .replace(/^@/, '')
    .split(/[/-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Build menu entries from the extensions the backend actually loaded. */
export function deriveAvailableExtensions(activeExtensionIds: string[]): ExtensionInfo[] {
  const activeIds = new Set(activeExtensionIds.map((id) => id.trim()).filter(Boolean));
  const known = KNOWN_EXTENSIONS.filter((extension) => activeIds.delete(extension.id));
  const unknown = [...activeIds].sort().map((id) => ({
    id,
    label: extensionLabel(id),
    description: 'Loaded pi extension',
  }));
  return [...known, ...unknown];
}
