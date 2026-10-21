/**
 * Delegated click handler for transcript surfaces.
 *
 * Markdown code blocks render their Copy / "Show all" toggle buttons via
 * `dangerouslySetInnerHTML`, so those buttons can't bind component-level
 * handlers. This handler inspects the click target and, if it lives inside one
 * of the known code-block controls, invokes the matching action.
 *
 * The handler is container-agnostic: it walks up from `event.target` with
 * `closest()`, so the same function drives the main `.transcript` container
 * and nested subagent transcript containers (see tool-call-item's
 * `.subagent-messages`).
 */

/** A scoped, nonvisual live region; never append feedback to copied code. */
export function announceCopyResult(control: Element, ok: boolean): void {
  const scope = control.parentElement;
  if (!scope) return;
  let status = scope.querySelector<HTMLElement>('[data-copy-status]');
  if (!status) {
    status = document.createElement('span');
    status.className = 'sr-only';
    status.dataset.copyStatus = '';
    status.setAttribute('role', 'status');
    scope.appendChild(status);
  }
  status.textContent = '';
  window.setTimeout(() => { if (status?.isConnected) status.textContent = ok ? 'Copied to clipboard' : 'Copy failed'; }, 0);
}

interface CodeBlockClickHandler {
  selector: string;
  handle: (target: HTMLElement, btn: Element) => void;
}

const CODE_BLOCK_CLICK_HANDLERS: CodeBlockClickHandler[] = [
  {
    selector: '.code-block-copy',
    handle: (_target, btn) => {
      const code = btn.closest('.code-block')?.querySelector('code');
      const text = code?.textContent ?? '';
      if (text) {
        void (async () => {
          try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
            await navigator.clipboard.writeText(text);
            btn.classList.add('copied');
            announceCopyResult(btn, true);
            window.setTimeout(() => btn.classList.remove('copied'), 1200);
          } catch {
            btn.classList.remove('copied');
            announceCopyResult(btn, false);
          }
        })();
      }
    },
  },
  {
    selector: '.code-block-toggle',
    handle: (_target, btn) => {
      const block = btn.closest('.code-block');
      if (!block) return;
      // Preserve the original "Show all N lines" label for re-collapse.
      if (!btn.getAttribute('data-collapsed-label')) {
        btn.setAttribute('data-collapsed-label', btn.textContent ?? 'Show all');
      }
      const collapsed = block.classList.toggle('code-block-collapsed');
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.textContent = collapsed
        ? btn.getAttribute('data-collapsed-label') ?? 'Show all'
        : 'Show less';
    },
  },
];

export function handleTranscriptClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  if (!target) return;

  for (const { selector, handle } of CODE_BLOCK_CLICK_HANDLERS) {
    const btn = target.closest(selector);
    if (btn) {
      handle(target, btn);
      return;
    }
  }
}
