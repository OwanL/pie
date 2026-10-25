/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

import type { SystemPromptEntry } from '../../lib/protocol/index.js';
import { SystemInstructionsDialog } from './system-instructions-dialog';
import { Tooltip } from '../lib/components/tooltip';
import { useNoticeContext } from '../lib/hooks/notice-context';
import { cx } from '../lib/components/cx';

interface SystemPromptToggleMenuProps {
  /** Session identity owning this prompt list. Pending intents are never
   *  allowed to cross this boundary when the toolbar is reused for a tab
   *  switch. */
  sessionPath?: string | null;
  commandsAvailable?: boolean;
  /** Full system-prompt entry list for the active session (each carries an
   *  `id` and a `disabled` flag). The backend is the source of truth — the
   *  webview renders this list and sends toggle changes back via
   *  `onSetToggles`, applying them optimistically until the backend's
   *  re-emitted `session.opened` confirms them. */
  prompts: SystemPromptEntry[];
  /** Apply the complete disabled-entry set (entry ids toggled OFF). An empty
   *  array re-enables everything. */
  /** Apply the complete disabled-entry set. A boolean/Promise result is
   *  optional for transports that can report command failure; the regular
   *  VS Code bridge remains fire-and-forget and reports backend failures via
   *  the authoritative notice channel. */
  onSetToggles: (disabledEntries: string[]) => void | boolean | Promise<void | boolean>;
}

/** A toggleable entry narrowed so its `id` is a required string. */
type ToggleableEntry = SystemPromptEntry & { id: string };

const SYSTEM_PROMPT_FAILURE_NOTICE = 'Failed to save the system-prompt setting.';
const EMPTY_PENDING: Record<string, boolean> = {};

export interface PendingOverlayState {
  sessionPath: string | null;
  /** Render-generation fence prevents A's state from reappearing on A→B→A
   *  before the passive session-change effect has run. */
  sessionGeneration: number;
  intents: Record<string, boolean>;
}

/** Return only the intents owned by the currently-rendered session/generation.
 * Keeping this as a pure helper makes the pre-effect isolation contract easy
 * to test: an old A state is empty for B, and remains empty if the renderer
 * returns to A under a newer generation. */
export function scopePendingOverlay(
  state: PendingOverlayState,
  sessionPath: string | null,
  sessionGeneration: number,
): Record<string, boolean> {
  return state.sessionPath === sessionPath && state.sessionGeneration === sessionGeneration
    ? state.intents
    : EMPTY_PENDING;
}

function noticeTargetsSession(noticeSessionPath: string | null | undefined, sessionPath: string | null): boolean {
  return noticeSessionPath === undefined || noticeSessionPath === null || noticeSessionPath === sessionPath;
}

