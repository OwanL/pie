/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { CUSTOM_SENTINEL } from '../../shared/ask-user-sentinel';
import type { ExtensionUIRequestPayload, ExtensionUIResponsePayload, WebviewToHostMessage } from '../../shared/protocol';
import { renderMarkdown } from './markdown';
import { QuestionIcon } from './components/question-icon';

interface ExtensionUIPromptProps {
  sessionPath: string;
  request: ExtensionUIRequestPayload;
  postMessage: (msg: WebviewToHostMessage) => void;
  /** Visual treatment: "strip" (bottom bar, slim & flush) or "card" (inline in
   *  transcript, matches the ask_user loading/completed cards). Defaults to
   *  "strip" for the bottom-bar mount site. */
  variant?: 'strip' | 'card';
  /** Optional rationale/context paragraph rendered muted under the question.
   *  Only the inline ask_user renderer supplies this (from the tool-call
   *  input); the bottom-bar prompt has none. */
  context?: string;
  /** Optional source label for the eyebrow (e.g. "worker · depth 2") so the
   *  user can tell which subagent is asking. Inline cards provide the agent
   *  name; the fixed reliability fallback uses a generic Subagent label. */
  sourceLabel?: string;
}

export function ExtensionUIPrompt({ sessionPath, request, postMessage, variant = 'strip', context, sourceLabel }: ExtensionUIPromptProps) {
  const respond = useCallback((response: ExtensionUIResponsePayload) => {
    postMessage({ type: 'extensionUiResponse', sessionPath, response });
  }, [postMessage, sessionPath]);

  const rootClass = variant === 'card' ? 'ext-prompt ext-prompt--card' : 'ext-prompt';

  switch (request.method) {
    case 'confirm':
      return (
        <ConfirmPrompt
          id={request.id}
          title={request.title}
          message={request.message}
          timeout={request.timeout}
          extensionId={request.extensionId}
          rootClass={rootClass}
          context={context}
          sourceLabel={sourceLabel}
          onRespond={respond}
        />
      );
    case 'select':
      return (
        <SelectPrompt
          id={request.id}
          title={request.title}
          options={request.options}
          timeout={request.timeout}
          extensionId={request.extensionId}
          rootClass={rootClass}
          context={context}
          sourceLabel={sourceLabel}
          onRespond={respond}
        />
      );
    case 'input':
      return (
        <InputPrompt
          id={request.id}
          title={request.title}
          placeholder={request.placeholder}
          timeout={request.timeout}
          extensionId={request.extensionId}
          rootClass={rootClass}
          context={context}
          sourceLabel={sourceLabel}
          onRespond={respond}
        />
      );
    default:
      return null;
  }
}

// ── Prompt content (shared by confirm/select/input) ─────────────────────── */
// Stacks an optional meta line (source eyebrow + timeout countdown) above the
// question, rendered as markdown so agent-authored emphasis (bold, code, lists)
// is styled. The `context` rationale renders as a second muted markdown block.
// Memoised per-text so the ~7/sec host snapshots don't re-parse markdown.
interface PromptContentProps {
  eyebrow?: string;
  text: string;
  context?: string;
  remaining: number | null;
}

function PromptContent({ eyebrow, text, context, remaining }: PromptContentProps) {
  const questionHtml = useMemo(() => renderMarkdown(text), [text]);
  const contextHtml = useMemo(() => (context ? renderMarkdown(context) : ''), [context]);
  const hasMeta = !!eyebrow || remaining !== null;
  return (
    <div class="ext-prompt-content">
      {hasMeta && (
        <div class="ext-prompt-meta">
          {eyebrow && <span class="ext-prompt-eyebrow">{eyebrow}</span>}
          {remaining !== null && <span class="ext-prompt-countdown">{remaining}s</span>}
        </div>
      )}
      <div class="ext-prompt-text ask-prose" dangerouslySetInnerHTML={{ __html: questionHtml }} />
      {context && <div class="ext-prompt-context ask-prose" dangerouslySetInnerHTML={{ __html: contextHtml }} />}
    </div>
  );
}

// ─── Confirm ─────────────────────────────────────────────────────────────────

