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
        void navigator.clipboard?.writeText(text);
        btn.classList.add('copied');
        window.setTimeout(() => btn.classList.remove('copied'), 1200);
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
