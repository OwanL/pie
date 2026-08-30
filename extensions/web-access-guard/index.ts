/**
 * web-access-guard — startup policy guard for the `pi-web-access` extension.
 *
 * WHY THIS EXISTS
 *
 * `pi-web-access@0.27.0` loads natively under the pinned Pi 0.80.x runtime,
 * including its required `@earendil-works/pi-ai/compat` entrypoint. Pie still
 * needs a small load-time policy pass because upstream defaults web searches
 * to an interactive curator that automatically spends tokens generating a
 * second summary. Pie deliberately returns the provider's cited answer
 * directly, so the workflow is hard-clamped to `"none"` in the active managed
 * package rather than relying on model-controlled tool arguments.
 *
 * A separate environment-specific failure can occur on Windows: when npm
 * cannot replace a file during install (e.g. a previous pi process still had
 * it open) it renames it out of the way as `<name>.DELETE.<hash>`; if the
 * replacement write also fails the real file is left missing and the
 * package's `node_modules` is corrupted, again breaking load.
 *
 * WHAT IT DOES
 *
 * At extension-load time — and `pie/extensions/*` are discovered *before*
 * package entries, so this runs before `pi-web-access/index.ts` is loaded —
 * it:
 *   1. Locates the installed `pi-web-access` package with no hardcoded
 *      absolute paths: the active managed install at
 *      `<PI_CODING_AGENT_DIR>/npm/node_modules/pi-web-access` first — the copy
 *      pi actually loads (mirroring pi's `getManagedNpmInstallPath`), so it
 *      never patches a stale, inactive global copy.
 *   2. Hard-clamps the web-search workflow and schema to raw results only.
 *   3. Repairs `.DELETE.<hash>` corruption — renaming each artifact back to
 *      its original name only when no real file occupies that name.
 *
 * It is idempotent and forward-compatible: if upstream rewrites a workflow
 * site, that source transform becomes a no-op. It registers no tools. It never
 * throws — a failure here must not break the rest of extension loading — but
 * every failure is logged
 * to stderr with the `[web-access-guard]` prefix, and source patches are
 * written atomically (temp file + rename) then re-verified, so a silent or
 * half-written break is never left undiagnosed.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { type Dirent } from "node:fs";
import { access, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Prefix on every diagnostic line so users can attribute/filter the source. */
const LOG_PREFIX = "web-access-guard";

/**
 * Matches `function resolveWorkflow(...): WebSearchWorkflow { ... }` — the
 * single chokepoint that decides whether `web_search` opens the curator
 * (`summary-review`) or runs an LLM summary round-trip (`auto-summary`). The
 * body has no nested braces, so the first `\n}` reliably marks the function
 * end. Tolerant of signature changes: `[^)]*` accepts any param list.
 */
const RESOLVE_WORKFLOW_RE = /function resolveWorkflow\([^)]*\): WebSearchWorkflow \{[\s\S]*?\n\}/;

/**
 * Matches the `workflow` parameter's `StringEnum(["none", "summary-review",
 * "auto-summary"], { ... })` schema in the tool registration — the only site
 * where those three values appear together as an array literal. The /curator
 * command compares strings (`arg === "summary-review"`), not arrays, so it
 * is never touched.
 */
const WORKFLOW_ENUM_RE = /StringEnum\(\["none", "summary-review", "auto-summary"\],[\s\S]*?\}\)/;

/**
 * Matches the misleading sentence in `web_search`'s tool `description` that
 * claims searches auto-open the curator and that `"none"` / `"auto-summary"`
 * are selectable workflows. After `patchWorkflowClampInSource`, the only
 * effective mode is `"none"` (raw results); the curator and LLM summary are
 * disabled, so the description must match that effective behavior.
 */
const WORKFLOW_DESCRIPTION_RE =
	/Searches auto-open the interactive browser curator and stream results live; set workflow to "none" to skip curation or "auto-summary" for a model-generated summary without the browser curator\./g;

