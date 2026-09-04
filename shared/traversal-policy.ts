/**
 * Canonical workspace traversal-safety policy
 * (Milestone 0 vertical slice; STABILITY-ARCHITECTURE-PLAN §7.7 / workstream G).
 *
 * One source of truth for the protected-directory classes that broad agent
 * traversal must not enter by default. Consumers:
 *
 * - `extensions/warm-bash` builds recursive-`grep` `--exclude-dir` flags and
 *   bare-`find` `-prune` expressions from {@link PROTECTED_DIRECTORIES}.
 * - `skills/codebase-maintenance/.ignore` is drift-checked against
 *   {@link PROTECTED_DIRECTORIES} by that skill's scanner regression tests
 *   (`test_scanner_regressions.py`), so the scanner ignores cannot silently
 *   fall behind this policy.
 * - `AGENTS.md` mirrors {@link TRAVERSAL_POLICY_PROMPT} under a drift-tested
 *   marker, the default Pie harness rewrite imports it directly, and every
 *   subagent task prompt embeds it, so root agents and subagents receive the
 *   same policy.
 *
 * These entries exclude basename matches at any depth from BROAD traversal
 * only. Exact reads and deliberate, scoped inspection of a protected path stay
 * allowed everywhere. They complement Git-ignore-aware tools (rg), which keep
 * deriving their own excludes from each repo's actual .gitignore.
 *
 * Pure data + string helpers: no Node or SDK imports, so every consumer
 * (extension TS, tsx tests, and the Python drift check) can load it cheaply.
 */

/** Coarse protected classes, named after STABILITY-ARCHITECTURE-PLAN §7.7. */
export type ProtectedDirectoryClass =
	| "dependencies"
	| "version-control"
	| "generated-build"
	| "caches"
	| "coverage"
	| "runtime-data"
	| "sessions"
	| "logs"
	| "packaged-artifacts"
	| "temp-sdk-trees";

export interface ProtectedDirectory {
	/** Directory basename (any depth). May contain glob characters. */
	dir: string;
	className: ProtectedDirectoryClass;
}

/**
 * Ordered protected-directory entries. Order is presentation-only.
 * Basename matching means `data/` excludes a directory named `data` at any
 * depth, not only at the workspace root.
 */
export const PROTECTED_DIRECTORIES: readonly ProtectedDirectory[] = [
	// Dependencies (vendored installs; ~98% of typical workspace bytes).
	{ dir: "node_modules", className: "dependencies" },
	{ dir: ".venv", className: "dependencies" },
	{ dir: "venv", className: "dependencies" },
	{ dir: ".pnpm-store", className: "dependencies" },
	// Version-control internals.
	{ dir: ".git", className: "version-control" },
	// Generated and build output.
	{ dir: "dist", className: "generated-build" },
	{ dir: "build", className: "generated-build" },
	{ dir: "out", className: "generated-build" },
	{ dir: "out-tsc", className: "generated-build" },
	{ dir: ".next", className: "generated-build" },
	{ dir: ".turbo", className: "generated-build" },
	{ dir: ".moon", className: "generated-build" },
	// Caches (tool and package-manager caches, analysis scratch).
	{ dir: ".cache", className: "caches" },
	{ dir: "__pycache__", className: "caches" },
	{ dir: ".pytest_cache", className: "caches" },
	{ dir: ".mypy_cache", className: "caches" },
	{ dir: ".ruff_cache", className: "caches" },
	{ dir: ".temp", className: "caches" },
	{ dir: ".tmp", className: "caches" },
	{ dir: ".parcel-cache", className: "caches" },
	{ dir: ".skylos", className: "caches" },
	{ dir: "web-search-cache", className: "caches" },
	// Coverage output.
	{ dir: "coverage", className: "coverage" },
	{ dir: ".nyc_output", className: "coverage" },
	// Runtime data (multi-gigabyte pi runtime artifacts live under data/).
	{ dir: "data", className: "runtime-data" },
	// Session transcripts and per-session workspaces.
	{ dir: "sessions", className: "sessions" },
	// Logs.
	{ dir: "logs", className: "logs" },
	// Packaged/test-run artifacts.
	{ dir: ".vscode-test", className: "packaged-artifacts" },
	{ dir: "test-results", className: "packaged-artifacts" },
	{ dir: "playwright-report", className: "packaged-artifacts" },
	{ dir: "*.egg-info", className: "packaged-artifacts" },
	// Temporary SDK test worktrees (may survive interrupted runs).
	{ dir: ".pie-sdk-*", className: "temp-sdk-trees" },
];

