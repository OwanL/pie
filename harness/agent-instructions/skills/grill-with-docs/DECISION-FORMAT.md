# Decision-record guidance

When a grilling session produces a decision worth recording, use the target project's decision-record conventions and owning documentation location. Do not create a Pie-style `docs/` structure in another project.

## Pie source work

A concise record may use:

```md
# {Short title of the decision}

{1-3 sentences: context, decision and rationale.}
```

For Pie source decisions, update the owning architecture or contract document in the identified Pie source checkout. Put Pie-specific source-work conventions in the [develop-pie skill](../develop-pie/SKILL.md). Do not create a separate ADR directory; Pie records decisions inline in the relevant docs.

Offer a decision record only when all three apply:

1. **Hard to reverse** — changing course later has meaningful cost.
2. **Surprising without context** — a future reader would wonder why this choice was made.
3. **A real trade-off** — credible alternatives existed and one was selected for a reason.

Useful examples include architectural shape, module integration boundaries, lock-in-bearing technology choices, explicit scope boundaries, non-obvious deviations and constraints not visible in code. Use the target project's own format and locations for every other project.
