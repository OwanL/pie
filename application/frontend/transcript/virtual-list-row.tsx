/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { getRowRenderer, type RowRendererProps } from './registry';

export function TranscriptVirtualRow(props: RowRendererProps) {
  const renderer = getRowRenderer(props.row.kind);
  if (!renderer) return null;
  return renderer(props) as any;
}