/** Session-owned optimistic persistence for the system instructions editor. */
export function SystemPromptToggleMenu({ prompts, sessionPath = null, commandsAvailable = true, onSetToggles }: SystemPromptToggleMenuProps) {
  const [open, setOpen] = useState(false);
  /** Local per-entry intent overlay, keyed by entry id: `true` = disabled,
   *  `false` = enabled. Cleared as the backend confirms each intent. */
  const [pendingState, setPendingState] = useState<PendingOverlayState>(() => ({
    sessionPath,
    sessionGeneration: 0,
    intents: {},
  }));
  const currentSessionPathRef = useRef<string | null>(sessionPath);
  const sessionGenerationRef = useRef(0);
  const pendingOperationRef = useRef(0);
  // A draft can reverse an earlier unconfirmed Apply. The pre-submit catalog
  // must not acknowledge that reversal simply because it already matches it.
  const submittedCatalogRef = useRef(prompts);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const { notice, sessionPath: noticeSessionPath } = useNoticeContext();

  // Scope the overlay synchronously as soon as the identity changes. The
  // effect below clears the state after commit, but using the scoped view here
  // prevents even a single render of session A's checkbox/badge in session B.
  if (currentSessionPathRef.current !== sessionPath) {
    currentSessionPathRef.current = sessionPath;
    sessionGenerationRef.current += 1;
    pendingOperationRef.current += 1;
  }
  const sessionGeneration = sessionGenerationRef.current;
  const sessionPending = scopePendingOverlay(pendingState, sessionPath, sessionGeneration);

  useEffect(() => {
    setPendingState((previous) => (
      previous.sessionPath === sessionPath
        && previous.sessionGeneration === sessionGeneration
        && Object.keys(previous.intents).length === 0
        ? previous
        : { sessionPath, sessionGeneration, intents: {} }
    ));
    setOpen(false);
  }, [sessionGeneration, sessionPath]);

  // The EffectRunner reports persistence failures through the host-owned
  // NoticeShown projection. Treat that authoritative failure as a rollback,
  // so the local optimistic overlay cannot remain indefinitely misleading.
  // This is deliberately notice-driven rather than timer-driven: an ordinary
  // stale state snapshot must not erase a rapid, valid click sequence.
  useEffect(() => {
    if (!notice?.startsWith(SYSTEM_PROMPT_FAILURE_NOTICE)
      || !noticeTargetsSession(noticeSessionPath, sessionPath)) return;
    setPendingState((previous) => {
      if (previous.sessionPath !== sessionPath || previous.sessionGeneration !== sessionGeneration) return previous;
      return Object.keys(previous.intents).length === 0
        ? previous
        : { ...previous, intents: {} };
    });
  }, [notice, noticeSessionPath, sessionGeneration, sessionPath]);

  // Only entries with a stable `id` that are `toggleable` appear as checkboxes.
  // Display-only entries (`toggleable === false`, e.g. the provider card) are
  // excluded: pi cannot strip them from the sent prompt, so a toggle would be
  // misleading. Legacy/mock entries without an `id` remain inspectable information.
  const entries = useMemo(
    () => prompts.filter(
      (p): p is ToggleableEntry => !!p.id && p.toggleable !== false,
    ),
    [prompts],
  );

  // The backend-controlled disabled set (the truth that survives a reopen).
  const remoteDisabledIds = useMemo(
    () => new Set(entries.filter((e) => e.disabled).map((e) => e.id)),
    [entries],
  );

  // Effective disabled set = remote truth overlaid with local pending intents.
  // Pending overrides keep applied changes visible until backend confirmation.
  // Checkbox edits remain local to the dialog until Apply.
  const disabledIds = useMemo(() => {
    const set = new Set<string>(remoteDisabledIds);
    for (const [id, intent] of Object.entries(sessionPending)) {
      if (intent) set.add(id);
      else set.delete(id);
    }
    return set;
  }, [remoteDisabledIds, sessionPending]);

  // Reconcile pending intents against incoming remote state: ack entries the
  // backend has confirmed (remote state matches intent) and prune entries that
  // no longer exist (e.g. a context file removed from the project). Keeping
  // `pending` tight prevents it from masking later backend-driven changes or
  // growing without bound. The effect fires only when remote state changes
  // (the sole condition under which an ack can occur), so a local Apply
  // does not trigger an extra reconcile pass; the functional `setPending` reads
  // fresh state and the `prev`-guard avoids re-render loops when nothing
  // reconciles.
  useEffect(() => {
    if (notice?.startsWith(SYSTEM_PROMPT_FAILURE_NOTICE)
      && noticeTargetsSession(noticeSessionPath, sessionPath)) return;
    if (Object.keys(sessionPending).length === 0 || prompts === submittedCatalogRef.current) return;
    setPendingState((prev) => {
      if (prev.sessionPath !== sessionPath || prev.sessionGeneration !== sessionGeneration) return prev;
      const present = new Set(entries.map((e) => e.id));
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const [id, intent] of Object.entries(prev.intents)) {
        // Drop entries whose id has vanished, or whose intent the backend now
        // confirms — both free the overlay to track fresh remote state.
        if (!present.has(id) || remoteDisabledIds.has(id) === intent) {
          changed = true;
          continue;
        }
        next[id] = intent;
      }
      return changed ? { ...prev, intents: next } : prev;
    });
  }, [entries, prompts, notice, noticeSessionPath, remoteDisabledIds, sessionGeneration, sessionPath, sessionPending]);

  const disabledCount = disabledIds.size;
  const promptsAvailable = prompts.length > 0;

  // Keep the indicator stable in the toolbar even while a session's prompt
  // metadata is unresolved. It becomes available as soon as toggleable entries
  // arrive rather than shifting the surrounding controls in and out.
  useEffect(() => {
    if (!promptsAvailable && open) setOpen(false);
  }, [open, promptsAvailable]);

  const apply = (next: Set<string>) => {
    if (!commandsAvailable) return;
    const previous = sessionPending;
    const previousCatalog = submittedCatalogRef.current;
    submittedCatalogRef.current = prompts;
    const operation = ++pendingOperationRef.current;
    const intents: Record<string, boolean> = {};
    for (const entry of entries) intents[entry.id] = next.has(entry.id);
    setPendingState({ sessionPath, sessionGeneration, intents });
    setOpen(false);
    const rollback = () => {
      if (pendingOperationRef.current !== operation
        || currentSessionPathRef.current !== sessionPath
        || sessionGenerationRef.current !== sessionGeneration) return;
      submittedCatalogRef.current = previousCatalog;
      setPendingState((prev) => (
        prev.sessionPath === sessionPath && prev.sessionGeneration === sessionGeneration
          ? { ...prev, intents: previous }
          : prev
      ));
    };
    try {
      const result = onSetToggles([...next]);
      if (result === false) {
        rollback();
      } else if (result && typeof result !== 'boolean' && typeof result.then === 'function') {
        void result.then((accepted) => {
          if (accepted === false) rollback();
        }, rollback);
      }
    } catch {
      rollback();
    }
  };
  const onTriggerKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(true);
    }
  };

  return (
    <div class="system-prompt-toggle-menu">
      <Tooltip content={open ? null : promptsAvailable ? 'System instructions' : 'System instructions unavailable'} placement="top">
        <button
          ref={triggerRef}
          type="button"
          class={cx('system-prompt-toggle-trigger', open && promptsAvailable && 'open', disabledCount > 0 && 'has-disabled')}
          aria-haspopup="dialog"
          aria-expanded={open && promptsAvailable}
          aria-label="System instructions"
          disabled={!promptsAvailable}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={onTriggerKeyDown}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="3" width="12" height="3.5" rx="1" />
            <rect x="2" y="9.5" width="12" height="3.5" rx="1" />
            <circle cx="5.5" cy="4.75" r="1.1" fill="currentColor" stroke="none" />
            <circle cx="10" cy="11.25" r="1.1" fill="currentColor" stroke="none" />
          </svg>
          {disabledCount > 0 && (
            <span class="system-prompt-toggle-badge" aria-label={`${disabledCount} disabled`}>{disabledCount}</span>
          )}
        </button>
      </Tooltip>

      {open && promptsAvailable && pendingState.sessionGeneration === sessionGeneration && (
        <SystemInstructionsDialog key={sessionGeneration} prompts={prompts} disabledIds={disabledIds}
          canApply={commandsAvailable} onApply={apply} onCancel={() => setOpen(false)} triggerRef={triggerRef} />
      )}
    </div>
  );
}
