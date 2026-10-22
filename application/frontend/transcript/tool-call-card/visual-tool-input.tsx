/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { isRecord } from '../../../../lib/validation/type-guards';
import { ResizablePre } from '../../lib/components/resizable-pre';
import { highlightToolResultText, languageForToolInput, stringifyValueAsYamlText } from '../highlight';
import { SegmentedText } from './segmented-text';
import { requestedReplacements } from './display-model';

export function ToolText({ text, identity, language, scrollLabel = 'Tool input' }: { text: string; identity: string; language?: string; scrollLabel?: string }) {
  return <ResizablePre class="tool-call-pre tool-call-pre-resizable hljs-scope" minHeight={80} scrollLabel={scrollLabel}>
    <SegmentedText text={text} identity={identity} renderSegment={(segment) => <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(segment, language) }} />} />
  </ResizablePre>;
}

export function ToolInputFields({ input, identity, omit = [] }: { input: unknown; identity: string; omit?: string[] }) {
  if (!isRecord(input)) return <ToolText text={stringifyValueAsYamlText(input)} identity={identity} />;
  const fields = Object.entries(input).filter(([name]) => !omit.includes(name));
  if (fields.length === 0) return null;
  return <dl class="tool-call-input-fields">{fields.map(([name, value]) => <div class="tool-call-input-field" key={name}>
    <dt>{name}</dt><dd>{typeof value === 'string' && !value.includes('\n') && value.length < 180
      ? <code>{value || '(empty)'}</code>
      : value === null || typeof value !== 'object' && typeof value !== 'string'
        ? <code>{String(value)}</code>
        : <ToolText text={typeof value === 'string' ? value : stringifyValueAsYamlText(value)} identity={`${identity}:${name}`} scrollLabel={`Input ${name}`} />}</dd>
  </div>)}</dl>;
}

export function ToolDiff({ diff, label, identity }: { diff: string; label: string; identity: string }) {
  return <div class="tool-call-section">
    <div class="tool-call-section-label">{label}</div>
    <ResizablePre class="tool-call-pre tool-call-pre-resizable tool-call-diff" minHeight={80} scrollLabel={label}>
      <SegmentedText text={diff} identity={identity} renderSegment={(segment) => <code>{segment.split('\n').map((line, index, lines) => <span class={line.startsWith('+') ? 'tool-call-diff-added' : line.startsWith('-') ? 'tool-call-diff-removed' : 'tool-call-diff-context'} key={index}>{line}{index < lines.length - 1 ? '\n' : ''}</span>)}</code>} />
    </ResizablePre>
  </div>;
}

export function EditInputDetails({ input, identity, resultDiff, omit = [] }: { input: unknown; identity: string; resultDiff?: string; omit?: string[] }) {
  const edits = requestedReplacements(input);
  const omittedFields = [...omit, ...(resultDiff || edits.length > 0 ? ['edits', 'oldText', 'newText'] : [])];
  return <>
    <ToolInputFields input={input} identity={identity} omit={omittedFields} />
    {resultDiff ? <ToolDiff diff={resultDiff} label="Applied changes" identity={`${identity}:applied`} /> : edits.map((edit, index) => <ToolDiff key={index}
      diff={[...edit.oldText.split('\n').map((line) => `- ${line}`), ...edit.newText.split('\n').map((line) => `+ ${line}`)].join('\n')}
      label={edits.length > 1 ? `Requested replacement ${index + 1}` : 'Requested replacement'} identity={`${identity}:edit:${index}`} />)}
  </>;
}

export function WriteInputDetails({ input, identity, omit = [] }: { input: unknown; identity: string; omit?: string[] }) {
  if (!isRecord(input) || typeof input.content !== 'string') return <ToolInputFields input={input} identity={identity} omit={omit} />;
  return <>
    <ToolInputFields input={input} identity={identity} omit={[...omit, 'content']} />
    <div class="tool-call-section"><div class="tool-call-section-label">File content</div>
      <ToolText text={input.content} identity={`${identity}:content`} language={languageForToolInput('write', input)} scrollLabel="File content" />
    </div>
  </>;
}
