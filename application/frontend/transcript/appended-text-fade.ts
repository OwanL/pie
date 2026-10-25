/** Annotate only a rendered suffix; markdown reinterpretations deliberately skip motion. */
export function annotateAppendedText(previousHtml: string, nextHtml: string, document: Document): string {
  const previous = document.createElement('div');
  const next = document.createElement('div');
  previous.innerHTML = previousHtml;
  next.innerHTML = nextHtml;
  // Prior animation wrappers are presentation only, never part of markdown structure.
  for (const span of previous.querySelectorAll('span[data-stream-text-fade]')) span.replaceWith(...span.childNodes);
  previous.normalize();
  // Markdown serializes block-ending newlines which move when a paragraph
  // grows. They are not previously visible characters to protect from fading.
  const oldText = (previous.textContent ?? '').trimEnd();
  const newText = next.textContent ?? '';
  if (!oldText || newText.length <= oldText.length || !newText.startsWith(oldText)) return nextHtml;

  function prefixSafe(old: Node, fresh: Node): boolean {
    if (old.nodeType !== fresh.nodeType) return false;
    if (old.nodeType === 3) return (fresh.nodeValue ?? '').startsWith(old.nodeValue ?? '');
    if (old.nodeType !== 1) return old.isEqualNode(fresh);
    const a = old as Element;
    const b = fresh as Element;
    if (a.tagName !== b.tagName || a.attributes.length !== b.attributes.length
      || [...a.attributes].some(attr => b.getAttribute(attr.name) !== attr.value)) return false;
    const children = [...a.childNodes];
    let lastContent = children.length - 1;
    while (lastContent >= 0 && children[lastContent].nodeType === 3 && !children[lastContent].textContent?.trim()) lastContent -= 1;
    return children.every((child, i) => {
      const candidate = b.childNodes[i];
      if (!candidate) return false;
      // Only the last content branch may grow; ignore serialization-only
      // trailing whitespace when deciding which branch is still streaming.
      return i === lastContent ? prefixSafe(child, candidate) : child.isEqualNode(candidate);
    });
  }
  if (!prefixSafe(previous, next)) return nextHtml;
  const walker = document.createTreeWalker(next, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  let offset = 0;
  for (const node of nodes) {
    const start = Math.max(0, oldText.length - offset);
    offset += node.length;
    if (start >= node.length || !node.data.slice(start).trim()) continue;
    const suffix = start ? node.splitText(start) : node;
    const span = document.createElement('span');
    span.setAttribute('data-stream-text-fade', '');
    suffix.replaceWith(span);
    span.append(suffix);
  }
  return next.innerHTML;
}
