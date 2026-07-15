/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo, useState } from 'preact/hooks';

import { Collapsible } from '../components/collapsible';
import { renderMarkdown } from '../markdown';

interface CompactionSummaryProps {
  summary: string;
}

/**
 * The SDK persists history compaction as an entry rather than an ordinary chat
 * message. Keep its (often long) replacement context available in the
 * transcript without making it dominate the conversation by default.
 */
export function CompactionSummary({ summary }: CompactionSummaryProps) {
  const [open, setOpen] = useState(false);
  const html = useMemo(() => (open ? renderMarkdown(summary) : ''), [open, summary]);

  return (
    <Collapsible
      open={open}
      onToggle={setOpen}
      ariaLabel="Toggle compaction summary"
      class="compaction-summary-card"
      headerClass="px-2 py-[5px]"
      bodyClass="px-2.5 pb-2.5 pt-1 leading-relaxed text-foreground"
      header={<span class="transcript-header-label">Compaction summary</span>}
    >
      <div class="message-body" dangerouslySetInnerHTML={{ __html: html }} />
    </Collapsible>
  );
}
