/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import { useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LazyDetailRef, ToolCall } from '../../../lib/protocol/index.js';
import { Tooltip } from '../../lib/components/tooltip';
import { writeTextToClipboard } from '../../lib/components/clipboard';
import { AskUserContext } from '../../lib/hooks/ask-user-context';
import { SubagentCallContext } from '../subagent-call-context';
import { useLazyDetail } from '../lazy-detail-store';
import { ToolIcon, toolIconKind } from './tool-icon';
import { isRecord } from '../../../../lib/validation/type-guards';

const RAW_PREVIEW_CHARS = 60_000;

export interface ModelExchange {
  produced?: { name: string; arguments: unknown };
  received?: unknown[];
}

// Select only captured payload fields, never diagnostic or transcript metadata.
function capturedExchange(value: unknown): ModelExchange | undefined {
  if (!isRecord(value)) return undefined;
  const produced = isRecord(value.produced) && typeof value.produced.name === 'string'
    && Object.hasOwn(value.produced, 'arguments')
    ? { name: value.produced.name, arguments: value.produced.arguments } : undefined;
  const received = Array.isArray(value.received) ? value.received : undefined;
  if (!produced && !received) return undefined;
  return { ...(produced ? { produced } : {}), ...(received ? { received } : {}) };
}

export function serializeModelExchange(exchange: ModelExchange): string {
  return JSON.stringify(capturedExchange(exchange) ?? {}, null, 2);
}

function RawModelExchange({ detailRef, unavailable }: { detailRef?: LazyDetailRef; unavailable: string }) {
  // This subtree mounts only on inspection. Force a fresh capture on each
  // opening; ordinary lazy-detail loading would reuse a produced-only cache.
  const detail = useLazyDetail(detailRef, false);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    detail.retry();
    setRequested(true);
  }, []);
  const exchange = useMemo(() => requested && detail.state.status === 'loaded'
    ? capturedExchange(detail.state.value) : undefined, [requested, detail.state]);
  const json = useMemo(() => exchange ? serializeModelExchange(exchange) : undefined, [exchange]);
  const producedJson = exchange?.produced ? JSON.stringify(exchange.produced, null, 2) : undefined;
  const receivedJson = exchange?.received ? JSON.stringify(exchange.received, null, 2) : undefined;
  const truncated = (producedJson?.length ?? 0) + (receivedJson?.length ?? 0) > RAW_PREVIEW_CHARS;
  const [copyStatus, setCopyStatus] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!rootRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const host = rootRef.current?.closest<HTMLElement>('.pie-tooltip-host');
      if (!host) return;
      const rect = host.getBoundingClientRect();
      // Activatable text triggers reserve space beside the anchor. Re-measure
      // without the loading-state cap before deciding whether that side fits.
      const trigger = host.style.getPropertyValue('--pie-tooltip-available-height')
        ? document.querySelector<HTMLElement>(`[aria-describedby~="${host.id}"]`)
        : null;
      if (trigger) {
        const anchor = trigger.getBoundingClientRect();
        const currentTop = rect.top < anchor.top;
        host.style.removeProperty('--pie-tooltip-available-height');
        const natural = host.getBoundingClientRect();
        const above = Math.max(0, anchor.top - 12);
        const below = Math.max(0, window.innerHeight - anchor.bottom - 12);
        const currentSpace = currentTop ? above : below;
        const otherSpace = currentTop ? below : above;
        // Match Tooltip's initial placement rule, retaining the current side
        // when it fits (or is already the roomier bounded side).
        const useTop = natural.height > currentSpace && otherSpace > currentSpace ? !currentTop : currentTop;
        const contentHeight = rootRef.current?.getBoundingClientRect().height ?? natural.height;
        const chrome = Math.max(0, natural.height - contentHeight);
        host.style.setProperty('--pie-tooltip-available-height', `${Math.max(0, (useTop ? above : below) - chrome)}px`);
        const fitted = host.getBoundingClientRect();
        host.style.top = `${useTop ? anchor.top - fitted.height - 6 : anchor.bottom + 6}px`;
      } else {
        host.style.top = `${Math.max(6, Math.min(rect.top, window.innerHeight - rect.height - 6))}px`;
      }
    });
    observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, []);
  const loading = !requested || detail.state.status === 'idle' || detail.state.status === 'loading';
  return (
    <div ref={rootRef} class="tool-call-raw-inspector">
      <div class="tool-call-raw-heading">
        <strong>Model exchange</strong>
        {detailRef && <button key="refresh" type="button" class="tool-call-raw-refresh" aria-disabled={loading} onClick={() => {
          // Native disabled can blur a focused button and dismiss the rich
          // tooltip. Keep this keyed node focusable throughout the request.
          if (!loading) detail.retry();
        }}>{loading ? 'Refreshing…' : exchange ? 'Refresh' : 'Retry'}</button>}
        {json !== undefined && <button key="copy" type="button" class="tool-call-raw-copy" onClick={async () => {
          const copied = await writeTextToClipboard(json);
          setCopyStatus(copied ? 'Copied' : 'Couldn’t copy. Select the JSON to copy manually.');
        }}>Copy JSON</button>}
      </div>
      {!detailRef ? <div class="tool-call-raw-note" role="status">{unavailable}</div>
        : !exchange && <div class="tool-call-raw-note" role="status">
          {loading ? 'Loading captured model exchange…' : 'message' in detail.state ? detail.state.message : 'Model exchange capture unavailable.'}
        </div>}
      {truncated && <div class="tool-call-raw-note">JSON preview shortened. Copy JSON includes the whole captured exchange, including binary data.</div>}
      <section>
        <strong>Model produced</strong>
        {producedJson ? <pre tabIndex={0} aria-label="Model produced JSON"><code>{producedJson.slice(0, RAW_PREVIEW_CHARS)}</code></pre>
          : <div class="tool-call-raw-note">Captured model call unavailable.</div>}
      </section>
      <section>
        <strong>Model received</strong>
        {receivedJson ? <pre tabIndex={0} aria-label="Model received JSON"><code>{receivedJson.slice(0, Math.max(0, RAW_PREVIEW_CHARS - (producedJson?.length ?? 0)))}</code></pre>
          : <div class="tool-call-raw-note">{exchange?.produced ? 'Result not yet captured.' : 'Captured model result unavailable.'}
          </div>}
      </section>
      {copyStatus && <div role="status" class="tool-call-raw-note">{copyStatus}</div>}
    </div>
  );
}

