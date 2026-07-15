# Archived one-shot codemods

These are **dated one-shot codemods** — single-use refactoring scripts that have
already served their purpose and are kept here for history. They are **not** part
of any build/test/CI path and should not be re-run: several are destructive
(overwrite source with no backup) and rely on source text that has since moved.

| Script | Original purpose | Why archived |
|---|---|---|
| `split-protocol.mjs` | One-shot split of `protocol.ts` into per-domain files | Destructive: overwrote `protocol.ts` with a barrel on every run, no backup/idempotency. Completed refactor. |
| `replace-isrecord.mjs` | One-shot `IsRecord<T>` → narrowed-type replacement | Fragile brace counter (ignores braces in strings/regex/templates/comments). Completed. |
| `extract-reducer-handlers.mjs` | One-shot extraction of reducer handlers into domain files | Whitespace-sensitive `src.includes(block)` match, CWD-relative, prints "Done" even on no-op. Completed. |

Archived 2026-06-25 after the structural review pass.

If a similar one-shot is needed again, write a **new** script under `scripts/`
with an explicit dated header and delete/move it here when done — do not resurrect
these.