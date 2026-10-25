/** @jsxRuntime automatic */
/** @jsxImportSource preact */
import { createPortal } from 'preact/compat';
import type { RefObject } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { SystemPromptEntry } from '../../lib/protocol/index.js';
import { renderMarkdown } from '../transcript/markdown';
import { handleTranscriptClick } from '../transcript/transcript-click-handler';
import { writeTextToClipboard } from '../lib/components/clipboard';
import { estimateTextTokens, formatSystemPromptTokenLabel } from '../context-inspector/system-prompt-tokens';

const identity = (entry: SystemPromptEntry) => entry.id ?? `${entry.source}:${entry.title}`;
const isTool = (entry: SystemPromptEntry) => entry.id === 'tools';
const isToggleable = (entry: SystemPromptEntry): entry is SystemPromptEntry & { id: string } =>
  entry.source !== 'provider' && !!entry.id && entry.toggleable !== false;
const preferredEntry = (prompts: SystemPromptEntry[]) =>
  prompts.find(entry => isToggleable(entry) && entry.availability === 'available') ?? prompts[0];
const tabs = ['sources', 'resolved'] as const;
const note = 'Reconstructed preview, not a record of a sent request. Hidden provider instructions are not included.';

function DocumentIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 3H5v18h14V8zM14 3v6h5M8 13h8M8 17h6" />
  </svg>;
}

