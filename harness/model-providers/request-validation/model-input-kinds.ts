import type { ModelInputKind } from '../catalog/model-contract.js';

function normalizeModelInputKinds(value: unknown): ModelInputKind[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const kinds = [...new Set(
    value.filter((kind): kind is ModelInputKind => kind === 'text' || kind === 'image'),
  )];

  if (kinds.length === 0) {
    return ['text'];
  }

  return kinds.includes('text') ? kinds : ['text', ...kinds];
}

export function resolveModelInputKinds(model: Record<string, unknown>): ModelInputKind[] {
  return normalizeModelInputKinds(model['input']) ?? ['text'];
}
