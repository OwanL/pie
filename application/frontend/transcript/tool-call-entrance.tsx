/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { useRef } from 'preact/hooks';
import type { ChatMessagePart } from '../../lib/protocol/index.js';

/** Initial/restored parts never enter. Only additions to an already mounted live turn do. */
export function useAppendedToolCalls(parts: readonly ChatMessagePart[], streaming: boolean): ReadonlySet<string> {
  const seen = useRef<Set<string> | null>(null);
  const ids = parts.flatMap(part => part.kind === 'toolCall' ? [part.toolCall.id] : []);
  if (seen.current === null) {
    seen.current = new Set(ids);
    return new Set();
  }
  const appended = new Set<string>();
  for (const id of ids) {
    if (streaming && !seen.current.has(id)) appended.add(id);
    seen.current.add(id);
  }
  return appended;
}

/** Animate inside the measured virtual row, never its outer positioning transform. */
export function ToolCallEntrance({ enter, className, parallelGroupId, children }: {
  enter: boolean;
  className: string;
  parallelGroupId?: string;
  children: ComponentChildren;
}) {
  // Updating status or settling live→durable must not restart an entrance.
  const entered = useRef(enter);
  return <div class={className} data-parallel-group-id={parallelGroupId}
    data-tool-entered={entered.current ? 'true' : undefined}>{children}</div>;
}
