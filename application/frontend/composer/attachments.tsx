/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useLayoutEffect, useRef } from 'preact/hooks';
import type { ComposerInput } from '../../lib/protocol/index.js';
import {
  composerInputDetail,
  composerInputDisplayName,
  composerInputTitle,
  composerInputNameParts,
} from './inputs';

interface ComposerAttachmentsProps {
  pendingComposerInputs: ComposerInput[];
  attachmentSummary: string;
  onRemoveInput: (inputId: string) => void;
}

function imagePreviewSrc(input: Extract<ComposerInput, { kind: 'imageBlob' }>): string {
  return `data:${input.mimeType};base64,${input.dataBase64}`;
}

export function ComposerAttachments({
  pendingComposerInputs,
  attachmentSummary,
  onRemoveInput,
}: ComposerAttachmentsProps) {
  const groupRef = useRef<HTMLDivElement>(null);
  const removalFocus = useRef<{ id: string; index: number; card: Element; owner: HTMLElement } | null>(null);

  useLayoutEffect(() => {
    const pending = removalFocus.current;
    if (!pending || pendingComposerInputs.some(input => input.id === pending.id)) return;
    removalFocus.current = null;
    const active = pending.owner.ownerDocument.activeElement;
    // Do not override focus moved elsewhere while a host-backed removal was pending.
    if (active !== pending.owner.ownerDocument.body && !pending.card.contains(active)) return;
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>('.attachment-card-remove');
    const next = buttons?.[Math.min(pending.index, buttons.length - 1)];
    (next ?? pending.owner.querySelector<HTMLTextAreaElement>('textarea'))?.focus();
  }, [pendingComposerInputs]);

  if (pendingComposerInputs.length === 0) {
    return null;
  }

  return (
    <div ref={groupRef} class="composer-attachments" role="group" aria-label={`Pending attachments: ${attachmentSummary}`}>
      <div class="composer-attachments-strip">
        {pendingComposerInputs.map((input) => {
          const displayName = composerInputDisplayName(input);
          const detail = composerInputDetail(input);
          const nameParts = composerInputNameParts(displayName);

          return (
            <div key={input.id} class="attachment-card" title={composerInputTitle(input)}>
              {input.kind === 'imageBlob' ? (
                <div class="attachment-card-thumb">
                  <img tabIndex={0} role="button" class="attachment-card-image" src={imagePreviewSrc(input)} alt={displayName} />
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
                <span class="attachment-card-name" aria-label={displayName}>
                  <span class="attachment-card-name-prefix">{nameParts.prefix}</span>
                  {nameParts.suffix && <span class="attachment-card-name-suffix">{nameParts.suffix}</span>}
                </span>
                <span class="attachment-card-detail">{detail}</span>
              </div>
              <button
                class="attachment-card-remove"
                type="button"
                onClick={(event) => {
                  const card = event.currentTarget.closest('.attachment-card');
                  const owner = groupRef.current?.parentElement;
                  if (card && owner && card.contains(owner.ownerDocument.activeElement)) {
                    removalFocus.current = { id: input.id, index: pendingComposerInputs.indexOf(input), card, owner };
                  }
                  onRemoveInput(input.id);
                }}
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
