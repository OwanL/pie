/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';

interface MessageHeaderProps {
  label?: string | null;
  duration?: string | null;
  durationTitle?: string;
  meta?: string | null;
  metaTitle?: string;
  timestamp?: string | null;
  timestampTitle?: string;
  timestampDateTime?: string;
  title?: string;
  actions?: ComponentChildren;
  align?: 'start' | 'end';
}

export function MessageHeader({ label, duration, durationTitle, meta, metaTitle, timestamp, timestampTitle, timestampDateTime, title, actions, align = 'start' }: MessageHeaderProps) {
  if (!label && !duration && !meta && !timestamp && !actions) return null;
  return (
    <div class={align === 'end' ? 'flex items-start justify-end gap-3' : 'flex items-start justify-between gap-3'}>
      <div class={align === 'end' ? 'flex min-w-0 flex-wrap items-center justify-end gap-[5px] text-right' : 'flex min-w-0 flex-wrap items-center gap-[5px]'} title={title}>
        {label && <span class="transcript-header-label">{label}</span>}
        {duration && <span class="text-[10px] text-muted/60" title={durationTitle}>{duration}</span>}
        {meta && <span class="min-w-0 break-words font-mono text-[10px] text-muted/60" title={metaTitle}>{meta}</span>}
        {timestamp && <time class="font-mono text-[10px] text-muted/60" dateTime={timestampDateTime} title={timestampTitle} aria-label={timestampTitle}>{timestamp}</time>}
      </div>
      {actions && (
        <div class="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-[5px]">
          {actions}
        </div>
      )}
    </div>
  );
}
