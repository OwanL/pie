---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

# Domain awareness

<what-to-do>

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

</what-to-do>

<supporting-info>

## Domain awareness

During codebase exploration, also look for existing documentation.

### Repository-specific structure

First read the applicable repository instructions (`AGENTS.md` and, when present,
`CONTEXT.md`). Follow that repository's documented entry point, relevant docs, and
actual structure rather than assuming this skill's example layout.

When working in pie, start from its curated `docs/INDEX.md` instead of scanning
`docs/` directly. The pie reference shape is:

```
/
├── AGENTS.md                  ← conventions and repo-specific instructions
├── docs/
│   ├── INDEX.md               ← curated doc index; start here
│   ├── ARCHITECTURE.md        ← system overview, patterns, information flow
│   ├── STATE_CONTRACT.md      ← authoritative state management rules
│   └── ...other design docs (discovered via INDEX)
```

When working in another repository, do not assume `docs/INDEX.md`, these filenames, or
this layout. Follow that repository's `AGENTS.md`/`CONTEXT.md`/docs conventions and
inspect the relevant docs and structure instead.

Key files to read before grilling:

- **Applicable `AGENTS.md`** — repository conventions, build commands, and tooling expectations
- **`CONTEXT.md`, when present** — repository or domain context
- **In pie:** `docs/INDEX.md` first, then its entries relevant to the plan, including `docs/ARCHITECTURE.md` and `docs/STATE_CONTRACT.md` when applicable
- **In another repository:** the documentation entry point and architecture, state, or design references named by that repository's instructions

If an optional instruction or referenced doc does not exist, proceed with the repository's
available conventions; don't flag its absence. Update the relevant docs lazily when
decisions crystallise.

## During the session

### Challenge against existing docs

When the user uses a term that conflicts with the language established in the
repository's architecture/design docs or `AGENTS.md`/`CONTEXT.md`, call it out
immediately. In pie, this includes `docs/ARCHITECTURE.md` and
`docs/STATE_CONTRACT.md`: "Your architecture doc defines the pattern as
'CQRS-shaped Elm/MVI', but you seem to be describing something different — which is
it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees with the repository's documented contracts. If you find a contradiction, surface it: "The repository's state contract says session-scoped events must include `sessionPath`, but this handler doesn't — which is right?"

### Update docs inline

When a term or decision is resolved, update the relevant doc right there. Don't batch these up — capture them as they happen:

- **Terminology or conventions** → update the repository's applicable `AGENTS.md`
- **Architectural concepts, module boundaries, patterns** → update its architecture or design doc
- **State rules, mutation patterns, protocol constraints** → update its state/contract doc
- **New design decision worth recording** → add to the repository's documented docs location or append to the relevant existing doc

When working in Pie, use its format guidelines in [DOC-FORMAT.md](./DOC-FORMAT.md). When working in another repository, follow that repository's documentation conventions instead; do not impose Pie's docs layout.

### Offer decision records sparingly

Only offer to record a decision when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip it. When working in Pie, use its format in [DECISION-FORMAT.md](./DECISION-FORMAT.md). When working in another repository, follow that repository's decision-record conventions instead; do not impose Pie's ADR/docs layout.

</supporting-info>