interface ConfirmPromptProps {
  id: string;
  title: string;
  message: string;
  timeout?: number;
  extensionId?: string;
  rootClass: string;
  context?: string;
  sourceLabel?: string;
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function ConfirmPrompt({ id, title, message, timeout, extensionId, rootClass, context, sourceLabel, onRespond }: ConfirmPromptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(timeout);

  useEffect(() => { containerRef.current?.focus(); }, []);

  useEffect(() => {
    if (remaining === 0) {
      onRespond({ id, cancelled: true });
    }
  }, [remaining, id, onRespond]);

  // Scope the keydown handler to the prompt container (focused on mount) instead
  // of `document`, so pressing Enter to send a message in the composer (or to
  // confirm an inline edit) no longer also confirms/denies this prompt.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        // Let focused buttons handle Enter via their native click (so Enter on
        // Deny denies instead of confirming). Only confirm when focus is on the
        // prompt body itself.
        const target = e.target as HTMLElement | null;
        if (target?.closest('button')) return;
        e.preventDefault();
        onRespond({ id, confirmed: true });
      }
      if (e.key === 'Escape') { e.preventDefault(); onRespond({ id, confirmed: false }); }
    };
    node.addEventListener('keydown', handler);
    return () => node.removeEventListener('keydown', handler);
  }, [id, onRespond]);

  const eyebrow = sourceLabel ?? extensionId;

  return (
    <div ref={containerRef} class={rootClass} tabIndex={-1} role="alertdialog" aria-label={title}>
      <div class="ext-prompt-row">
        <span class="ext-prompt-icon" aria-hidden="true"><QuestionIcon /></span>
        <PromptContent eyebrow={eyebrow} text={message || title} context={context} remaining={remaining} />
        <div class="ext-prompt-actions">
          <button class="ext-prompt-btn secondary" type="button" onClick={() => onRespond({ id, confirmed: false })}>
            Deny
          </button>
          <button class="ext-prompt-btn primary" type="button" onClick={() => onRespond({ id, confirmed: true })}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Select ──────────────────────────────────────────────────────────────────

interface SelectPromptProps {
  id: string;
  title: string;
  options: string[];
  timeout?: number;
  extensionId?: string;
  rootClass: string;
  context?: string;
  sourceLabel?: string;
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function SelectPrompt({ id, title, options, timeout, extensionId, rootClass, context, sourceLabel, onRespond }: SelectPromptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const remaining = useCountdown(timeout);
  const [customValue, setCustomValue] = useState('');
  const [showCustomInput, setShowCustomInput] = useState(false);
  const customInputRef = useRef<HTMLInputElement>(null);

  // Roving-tabindex keyboard nav for the option pills: one option in the tab
  // order at a time (focusIndex); arrow keys cycle, Enter/Space activate the
  // focused pill via its native click. Keeps the prompt fully keyboard-operable.
  const [focusIndex, setFocusIndex] = useState(0);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    // Focus the first option (not the container) so arrow nav starts
    // immediately; Escape still bubbles to the container-scoped listener.
    optionRefs.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (remaining === 0) {
      onRespond({ id, cancelled: true });
    }
  }, [remaining, id, onRespond]);

  useEffect(() => {
    if (showCustomInput) {
      customInputRef.current?.focus();
    }
  }, [showCustomInput]);

  // Scope the Escape handler to the prompt container so pressing Escape to
  // cancel an inline edit or blur the composer no longer also cancels this
  // ask_user prompt from anywhere on the page.
  useEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onRespond({ id, cancelled: true }); }
    };
    node.addEventListener('keydown', handler);
    return () => node.removeEventListener('keydown', handler);
  }, [id, onRespond]);

  const handleOptionsKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = (focusIndex + 1) % options.length;
      setFocusIndex(next);
      optionRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = (focusIndex - 1 + options.length) % options.length;
      setFocusIndex(prev);
      optionRefs.current[prev]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      setFocusIndex(0);
      optionRefs.current[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      const last = options.length - 1;
      setFocusIndex(last);
      optionRefs.current[last]?.focus();
    }
    // Enter/Space activate the focused button via its native click handler.
  }, [focusIndex, options.length]);

  const handleCustomSubmit = useCallback(() => {
    if (customValue.trim()) {
      onRespond({ id, value: customValue.trim() });
    }
  }, [id, customValue, onRespond]);

  const handleCustomKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && customValue.trim()) {
      e.preventDefault();
      onRespond({ id, value: customValue.trim() });
    }
    // Escape is handled by the container-scoped listener; handling it here too
    // would double-respond because the event bubbles up to the container.
  }, [id, customValue, onRespond]);

  const eyebrow = sourceLabel ?? extensionId;

  return (
    <div ref={containerRef} class={rootClass} tabIndex={-1} role="dialog" aria-label={title}>
      <div class="ext-prompt-row">
        <span class="ext-prompt-icon" aria-hidden="true"><QuestionIcon /></span>
        <PromptContent eyebrow={eyebrow} text={title} context={context} remaining={remaining} />
        {!showCustomInput && (
          <button class="ext-prompt-cancel" type="button" onClick={() => onRespond({ id, cancelled: true })}>
            Cancel
          </button>
        )}
      </div>
      <div class="ext-prompt-row">
        <div class="ext-prompt-options" onKeyDown={handleOptionsKeyDown} role="listbox" aria-label={title}>
          {options.map((option, i) =>
            option === CUSTOM_SENTINEL ? (
              <button
                key={option}
                ref={(el) => { optionRefs.current[i] = el; }}
                class="ext-prompt-option custom"
                type="button"
                role="option"
                tabIndex={i === focusIndex ? 0 : -1}
                onClick={() => setShowCustomInput(true)}
              >
                Custom…
              </button>
            ) : (
              <button
                key={option}
                ref={(el) => { optionRefs.current[i] = el; }}
                class="ext-prompt-option"
                type="button"
                role="option"
                tabIndex={i === focusIndex ? 0 : -1}
                onClick={() => onRespond({ id, value: option })}
              >
                {option}
              </button>
            ),
          )}
        </div>
      </div>
      {showCustomInput && (
        <div class="ext-prompt-row ext-prompt-custom-row">
          <input
            ref={customInputRef}
            class="ext-prompt-input"
            type="text"
            value={customValue}
            placeholder="Type your answer…"
            onInput={(e) => setCustomValue((e.target as HTMLInputElement).value)}
            onKeyDown={handleCustomKeyDown}
          />
          <div class="ext-prompt-actions">
            <button class="ext-prompt-btn secondary" type="button" onClick={() => onRespond({ id, cancelled: true })}>
              Cancel
            </button>
            <button
              class="ext-prompt-btn primary"
              type="button"
              disabled={!customValue.trim()}
              onClick={handleCustomSubmit}
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Input ───────────────────────────────────────────────────────────────────

interface InputPromptProps {
  id: string;
  title: string;
  placeholder?: string;
  timeout?: number;
  extensionId?: string;
  rootClass: string;
  context?: string;
  sourceLabel?: string;
  onRespond: (r: ExtensionUIResponsePayload) => void;
}

function InputPrompt({ id, title, placeholder, timeout, extensionId, rootClass, context, sourceLabel, onRespond }: InputPromptProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const remaining = useCountdown(timeout);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (remaining === 0) {
      onRespond({ id, cancelled: true });
    }
  }, [remaining, id, onRespond]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && value.trim()) {
      e.preventDefault();
      onRespond({ id, value });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onRespond({ id, cancelled: true });
    }
  }, [id, value, onRespond]);

  const eyebrow = sourceLabel ?? extensionId;

  return (
    <div class={rootClass} role="dialog" aria-label={title}>
      <div class="ext-prompt-row">
        <span class="ext-prompt-icon" aria-hidden="true"><QuestionIcon /></span>
        <PromptContent eyebrow={eyebrow} text={title} context={context} remaining={remaining} />
        <button class="ext-prompt-cancel" type="button" onClick={() => onRespond({ id, cancelled: true })}>
          Cancel
        </button>
      </div>
      <div class="ext-prompt-row">
        <input
          ref={inputRef}
          class="ext-prompt-input"
          type="text"
          value={value}
          placeholder={placeholder}
          onInput={(e) => setValue((e.target as HTMLInputElement).value)}
          onKeyDown={handleKeyDown}
        />
        <button
          class="ext-prompt-btn primary"
          type="button"
          disabled={!value.trim()}
          onClick={() => onRespond({ id, value })}
        >
          Submit
        </button>
      </div>
    </div>
  );
}



// ─── Countdown hook ──────────────────────────────────────────────────────────

function useCountdown(timeoutMs?: number): number | null {
  const [remaining, setRemaining] = useState<number | null>(
    timeoutMs ? Math.ceil(timeoutMs / 1000) : null,
  );

  useEffect(() => {
    if (!timeoutMs) return;
    const end = Date.now() + timeoutMs;
    const tick = () => {
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setRemaining(left);
    };
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [timeoutMs]);

  return remaining;
}