export function RawToolInspector({ toolCall, children, triggerClassName }: { toolCall: ToolCall; children?: ComponentChildren; triggerClassName?: string }) {
  // Tooltip uses a detached Preact root: resolve ownership here, not inside it.
  const askUser = useContext(AskUserContext);
  const subagent = useContext(SubagentCallContext);
  const sessionPath = toolCall.detailRef?.sessionPath ?? askUser.sessionPath;
  const messageId = toolCall.durableEntryId ?? toolCall.id;
  const detailRef: LazyDetailRef | undefined = !subagent && sessionPath ? {
    key: JSON.stringify(['model-exchange', sessionPath, messageId, toolCall.id]),
    kind: 'model-exchange', source: 'durable', sessionPath, messageId,
    toolCallId: toolCall.id, sizeBytes: 0, summary: 'Captured model exchange', available: true,
  } : undefined;
  return (
    <Tooltip contentNode={<RawModelExchange detailRef={detailRef} unavailable={subagent
      ? 'Model exchange capture unavailable: child durable session identity is not available.'
      : 'Model exchange capture unavailable: session identity is not available.'} />} richRole="region" returnFocusOnEscape freezeWhileVisible placement="bottom" dismissOnActivation={children !== undefined} triggerClassName={triggerClassName ?? 'tool-call-icon-inspector'}>
      {children ?? <button type="button" class="tool-call-kind-icon tool-call-raw-action" aria-label={`Inspect ${toolCall.name} model exchange`} onClick={(e) => e.stopPropagation()}>
        <ToolIcon kind={toolIconKind(toolCall.name)} />
      </button>}
    </Tooltip>
  );
}
