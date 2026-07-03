# Doc Format

## Updating existing docs

This project uses specific docs for different concerns. Update the right one:

### AGENTS.md — conventions and instructions

Add terminology, conventions, and repo-specific instructions here. Keep it concise — this is the "how we work here" file, not a spec.

When adding a term, use this pattern:

```md
**Term**:
A one or two sentence definition of what it IS, not what it does.
_Avoid_: synonym1, synonym2
```

Rules:

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max.
- **Only include terms specific to this project.** General programming concepts don't belong. Before adding a term, ask: is this a concept unique to this project, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge.

### docs/ARCHITECTURE.md — system overview and patterns

Add or update architectural concepts, module boundaries, and design patterns here. This is the "how the system fits together" file.

When updating:

- Be precise about relationships and data flow
- Use the project's established terminology (check AGENTS.md)
- Update the relevant section — don't create a parallel description
- Keep diagrams and flow descriptions consistent with the code

### docs/STATE_CONTRACT.md — state management rules

Add or update protocol rules, mutation constraints, and session-scoped behaviour here. This is the "what guarantees the state system upholds" file.

When updating:

- State rules as invariants, not suggestions
- Reference the specific events, actions, or state fields involved
- Keep the language precise — "must", "never", "always", not "should", "typically", "usually"

### New docs in docs/

If a decision doesn't fit into an existing doc, create a new file in `docs/`. Name it descriptively (e.g., `MODEL-SCORING.md`, `PRUNING-DESIGN.md`). Existing examples: `STATE_CONTRACT.md`, `ARCHITECTURE.md`, `AGENT-HARNESS-IMPROVEMENTS.md`.

Follow the existing naming convention — either UPPER-CASE-With-Dashes.md or lower-case-with-dashes.md, matching the prevailing style in the directory.