/** Flat basename list in canonical order. */
export const PROTECTED_DIRECTORY_NAMES: readonly string[] =
	PROTECTED_DIRECTORIES.map((entry) => entry.dir);

const PROTECTED_NAME_SET: ReadonlySet<string> = new Set(PROTECTED_DIRECTORY_NAMES);

/** Entries that use shell glob characters rather than exact basenames. */
const GLOB_PROTECTED: readonly { dir: string; regex: RegExp }[] =
	PROTECTED_DIRECTORIES
		.filter((entry) => /[*?[]/.test(entry.dir))
		.map((entry) => ({ dir: entry.dir, regex: globToRegExp(entry.dir) }));

/** `--exclude-dir=` flag string for GNU grep (globs are accepted by grep). */
export function grepExcludeFlags(): string {
	return PROTECTED_DIRECTORY_NAMES.map((d) => `--exclude-dir=${d}`).join(" ");
}

/**
 * Bare-`find` prune tests: `-name a -o -name 'b*'`. Glob entries are
 * single-quoted so the generated command stays shell-safe.
 */
export function findPruneExpression(): string {
	return PROTECTED_DIRECTORY_NAMES
		.map((d) => (/[*?[]/.test(d) ? `-name '${d}'` : `-name ${d}`))
		.join(" -o ");
}

/**
 * Case-insensitive substring regex over the protected names. Substring (not
 * component) matching is deliberate and conservative: a find expression that
 * merely mentions a protected name (`.github`, `*.git*`, `*data*`) is passed
 * through unpruned rather than risk hiding the results being searched for.
 * Glob entries become prefix regexes (`.pie-sdk-*` → `\.pie\-sdk\-.*`), so any
 * expression mentioning a temporary SDK worktree passes through too.
 */
export const PROTECTED_DIRECTORY_REF: RegExp = new RegExp(
	PROTECTED_DIRECTORY_NAMES
		.map((name) => escapeRegExp(name).replace(/\\\*/g, ".*").replace(/\\\?/g, "."))
		.join("|"),
	"i",
);

/**
 * True when a path-like token deliberately targets a protected tree (exact
 * basename path component, or a glob-class entry match). Used to keep scoped
 * opt-in inspection such as `grep -rn foo data/` working: pruning must not
 * silently empty a search the caller aimed at a protected path.
 */
export function referencesProtectedDirectory(value: string): boolean {
	const parts = value.split(/[\\/]/);
	for (const part of parts) {
		if (PROTECTED_NAME_SET.has(part)) return true;
		for (const glob of GLOB_PROTECTED) {
			if (glob.regex.test(part)) return true;
		}
	}
	return false;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
	const escaped = escapeRegExp(pattern)
		.replace(/\\\*/g, "[^\\\\/]*")
		.replace(/\\\?/g, "[^\\\\/]");
	return new RegExp(`^${escaped}$`);
}

/**
 * Concise traversal-safety paragraph embedded in every subagent task prompt
 * (and available to root-agent preambles). Deliberately repo-agnostic: it
 * names the protected classes rather than workspace-specific paths.
 */
export const TRAVERSAL_POLICY_PROMPT = [
	"Traversal safety: dependency, version-control, generated/build, cache, coverage,",
	"runtime-data (e.g. data/), session, log, packaged-artifact, and temporary-SDK trees",
	"are protected. Never traverse them with broad recursive searches (`grep -r`, bare",
	"`find .`) or unscoped directory walks; known protected directories are pruned",
	"automatically, and the rest are simply very large. To inspect a protected path",
	"deliberately, read an exact file, scope the search to that path, or use a",
	"Git-aware tool (rg). Do not widen a search to work around an empty result.",
].join(" ");