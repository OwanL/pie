---
name: grill-with-docs
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

# Grill with docs

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing.

If a question can be answered by exploring the codebase, explore the codebase instead.

## Repository context

Follow the target project's applicable instructions, context files, documentation map and established terminology. Read the design sections relevant to the plan. For Pie source work, load `develop-pie`; resolve its repository references against the identified Pie source checkout, not this bundled skill. Do not impose Pie's documentation layout or workflow on another project.

If an optional document is absent, proceed with available conventions. Update the owning documents as decisions crystallise.

## During the session

### Challenge against existing docs

When the user's term conflicts with language in the target project's architecture/design docs or applicable instructions, call it out immediately. For Pie source work, consult `docs/architecture/ARCHITECTURE.md` and `docs/contracts/STATE_CONTRACT.md` in the identified Pie source checkout; for another project, use its owning docs. For example: “Your architecture doc defines the pattern as ‘X’, but you seem to be describing something different—which is it?”

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees with the repository's documented contracts. If you find a contradiction, surface it: "The repository's state contract says session-scoped events must include `sessionPath`, but this handler doesn't — which is right?"

### Update docs inline

When a term or decision is resolved, update the relevant doc right there. Don't batch these up — capture them as they happen:

- **Terminology or conventions** → update the owning project guide or design document. In Pie, source-work conventions belong in `develop-pie`, not a globally loaded instruction file.
- **Architectural concepts, module boundaries, patterns** → update its architecture or design doc
- **State rules, mutation patterns, protocol constraints** → update its state/contract doc
- **New design decision worth recording** → add to the repository's documented docs location or append to the relevant existing doc

Use [DOC-FORMAT.md](./DOC-FORMAT.md) as a general aid for concise, accurate documentation edits, not as a required format. Follow the target project's existing documentation conventions; do not impose Pie's docs layout.

### Offer decision records sparingly

Only offer to record a decision when it meets the eligibility criteria in [DECISION-FORMAT.md](./DECISION-FORMAT.md). When working in another repository, follow that repository's decision-record conventions instead; do not impose Pie's ADR/docs layout.
