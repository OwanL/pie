/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComposerInput } from '../../lib/protocol/index.js';
import {
  composerInputDetail,
  composerInputDisplayName,
  composerInputTitle,
} from './inputs';

interface ComposerAttachmentsProps {
  pendingComposerInputs: ComposerInput[];
  attachmentSummary: string;
  showAttachmentSummary: boolean;
  onRemoveInput: (inputId: string) => void;
}

function imagePreviewSrc(input: Extract<ComposerInput, { kind: 'imageBlob' }>): string {
  return `data:${input.mimeType};base64,${input.dataBase64}`;
}

export function ComposerAttachments({
  pendingComposerInputs,
  attachmentSummary,
  showAttachmentSummary,
  onRemoveInput,
}: ComposerAttachmentsProps) {
  if (pendingComposerInputs.length === 0) {
    return null;
  }

  return (
    <div class="composer-attachments" role="group" aria-label={`Pending attachments: ${attachmentSummary}`}>
      {showAttachmentSummary && <span class="composer-attachments-summary">{attachmentSummary}</span>}
      <div class="composer-attachments-strip">
        {pendingComposerInputs.map((input) => {
          const displayName = composerInputDisplayName(input);
          const detail = composerInputDetail(input);

          return (
            <div key={input.id} class="attachment-card" title={composerInputTitle(input)}>
              {input.kind === 'imageBlob' ? (
                <div class="attachment-card-thumb">
                  <img class="attachment-card-image" src={imagePreviewSrc(input)} alt={displayName} />
                </div>
              ) : (
                <div class="attachment-card-icon" aria-hidden="true">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                    <path d="M14 3v5h5" />
                    <path d="M9 13h6" />
                    <path d="M9 17h4" />
                  </svg>
                </div>
              )}
              <div class="attachment-card-meta">
                <span class="attachment-card-name">{displayName}</span>
                <span class="attachment-card-detail">{detail}</span>
              </div>
              <button
                class="attachment-card-remove"
                type="button"
                onClick={() => onRemoveInput(input.id)}
                aria-label={`Remove ${displayName}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
