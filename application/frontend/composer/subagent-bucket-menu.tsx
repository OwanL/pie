/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ChatPrefs } from '../../lib/protocol/index.js';
import { SUBAGENT_BUCKET_TIERS } from '../../../lib/subagent-bucket-policy.js';
import { useAnchoredOverlay } from '../lib/components/anchored-overlay';
import { Tooltip } from '../lib/components/tooltip';
import { cx } from '../lib/components/cx';
import { getSubagentBucketChoices, setSubagentBucketEnabled } from '../shell/chat-prefs';
import { useIntendedSelection } from '../settings/optimistic-selection';

interface Props {
  sessionPath: string | null;
  prefs: ChatPrefs;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
}

/** Key local intent and popup lifetime to the addressed session. */
export function SubagentBucketMenu(props: Props) {
  return props.sessionPath ? <SessionBucketMenu key={props.sessionPath} {...props} sessionPath={props.sessionPath} /> : null;
}

function SessionBucketMenu({ sessionPath, prefs, onSetPrefs }: Props & { sessionPath: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const choices = getSubagentBucketChoices(prefs, sessionPath);
  // Unrelated preference/session echoes must not consume this session's queue.
  const selected = useMemo(() => SUBAGENT_BUCKET_TIERS.filter(tier => choices[tier]),
    [choices.small, choices.medium, choices.frontier]);
  const { value, update } = useIntendedSelection(selected, next => {
    onSetPrefs({ subagentBucketTogglesBySession: { [sessionPath]: {
      small: next.includes('small'), medium: next.includes('medium'), frontier: next.includes('frontier'),
    } } });
  });
  // Event bursts read the latest intent even before Preact commits a render.
  const intended = useRef(value);
  intended.current = value;

  useAnchoredOverlay({ open, triggerRef, overlayRef: menuRef, preferredDirection: 'up',
    preferredWidth: 260, minHeight: 110, maxHeight: 320 });
  useEffect(() => {
    if (!open) return;
    const pointer = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener('mousedown', pointer);
    document.addEventListener('keydown', keyboard);
    return () => { document.removeEventListener('mousedown', pointer); document.removeEventListener('keydown', keyboard); };
  }, [open]);

  const keydown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); setOpen(true);
    }
  };
  const summary = `${value.length}/3 subagent buckets enabled`;
  return (
    <div class="system-prompt-toggle-menu subagent-bucket-menu">
      <Tooltip content={open ? null : summary} placement="top">
        <button ref={triggerRef} type="button" title="Buckets"
          class={cx('system-prompt-toggle-trigger', 'subagent-bucket-trigger', open && 'open', value.length < 3 && 'has-disabled')}
          aria-haspopup="dialog" aria-expanded={open} aria-label={`Subagent buckets: ${summary}`}
          onClick={() => setOpen(previous => !previous)} onKeyDown={keydown}>Buckets</button>
      </Tooltip>
      {open && <div ref={menuRef} class="system-prompt-toggle-dropdown subagent-bucket-dropdown" role="dialog" aria-label="Subagent bucket toggles">
        <div class="system-prompt-toggle-header"><span class="system-prompt-toggle-title">Subagent buckets</span></div>
        <div class="system-prompt-toggle-body">
          {SUBAGENT_BUCKET_TIERS.map(tier => {
            const enabled = value.includes(tier);
            return <button key={tier} type="button" class={cx('toolbar-settings-item', enabled && 'checked')}
              role="checkbox" aria-checked={enabled} disabled={enabled && value.length === 1}
              onClick={() => {
                const current = intended.current;
                const patch = setSubagentBucketEnabled(sessionPath, {
                  small: current.includes('small'), medium: current.includes('medium'), frontier: current.includes('frontier'),
                }, tier, !current.includes(tier));
                const next = patch.subagentBucketTogglesBySession?.[sessionPath];
                if (!next) return;
                intended.current = SUBAGENT_BUCKET_TIERS.filter(bucket => next[bucket]);
                update(intended.current);
              }}>
              <span class="toolbar-settings-item-check" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={enabled ? '' : 'opacity:0'}>
                  <polyline points="2.5,6.5 5,9 10.5,3.5" />
                </svg>
              </span>
              <span class="toolbar-settings-item-label">{tier[0].toUpperCase() + tier.slice(1)}</span>
            </button>;
          })}
        </div>
      </div>}
    </div>
  );
}
