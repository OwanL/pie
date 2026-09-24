---
name: codebase-maintenance
description: >
  Audit and improve an existing codebase using targeted static analysis plus human review (dead code, smells, duplication, complexity, large files, and documentation drift). Use for broad maintenance passes, code-quality audits, dead-code sweeps, or refactor reviews; not for a one-off feature or isolated edit.
---

# Codebase Maintenance

Use targeted static analysis and human judgment to identify actionable maintenance issues. Scanner findings are candidates, not instructions to refactor. Ask the user when a material scope or design choice is unresolved; do not ask merely because a metric exceeds a threshold. For audit-only requests, report findings without making changes.

Resolve script paths against this skill directory (for example, run `uv run find_large_files.py` with the skill directory as cwd). Run any script with `--help` to see full argument documentation.

## Ignoring files

Exclude cache, build, and other irrelevant files when they create scanner noise.

- Scanner patterns live in `.ignore` in this skill directory.
- Patterns before any `context` line apply to every scan.
- Patterns after `context <working-directory>` only apply when the directory passed to the script matches
  that working-directory path or glob.
- Ignore patterns are evaluated relative to the scan root; patterns ending in `/` match directories.

## Select relevant checks

Choose checks that answer the requested maintenance question. For a broad code audit, use the order below; for documentation or guidance audits, start with document drift and semantic review, skipping code scanners. Scope scans to relevant source trees and follow repository traversal rules. After approved edits, rerun affected checks and proportionate verification, not every scanner.

### 1. Dead code

```bash
uv run find_dead_code.py <directory> [options]
```

Dead code is the easiest win — unused functions, classes, imports, and files can often be removed
outright. Use `--verify-dead-code` to suppress likely false positives; findings that cannot be
cross-checked are retained in a separate unverified section rather than labeled dead. For intentionally
retained code (plugin re-exports, dynamic dispatch), add a `// skylos-ignore` annotation.

**Bundler caveat (esbuild/webpack/vite/rollup):** skylos traces static `import`/`require` edges
only — it cannot see a bundler's entry-point graph, dynamic `import()`, or config-driven resolution.
On bundled TS/JS projects it floods the output with `unused file (not imported by any other file)`
findings that are in fact imported via the bundler. With `--verify-dead-code`, "unused file" findings
are cross-checked by searching for the module's basename in import/require statements across the
codebase (so a file that is `import`ed anywhere is suppressed automatically). If your project uses
runtime/config-driven resolution that no static check can see, expect residual false positives in
the "file" category and triage them manually rather than deleting blindly.

**After removing dead code, re-run this script** to confirm findings are resolved. Then run your
project's type-checker and linter immediately — dead-code removal often exposes `unused-import` or
`no-unused-vars` violations that the scanner missed. Fix those before proceeding.

### 2. Code smells

```bash
uv run detect_smells.py <directory> [options]
```

Semgrep detects bugs and code smells. Verify the flagged code paths, fix supported in-scope issues, and rerun the affected checks. Use `--exclude-categories` to suppress irrelevant categories.

### 3. Duplicates

```bash
uv run find_duplicates.py <directory> [options]
```

Copy/paste duplicates across files (jscpd). Review whether they represent the same responsibility; shared config and test fixtures may justify repetition. Extract shared utilities only when they reduce maintenance cost without coupling unrelated behavior. Use `--show-generated` to inspect lock-file / minified duplicates, or
`--exclude-test-directories` when test boilerplate dominates the report.

### 4. Complexity

```bash
uv run analyze_complexity.py <directory> [options]
```

Qualitas reports at the **file level**. Treat scores as investigation signals, not refactoring targets. Simplify genuinely difficult behavior or split distinct responsibilities; do not move code solely to improve a metric. Domain-appropriate complexity in dispatchers or pipelines may be justified.

### 5. Large files

```bash
uv run find_large_files.py <directory> [max_lines]
```

Files exceeding the line threshold (default: 500). Evaluate each — single-concern modules may
be fine as-is. Only refactor files that are genuinely multi-concern. Recheck affected files after refactoring.

### 6. Lint and test verification

After code changes, run the project's required tests, type checks, and linters at a proportionate scope. Fix regressions caused by the changes. For documentation-only changes, use relevant link, drift, or contract checks instead of unrelated code tests.

### 7. Ignore-pattern updates

Keep scanner exclusions in the skill's `.ignore`. Change the repository's `.gitignore` only when a file should also be excluded from version control. Do not hide source or required artifacts merely to silence a scanner; ask when ownership is unclear.

### 8. Document drift

```bash
uv run find_markdown_drift.py <directory> [options]
```

Stale internal references and broken external URLs in markdown files. Output sorted
by last modified (oldest first). Broken refs are `[internal]`/`[external]`; ambiguous
ones (403, 5xx, timeouts) are `[uncertain]`. Use `--check-anchors` to also validate
`#heading` fragments. Fix internal broken refs first — they almost always mean
something was moved without updating the docs. For uncertain external refs, re-run
with `--verbose` before pruning. Verify semantic accuracy: a path may resolve but
the surrounding prose may no longer describe the target's contents. Re-run after
fixes to confirm.
