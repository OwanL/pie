# Decision Record Format

When a grilling session produces a decision worth recording, add it to `docs/` — either in an existing doc (ARCHITECTURE.md, STATE_CONTRACT.md) if it fits, or as a new file if it's a standalone concern.

## Template

```md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
```

That's it. A decision record can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most records won't need them.

- **Considered Options** — only when the rejected alternatives are worth remembering
- **Consequences** — only when non-obvious downstream effects need to be called out

## Where to put it

- **Fits an existing doc** (ARCHITECTURE.md, STATE_CONTRACT.md) → add it there under the relevant section
- **Standalone concern** → create a new file in `docs/` with a descriptive name (e.g. `PRUNING-DESIGN.md`)
- **Convention or terminology** → add it to `AGENTS.md`

Don't create a separate `docs/adr/` directory — this project records decisions inline in the relevant docs, not in a numbered ADR sequence.

## When to offer a decision record

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using CQRS-shaped Elm/MVI." "The host owns all state; the webview is a passive renderer."
- **Integration patterns between modules.** "The extension host and webview communicate via message passing, not shared state."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Session state is owned by the host; the webview never mutates it directly." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite.
- **Constraints not visible in the code.** "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.