const WORKFLOW_DESCRIPTION_FIXED =
	'Only raw search results are returned in this deployment — the interactive curator and LLM summary modes are disabled (workflow is fixed to "none").';

/**
 * The clamped `resolveWorkflow`: always returns `"none"`. The only way to
 * guarantee `generateSummaryDraft` can never be reached, regardless of config,
 * `/curator on`, or a per-call `workflow: "summary-review"` / `"auto-summary"
 * override from the model.
 */
const RESOLVE_WORKFLOW_CLAMPED =
	"function resolveWorkflow(input: unknown, hasUI: boolean): WebSearchWorkflow {\n" +
	'\treturn "none";\n' +
	"}";
/** `@mozilla/readability`'s `index.js` `require()`s this; missing it = corrupted. */
const READABILITY_ENTRY = "@mozilla/readability/Readability.js";

/**
 * Best-effort diagnostic sink. `ExtensionAPI` exposes no logger, so route to
 * stderr (`console.warn`) — never throws.
 */
function log(message: string): void {
	console.warn(`[${LOG_PREFIX}] ${message}`);
}

/** Render an unknown catch value as a short, human-readable string. */
function describeErr(err: unknown): string {
	if (err instanceof Error) return err.message || err.name;
	return String(err);
}

/** True iff `p` exists (async, non-throwing). */
async function pathExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Atomically replace `target` with `content`: write to a sibling temp file
 * then rename over `target`. A crash mid-write leaves either the old or the
 * new file, never a truncated/partial one. The temp file is cleaned up on
 * failure. Throws on failure so the caller can log + degrade gracefully.
 */
async function atomicWriteFile(target: string, content: string): Promise<void> {
	const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		await writeFile(tmp, content, "utf8");
		await rename(tmp, target);
	} catch (err) {
		await rm(tmp, { force: true });
		throw err;
	}
}

/**
 * Re-read `target` and confirm it equals `expected` — verifies the patch
 * actually landed (guards against a silent / partial / concurrent write).
 * Logs an actionable warning on mismatch; never throws.
 */
async function verifyPatch(target: string, expected: string): Promise<void> {
	let actual: string;
	try {
		actual = await readFile(target, "utf8");
	} catch (err) {
		log(`could not verify ${target} after write: ${describeErr(err)} — web tools may not load; reinstall pi-web-access if needed`);
		return;
	}
	if (actual !== expected) {
		log(`verification mismatch in ${target} after write — another process may have modified it; web tools may not load; reinstall pi-web-access if needed`);
	}
}

/**
 * Hard-clamp `web_search`'s workflow to `"none"` so the curator + LLM summary
 * path can *never* execute — not via config default, not via `/curator`, not
 * via a per-call `workflow: "summary-review"` / `"auto-summary"` override from
 * the model. This is the physical-impossibility layer: even if the agent
 * requests a summary, the runtime cannot honour it.
 *
 * Two transforms:
 *   1. `resolveWorkflow(...)` → always returns `"none"`. This is the single
 *      chokepoint: `shouldCurate = workflow === "summary-review"` and the
 *      `if (workflow === "auto-summary")` summary branch are both gated on
 *      its return, so clamping it dead-roots `generateSummaryDraft`.
 *   2. The tool-schema `workflow` enum is reduced to `["none"]` so the model
 *      is never even offered `summary-review` / `auto-summary` as valid
 *      values — defence in depth before the runtime clamp.
 *
 * Idempotent: an already-clamped `resolveWorkflow` matches the same regex and
 * rewrites to identical text, and the clamped enum no longer matches the
 * three-value regex, so the write is skipped. Forward-compatible: if upstream
 * rewrites either site, the regex misses and the pass is a no-op — same
 * philosophy as the other source transforms.
 */
export function patchWorkflowClampInSource(content: string): string {
	return content
		.replace(RESOLVE_WORKFLOW_RE, RESOLVE_WORKFLOW_CLAMPED)
		.replace(
			WORKFLOW_ENUM_RE,
			'StringEnum(["none"], { description: "Search workflow mode: none = raw results only (curator and LLM summary disabled)" })',
		);
}