function isFocusable(node: HTMLElement): boolean {
  if (node.tabIndex < 0 || node.matches(':disabled') || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let ancestor: HTMLElement | null = node; ancestor; ancestor = ancestor.parentElement) {
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function Markdown({ text }: { text: string }) {
  return <div class="message-body" onClick={handleTranscriptClick}
    dangerouslySetInnerHTML={{ __html: renderMarkdown(text, true, false) }} />;
}

interface Props {
  prompts: SystemPromptEntry[];
  disabledIds: Set<string>;
  canApply: boolean;
  onApply: (ids: Set<string>) => void;
  onCancel: () => void;
  triggerRef: RefObject<HTMLButtonElement>;
}

export function SystemInstructionsDialog({ prompts, disabledIds, canApply, onApply, onCancel, triggerRef }: Props) {
  // Store only edits: unrelated backend updates remain visible in the draft.
  const [edits, setEdits] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState(() => identity(preferredEntry(prompts)));
  const [tab, setTab] = useState<typeof tabs[number]>('sources');
  const tabId = useId();
  const [search, setSearch] = useState('');
  const [copyStatus, setCopyStatus] = useState('Copy');
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    close.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelRef.current();
      }
      if (event.key !== 'Tab') return;
      const nodes = [...(dialog.current?.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, a[href], [tabindex]',
      ) ?? [])].filter(isFocusable);
      const index = nodes.indexOf(document.activeElement as HTMLElement);
      if (index < 0 || (event.shiftKey ? index === 0 : index === nodes.length - 1)) {
        event.preventDefault();
        (event.shiftKey ? nodes.at(-1) : nodes[0])?.focus();
      }
    };
    const focusin = (event: FocusEvent) => {
      if (event.target instanceof Node && !dialog.current?.contains(event.target)) close.current?.focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      triggerRef.current?.focus();
    };
  }, []);

  const disabled = (entry: SystemPromptEntry) => isToggleable(entry)
    ? edits[entry.id] ?? disabledIds.has(entry.id) : !!entry.disabled;
  const next = new Set(prompts.filter(isToggleable).filter(disabled).map(entry => entry.id));
  const pendingCount = prompts.filter(isToggleable)
    .filter(entry => disabled(entry) !== disabledIds.has(entry.id)).length;
  const available = prompts.filter(entry =>
    entry.source !== 'provider' && entry.availability === 'available' && !disabled(entry));
  const tokenLabel = formatSystemPromptTokenLabel(available.reduce((sum, entry) => sum + estimateTextTokens(entry.text), 0));
  const groups: { title: string; entries: SystemPromptEntry[] }[] = [
    { title: 'Instruction text', entries: available.filter(entry => !isTool(entry)) },
    { title: 'Tool definitions · separate from system message', entries: available.filter(isTool) },
  ];
  const assembled = [note, ...groups.flatMap(group => [
    group.title, ...group.entries.map(entry => `## ${entry.title}\n\n${entry.text}`),
  ])].join('\n\n');
  const chosen = prompts.find(entry => identity(entry) === selected) ?? preferredEntry(prompts);
  const matchesSearch = (entry: SystemPromptEntry) =>
    `${entry.title} ${entry.text}`.toLowerCase().includes(search.toLowerCase());

  useEffect(() => {
    const present = new Set(prompts.filter(isToggleable).map(entry => entry.id));
    setEdits(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => present.has(id))));
    if (chosen && identity(chosen) !== selected) setSelected(identity(chosen));
  }, [prompts]);

  const copyVersion = useRef(assembled);
  copyVersion.current = assembled;
  useEffect(() => setCopyStatus('Copy'), [assembled]);
  const copyPreview = async () => {
    const content = assembled;
    const ok = await writeTextToClipboard(content);
    if (copyVersion.current === content) setCopyStatus(ok ? 'Copied' : 'Copy unavailable');
  };

  return createPortal(
    <div class="system-instructions-backdrop" onMouseDown={event => {
      if (event.target === event.currentTarget) onCancel();
    }}>
      <div ref={dialog} class="system-instructions-dialog" role="dialog" aria-modal="true" aria-label="System instructions">
        <header class="system-instructions-header">
          <h2 class="system-instructions-title">System instructions</h2>
          <button ref={close} class="system-instructions-close" type="button"
            aria-label="Close system instructions" onClick={onCancel}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
          </button>
        </header>
        <div class="system-instructions-tabs" role="tablist" aria-label="Instruction views">
          {tabs.map((value, index) => (
            <button key={value} id={`${tabId}-${value}`} type="button" role="tab"
              aria-selected={tab === value} aria-controls={`${tabId}-${value}-panel`}
              tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}
              onKeyDown={event => {
                const direction = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                if (!direction && event.key !== 'Home' && event.key !== 'End') return;
                event.preventDefault();
                const nextTab = tabs[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
                  : (index + direction + tabs.length) % tabs.length];
                setTab(nextTab);
                document.getElementById(`${tabId}-${nextTab}`)?.focus();
              }}>
              {value === 'sources' ? 'Sources' : 'Resolved preview'}
            </button>
          ))}
        </div>
        {tab === 'sources' ? (
          <div id={`${tabId}-sources-panel`} class="system-instructions-sources" role="tabpanel"
            aria-labelledby={`${tabId}-sources`}>
            <div class="system-instructions-list" tabIndex={0} aria-label="Instruction sources">
              {[...prompts.filter(entry => entry.source !== 'provider'), ...prompts.filter(entry => entry.source === 'provider')].map(entry => (
                <div key={identity(entry)} class={`system-instructions-source ${entry.source === 'provider' ? 'system-instructions-provider' : ''} ${chosen && identity(chosen) === identity(entry) ? 'selected' : ''}`}>
                  {isToggleable(entry) ? (
                    <input type="checkbox" aria-label={`Include ${entry.title}`} checked={!disabled(entry)}
                      onChange={event => {
                        const excluded = !event.currentTarget.checked;
                        setEdits(previous => ({ ...previous, [entry.id]: excluded }));
                      }} />
                  ) : <span class="system-instructions-info-icon" title="Information only"><DocumentIcon /></span>}
                  <div class="system-instructions-source-label">
                    <button type="button" title={[entry.tooltip, entry.summary].filter(Boolean).join('\n')}
                      aria-pressed={!!chosen && identity(chosen) === identity(entry)}
                      onClick={() => setSelected(identity(entry))}>
                      {isTool(entry) ? 'Tool definitions' : entry.title}
                    </button>
                  </div>
                  {entry.source === 'provider' || entry.availability === 'available' ? null
                    : <span class="system-instructions-availability">Unavailable</span>}
                </div>
              ))}
            </div>
            <article class="system-instructions-preview system-instructions-source-preview">
              <div class="system-instructions-document-heading">
                <DocumentIcon />
                <h3>{chosen?.tooltip || chosen?.title}</h3>
              </div>
              <div class="system-instructions-document">
                {chosen && <>
                  {chosen.source === 'provider'
                    ? <p class="system-instructions-document-note">Hidden provider instructions are unavailable; this is provider information only.</p>
                    : chosen.availability !== 'available'
                      ? <p class="system-instructions-document-note">Source text unavailable</p>
                      : disabled(chosen) && <p class="system-instructions-document-note">Excluded from next message</p>}
                  {isTool(chosen) && <p class="system-instructions-document-note">Tool definitions are separate from system-message text.</p>}
                  <Markdown text={chosen.text} />
                </>}
              </div>
            </article>
          </div>
        ) : (
          <div id={`${tabId}-resolved-panel`} class="system-instructions-resolved" role="tabpanel"
            aria-labelledby={`${tabId}-resolved`}>
            <div class="system-instructions-search">
              <label class="system-instructions-search-field">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></svg>
                <input aria-label="Search assembled preview" placeholder="Search combined instructions" value={search}
                  onInput={event => setSearch(event.currentTarget.value)} />
              </label>
              <span class="system-instructions-token-estimate" title="Estimated tokens in enabled instruction text and tool definitions">≈ {tokenLabel}</span>
              <button type="button" onClick={copyPreview}>{copyStatus}</button>
            </div>
            <p class="system-instructions-note">{note}</p>
            <div class="system-instructions-preview">
              {groups.map(group => (
                <section key={group.title}>
                  <h3 class="system-instructions-boundary">{group.title}</h3>
                  {group.entries.filter(matchesSearch).map(entry => (
                    <section key={identity(entry)}><h4>{entry.title}</h4><Markdown text={entry.text} /></section>
                  ))}
                </section>
              ))}
              {search && !available.some(matchesSearch) && <p>No matching sources.</p>}
            </div>
          </div>
        )}
        <footer>
          <div class="system-instructions-scope">
            {canApply ? 'This session · from your next message' : 'Reconnect to apply changes.'}
          </div>
          <div class="system-instructions-actions">
            <button type="button" onClick={onCancel}>Cancel</button>
            <button type="button" class="primary" disabled={!pendingCount || !canApply} onClick={() => onApply(next)}>Apply changes</button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
