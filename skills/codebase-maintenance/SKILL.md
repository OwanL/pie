---
name: codebase-maintenance
description: >
  Audit and improve an existing codebase using targeted static analysis plus human review (dead code, smells, duplication, complexity, large files, and documentation drift). Use for broad maintenance passes, code-quality audits, dead-code sweeps, or refactor reviews; not for a one-off feature or isolated edit.
---

# Codebase Maintenance

This skill provides a structured static analysis workflow for improving code quality and maintainability.
Scripts are used to identify issues for review, you will then review the flagged issues and make informed
judgements on whether to refactor or ignore each item, flagging ambiguous cases for human review via the
ask user tool. This would look something like the following:
"The file at src/save.py exceeds the line threshold, however it is a single-concern module that may be
better left as is. Which of the following approaches should we take?"

Resolve script paths against this skill directory (for example, run `uv run find_large_files.py` with the skill directory as cwd). Run any script with `--help` to see full argument documentation.

## Ignoring files

Make additions when you get cache, build or other similar 'noise' or non-code files in the output of the
above steps.

- Patterns live in `codebase-maintenance/.ignore`.
- Patterns before any `context` line apply to every scan.
- Patterns after `context <working-directory>` only apply when the directory passed to the script matches
  that working-directory path or glob.
- Ignore patterns are evaluated relative to the scan root; patterns ending in `/` match directories.

## Execution order

Execute the following steps sequentially:

### 1. Dead code

```bash
uv run find_dead_code.py <directory> [options]
```

Dead code is the easiest win — unused functions, classes, imports, and files can often be removed
outright. Use `--verify-dead-code` to suppress false positives. For intentionally retained code
(plugin re-exports, dynamic dispatch), add a `// skylos-ignore` annotation.

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

Semgrep detects bugs and code smells. Fix findings, then re-run until clean. Use
`--exclude-categories` to suppress noise.

### 3. Duplicates

```bash
uv run find_duplicates.py <directory> [options]
```

Copy/paste duplicates across files (jscpd). Review each duplicate, some are
justified (shared config, test fixtures). Genuine duplicates should be extracted into shared
utilities. Use `--show-generated` to inspect lock-file / minified duplicates.

### 4. Complexity

```bash
uv run analyze_complexity.py <directory> [options]
```

Quality scores via Qualitas. Note: Qualitas reports at the **file level** — extracting helpers
within the same file won't reduce scores. Only moving code to separate modules improves
file-level metrics. Domain-appropriate complexity (dispatchers, pipelines) need not be eliminated.

### 5. Large files

```bash
uv run find_large_files.py <directory> [max_lines]
```

Files exceeding the line threshold (default: 500). Evaluate each — single-concern modules may
be fine as-is. Only refactor files that are genuinely multi-concern. Re-run after refactoring
to confirm all large files are justified.

### 6. Lint and test verification

Run the project's existing tests, type checks, and linters. Fix any regressions introduced by
earlier refactors, then re-run until clean.

### 7. .gitignore updates

Check for any new 'noise' files that should be ignored. Add clear cut cases to the `.ignore` file, and flag ambiguous cases for human review using the ask user tool.

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