/**
 * Rewrite `web_search`'s tool `description` so it matches the clamped runtime
 * behavior: the workflow is always `"none"` (raw search results only), and
 * the curator + LLM summary path is disabled in this deployment.
 *
 * Idempotent: once the misleading sentence is gone the regex no longer
 * matches and the pass is a no-op. Forward-compatible: if upstream rewords
 * the description, the regex misses and the pass is a no-op — same philosophy
 * as `patchWorkflowClampInSource`.
 */
export function patchWorkflowDescriptionInSource(content: string): string {
	return content.replace(WORKFLOW_DESCRIPTION_RE, WORKFLOW_DESCRIPTION_FIXED);
}

/** True for npm's "could not replace" rename artifacts, e.g. `Readability.js.DELETE.e9020…`. */
export function isDeleteArtifact(name: string): boolean {
	return /\.DELETE\..+$/.test(name);
}

/** Strip the `.DELETE.<hash>` suffix to recover the original file name. */
export function stripDeleteSuffix(name: string): string {
	const idx = name.indexOf(".DELETE.");
	return idx === -1 ? name : name.slice(0, idx);
}

/**
 * Hard-clamp the `web_search` workflow to `"none"` across `pi-web-access`'s
 * `.ts`/`.js` sources. Returns the number of files written. Idempotent and
 * never-throwing. See
 * `patchWorkflowClampInSource` for what the clamp guarantees and why.
 */
export async function patchWorkflowClampFiles(root: string): Promise<number> {
	return patchFilesWith(root, patchWorkflowClampInSource, "workflow-clamp");
}

/**
 * Rewrite `web_search`'s tool `description` across `pi-web-access`'s
 * `.ts`/`.js` sources so it matches the effective workflow. Returns the
 * number of files written. Idempotent and never-throwing, identical in contract
 * to the other `patch*Files` helpers.
 */
export async function patchWorkflowDescriptionFiles(root: string): Promise<number> {
	return patchFilesWith(root, patchWorkflowDescriptionInSource, "workflow-description");
}

/**
 * Generic single-pass source patcher: walks `root`'s top-level `.ts`/`.js`
 * files, applies `transform` to each, and atomically writes the ones that
 * changed. Returns the count written. Idempotent — a file the transform
 * leaves unchanged is a no-op. Never throws: read, write, and verify failures
 * are logged (tagged with `label`) and skipped so one bad file cannot abort
 * the rest, and writes are atomic so a failure never corrupts the file.
 */
async function patchFilesWith(
	root: string,
	transform: (content: string) => string,
	label: string,
): Promise<number> {
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch (err) {
		log(`could not read package directory ${root}: ${describeErr(err)}`);
		return 0;
	}
	let patched = 0;
	for (const name of entries) {
		if (!/\.(ts|js)$/i.test(name)) continue;
		const full = path.join(root, name);
		try {
			if (!(await stat(full)).isFile()) continue;
		} catch (err) {
			log(`could not stat ${full}: ${describeErr(err)} — skipping`);
			continue;
		}
		let content: string;
		try {
			content = await readFile(full, "utf8");
		} catch (err) {
			log(`could not read ${full}: ${describeErr(err)} — skipping`);
			continue;
		}
		const next = transform(content);
		if (next === content) continue; // already patched / nothing to do — idempotent no-op
		try {
			await atomicWriteFile(full, next);
			await verifyPatch(full, next);
			patched++;
		} catch (err) {
			// atomic write failed before rename → original file is untouched
			log(`failed to apply ${label} patch to ${full}: ${describeErr(err)} — file left unchanged; web tools may not load; reinstall pi-web-access if needed`);
		}
	}
	return patched;
}

/** Yield every real (non-symlink) file under `dir`, recursively. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch (err) {
		log(`could not walk directory ${dir}: ${describeErr(err)} — skipping subtree`);
		return;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			yield* walkFiles(full);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

/**
 * Repair npm's `.DELETE.<hash>` corruption under `root`: rename each artifact
 * back to its original name, but only when no real file already occupies that
 * name (npm may have written a fresh copy we must keep). Returns the count
 * restored. Idempotent. Never throws — rename failures are logged and skipped.
 */
