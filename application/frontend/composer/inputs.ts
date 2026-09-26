import type { ComposerInput } from '../../lib/protocol/index.js';

function formatSizeKb(sizeBytes: number): string {
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

export function composerInputDisplayName(input: ComposerInput): string {
  if (input.kind === 'filesystemPathRef') {
    return input.name || input.path.split(/[\\/]/).pop() || input.path;
  }

  if (input.kind === 'imageBlob') {
    return input.name || 'image';
  }

  return input.name || 'file';
}

export function formatImageMeta(input: Extract<ComposerInput, { kind: 'imageBlob' }>): string {
  const dimensions = input.width && input.height ? `${input.width}×${input.height}` : null;
  return [dimensions, formatSizeKb(input.sizeBytes)].filter(Boolean).join(' · ');
}

export function composerInputDetail(input: ComposerInput): string {
  if (input.kind === 'filesystemPathRef') {
    return input.path;
  }

  if (input.kind === 'imageBlob') {
    return formatImageMeta(input);
  }

  return formatSizeKb(input.sizeBytes);
}

export function composerInputTitle(input: ComposerInput): string {
  const name = composerInputDisplayName(input);
  const detail = composerInputDetail(input);
  return detail ? `${name} · ${detail}` : name;
}

export function describeComposerInputSummary(inputs: ComposerInput[]): string {
  const imageCount = inputs.filter((input) => input.kind === 'imageBlob').length;
  const pathCount = inputs.filter((input) => input.kind === 'filesystemPathRef').length;
  const genericCount = inputs.length - imageCount - pathCount;

  if (genericCount === 0) {
    if (imageCount > 0 && pathCount === 0) {
      return imageCount === 1 ? '1 image' : `${imageCount} images`;
    }

    if (pathCount > 0 && imageCount === 0) {
      return pathCount === 1 ? '1 path' : `${pathCount} paths`;
    }
  }

  return inputs.length === 1 ? '1 attachment' : `${inputs.length} attachments`;
}
