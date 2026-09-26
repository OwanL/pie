import type { ComposerInput } from '../lib/rpc/message-contract.js';
import type { SdkImageContent } from '../lib/sdk-integration/sdk';

export { normalizeThinkingLevel } from '../../model-providers/catalog/thinking-level.js';

function lowerFilesystemPathRefs(inputs: ComposerInput[]): string[] {
  return inputs
    .filter((input): input is Extract<ComposerInput, { kind: 'filesystemPathRef' }> =>
      input.kind === 'filesystemPathRef')
    .map((input) => `@${input.path}`);
}

export function lowerImageInputs(inputs: ComposerInput[]): SdkImageContent[] {
  return inputs
    .filter((input): input is Extract<ComposerInput, { kind: 'imageBlob' }> => input.kind === 'imageBlob')
    .map((input) => ({
      type: 'image',
      data: input.dataBase64,
      mimeType: input.mimeType,
    }));
}

export function buildPromptText(text: string, inputs: ComposerInput[]): string {
  const sections: string[] = [];
  const pathPrelude = lowerFilesystemPathRefs(inputs);
  if (pathPrelude.length > 0) {
    sections.push(pathPrelude.join('\n'));
  }
  if (text.trim()) {
    sections.push(text);
  }
  return sections.join('\n\n');
}