export async function repairDeleteArtifacts(root: string): Promise<number> {
	let restored = 0;
	for await (const file of walkFiles(root)) {
		const name = path.basename(file);
		if (!isDeleteArtifact(name)) continue;
		const base = path.join(path.dirname(file), stripDeleteSuffix(name));
		if (await pathExists(base)) continue; // a real file already occupies the name — keep it
		try {
			await rename(file, base);
			restored++;
		} catch (err) {
			log(`could not restore ${name} → ${stripDeleteSuffix(name)}: ${describeErr(err)} — left as-is`);
		}
	}
	return restored;
}

/**
 * Probe whether `@mozilla/readability` loads — its `index.js` requires
 * `./Readability`, so a missing `Readability.js` (renamed to `.DELETE.<hash>`)
 * is a reliable, cheap signal that `node_modules` is corrupted.
 */
export async function readabilityIntact(root: string): Promise<boolean> {
	try {
		const req = createRequire(path.join(root, "package.json"));
		return await pathExists(req.resolve(READABILITY_ENTRY));
	} catch {
		return false;
	}
}

/** Enforce Pie's web-search policy and repair a known npm corruption mode. */
export async function applyWebAccessGuard(root: string): Promise<void> {
	await patchWorkflowClampFiles(root);
	await patchWorkflowDescriptionFiles(root);
	if (!(await readabilityIntact(root))) {
		await repairDeleteArtifacts(root);
	}
}

/**
 * Filesystem probe injected so package-root lookup tests never touch the real
 * managed install.
 */
export interface PackageRootLookupDeps {
	/** Return Pi's active agent directory. */
	getAgentDir(): string;
	/** Return the current user's home directory for `~` expansion. */
	getHomeDir(): string;
	/** True iff `p` exists (async, non-throwing). */
	pathExists(p: string): Promise<boolean>;
}

const SOURCE_AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRODUCTION_LOOKUP_DEPS: PackageRootLookupDeps = {
	getAgentDir: () => process.env.PI_CODING_AGENT_DIR?.trim() || SOURCE_AGENT_DIR,
	getHomeDir: homedir,
	pathExists,
};
const PACKAGE_NAME = "pi-web-access";

/**
 * Locate the active managed `pi-web-access` install. Modern Pi installs user
 * npm packages exclusively under `<agentDir>/npm/node_modules`; stale global
 * package fallbacks are deliberately ignored because Pi will not load them
 * when the managed package exists.
 */
export async function resolvePackageRoot(
	deps: PackageRootLookupDeps = PRODUCTION_LOOKUP_DEPS,
): Promise<string | null> {
	const configured = deps.getAgentDir();
	let agentDir = configured;
	if (configured === "~") {
		agentDir = deps.getHomeDir();
	} else if (/^[~][\\/]/.test(configured)) {
		agentDir = path.join(deps.getHomeDir(), configured.slice(2));
	}
	const managed = path.join(agentDir, "npm", "node_modules", PACKAGE_NAME);
	return (await deps.pathExists(path.join(managed, "package.json"))) ? managed : null;
}

/**
 * Self-heal entry point. `resolveRoot` is injectable for testing (sync or
 * async); in production it resolves the managed install via
 * `resolvePackageRoot`. Never throws — any failure is logged with an
 * actionable hint and swallowed so extension loading continues.
 */
export async function runSelfHeal(
	resolveRoot: () => string | null | Promise<string | null> = resolvePackageRoot,
): Promise<void> {
	try {
		const root = await resolveRoot();
		if (root) await applyWebAccessGuard(root);
	} catch (err) {
		log(`self-heal failed: ${describeErr(err)} — web tools may be unavailable; reinstall pi-web-access if its tools are missing`);
	}
}

/** pi extension factory — runs the self-heal at load time, before pi-web-access loads. */
export default async function (_pi: ExtensionAPI): Promise<void> {
	await runSelfHeal();
}
