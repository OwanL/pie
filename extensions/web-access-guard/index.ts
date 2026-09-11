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
 * package entries, so this runs before the managed package extensions are
 * loaded — it:
 *   1. Locates the active managed `pi-web-access` and `pi-mcp-adapter`
 *      packages under `<PI_CODING_AGENT_DIR>/npm/node_modules` (mirroring
 *      pi's `getManagedNpmInstallPath`), so stale global copies are never
 *      patched.
 *   2. Applies the exact-version/fingerprint-checked cache seams, then
 *      hard-clamps the web-search workflow and schema to raw results only.
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
import { classifyManagedPackageSources, MANAGED_PACKAGE_REQUIREMENTS, managedPackageRoot, managedRequiredFileCandidates, resolveManagedCacheTargets } from "../../shared/managed-package-contract.mjs";
import { resolvePieDataPaths } from "../../shared/pie-data-root-core.mjs";

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

/**
 * P2c uses only these exact installed package versions. The packages do not
 * currently expose an independent cache-root option, so the checked-in
 * load-time transforms below are deliberately fingerprinted to these source
 * shapes and fail closed on a version/source drift.
 */
const MCP_ADAPTER_REQUIREMENT = MANAGED_PACKAGE_REQUIREMENTS.find((entry) => entry.name === "pi-mcp-adapter")!;
const WEB_ACCESS_REQUIREMENT = MANAGED_PACKAGE_REQUIREMENTS.find((entry) => entry.name === "pi-web-access")!;
const MCP_ADAPTER_PACKAGE_NAME = MCP_ADAPTER_REQUIREMENT.name;
const MCP_ADAPTER_VERSION = MCP_ADAPTER_REQUIREMENT.version;
const WEB_ACCESS_PACKAGE_NAME = WEB_ACCESS_REQUIREMENT.name;
const WEB_ACCESS_VERSION = WEB_ACCESS_REQUIREMENT.version;

const MCP_AGENT_PATH_RE = /export function getAgentPath\(\.\.\.segments: string\[\]\): string \{\n  return join\(getAgentDir\(\), \.\.\.segments\);\n\}/;
const MCP_AGENT_PATH_REPLACEMENT = [
	"export function getAgentPath(...segments: string[]): string {",
	"  const cacheDir = process.env.PIE_CACHE_DIR?.trim();",
	"  if (cacheDir && segments.length === 1 && (segments[0] === \"mcp-cache.json\" || segments[0] === \"mcp-npx-cache.json\")) {",
	"    return join(resolve(cacheDir), segments[0]);",
	"  }",
	"  return join(getAgentDir(), ...segments);",
	"}",
].join("\n");

const WEB_FETCH_CACHE_IMPORT_RE = /import \{ join \} from \"node:path\";/;
const WEB_FETCH_CACHE_RE = /export function getFetchCacheDir\(\): string \{\n\treturn join\(getWebSearchConfigDir\(\), FETCH_CACHE_DIR\);\n\}/;
const WEB_FETCH_CACHE_IMPORT_REPLACEMENT = 'import { isAbsolute, join } from "node:path";';
const WEB_FETCH_CACHE_REPLACEMENT = [
	"export function getFetchCacheDir(): string {",
	"  const configured = process.env.PIE_CACHE_DIR?.trim();",
	"  const baseDir = configured && isAbsolute(configured)",
	"    ? configured",
	"    : getWebSearchConfigDir();",
	"  return join(baseDir, FETCH_CACHE_DIR);",
	"}",
].join("\n");

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

/**
 * Route only pi-mcp-adapter's two Pie-owned state caches into the canonical
 * cache category. Other getAgentPath callers (config, auth, onboarding, and
 * server state) retain the agent directory owner.
 */
export function patchMcpCachePathInSource(content: string): string {
	return content.replace(MCP_AGENT_PATH_RE, MCP_AGENT_PATH_REPLACEMENT);
}

/**
 * Route pi-web-access's fetched-content cache into the canonical cache
 * category. Configuration and credentials continue to use the package's
 * existing config directory.
 */
export function patchWebFetchCachePathInSource(content: string): string {
	if (!WEB_FETCH_CACHE_IMPORT_RE.test(content) || !WEB_FETCH_CACHE_RE.test(content)) return content;
	return content
		.replace(WEB_FETCH_CACHE_IMPORT_RE, WEB_FETCH_CACHE_IMPORT_REPLACEMENT)
		.replace(WEB_FETCH_CACHE_RE, WEB_FETCH_CACHE_REPLACEMENT);
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

async function packageVersion(root: string, expectedName: string): Promise<string | null> {
	try {
		const parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
			name?: unknown;
			version?: unknown;
		};
		if (parsed.name !== expectedName || typeof parsed.version !== "string") return null;
		return parsed.version;
	} catch (err) {
		log(`could not read ${expectedName} package identity: ${describeErr(err)} — cache relocation skipped`);
		return null;
	}
}

export type ManagedPackageReadinessStatus =
	| "ready"
	| "missing"
	| "malformed-manifest"
	| "wrong-version"
	| "missing-source"
	| "unresolved-cache"
	| "unsupported-source";

export interface ManagedPackageReadiness {
	name: string;
	expectedVersion: string;
	root: string;
	status: ManagedPackageReadinessStatus;
	sourceFingerprint: "pristine" | "supported-patched" | "unsupported" | "unavailable";
	cacheTargets: readonly string[];
	detail: string;
	remediation: string;
}

function packageRequirement(packageName: string) {
	return MANAGED_PACKAGE_REQUIREMENTS.find((entry) => entry.name === packageName);
}

/**
 * Inspect one exact managed package without searching or touching global npm
 * locations. The result is suitable for doctor output and future activation
 * gates; it accepts both the pristine pinned source and this guard's exact
 * idempotent patch output.
 */
export async function inspectManagedPackageReadiness(
	root: string,
	packageName: string,
	cacheDir: string | undefined = process.env.PIE_CACHE_DIR,
): Promise<ManagedPackageReadiness> {
	const requirement = packageRequirement(packageName);
	if (!requirement) throw new Error(`Unsupported managed package: ${packageName}`);
	const remediation = `Install the managed package with: pi install ${requirement.source}`;
	const cacheTargets = resolveManagedCacheTargets(packageName, cacheDir) ?? [];
	const base = {
		name: requirement.name,
		expectedVersion: requirement.version,
		root,
		cacheTargets,
		remediation,
	};
	const manifestPath = path.join(root, "package.json");
	if (!(await pathExists(manifestPath))) {
		return { ...base, status: "missing", sourceFingerprint: "unavailable", detail: `Managed package manifest is missing: ${manifestPath}` };
	}
	let manifest: { name?: unknown; version?: unknown };
	try {
		manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { name?: unknown; version?: unknown };
	} catch {
		return { ...base, status: "malformed-manifest", sourceFingerprint: "unavailable", detail: `Managed package manifest is not valid JSON: ${manifestPath}` };
	}
	if (manifest.name !== requirement.name || typeof manifest.version !== "string") {
		return { ...base, status: "malformed-manifest", sourceFingerprint: "unavailable", detail: `Managed package manifest is malformed or names ${String(manifest.name)}.` };
	}
	if (manifest.version !== requirement.version) {
		return { ...base, status: "wrong-version", sourceFingerprint: "unavailable", detail: `Managed package version ${manifest.version} is unsupported; expected ${requirement.version}.` };
	}
	for (const relative of requirement.requiredFiles) {
		const candidates = managedRequiredFileCandidates(root, relative);
		if (!(await Promise.all(candidates.map((candidate) => pathExists(candidate)))).some(Boolean)) {
			return { ...base, status: "missing-source", sourceFingerprint: "unavailable", detail: `Required managed package file is missing: ${relative}` };
		}
	}
	if (cacheTargets.length !== requirement.cacheTargets.length) {
		return { ...base, status: "unresolved-cache", sourceFingerprint: "unavailable", detail: "PIE_CACHE_DIR is unset or is not an absolute path; the canonical cache target cannot be verified." };
	}

	let fingerprint: ManagedPackageReadiness["sourceFingerprint"] = "pristine";
	try {
		if (requirement.name === WEB_ACCESS_PACKAGE_NAME) {
			const index = await readFile(path.join(root, "index.ts"), "utf8");
			const storage = await readFile(path.join(root, "storage.ts"), "utf8");
			fingerprint = classifyManagedPackageSources(requirement.name, { index, storage });
		} else {
			const agentDir = await readFile(path.join(root, "agent-dir.ts"), "utf8");
			fingerprint = classifyManagedPackageSources(requirement.name, { agentDir });
		}
	} catch {
		fingerprint = "unavailable";
	}
	if (fingerprint === "unsupported" || fingerprint === "unavailable") {
		return { ...base, status: "unsupported-source", sourceFingerprint: fingerprint, detail: `Pinned ${requirement.name} source fingerprint is unsupported or unreadable.` };
	}
	return { ...base, status: "ready", sourceFingerprint: fingerprint, detail: `Managed ${requirement.name}@${requirement.version} source is ${fingerprint}; cache target: ${cacheTargets.join(", ")}.` };
}

async function patchPinnedCacheFile(
	root: string,
	fileName: string,
	transform: (content: string) => string,
	label: string,
): Promise<number> {
	const target = path.join(root, fileName);
	try {
		const content = await readFile(target, "utf8");
		if (transform(content) === content && !content.includes("PIE_CACHE_DIR")) {
			log(`unsupported ${label} source fingerprint in ${target} — cache relocation skipped`);
		}
	} catch (err) {
		log(`could not read ${target}: ${describeErr(err)} — ${label} skipped`);
		return 0;
	}
	return patchFilesWith(root, transform, label);
}

/**
 * Apply the version/fingerprint-checked MCP adapter cache seam. The ordinary
 * npm cache used for `_npx` package resolution is intentionally untouched.
 */
export async function patchMcpCacheFiles(root: string): Promise<number> {
	const version = await packageVersion(root, MCP_ADAPTER_PACKAGE_NAME);
	if (version !== MCP_ADAPTER_VERSION) {
		if (version !== null) {
			log(`unsupported ${MCP_ADAPTER_PACKAGE_NAME} version ${version}; expected ${MCP_ADAPTER_VERSION} — MCP cache relocation skipped`);
		}
		return 0;
	}
	return patchPinnedCacheFile(root, "agent-dir.ts", patchMcpCachePathInSource, "mcp-cache-relocation");
}

/** Apply the version/fingerprint-checked web fetched-content cache seam. */
export async function patchWebFetchCacheFiles(root: string): Promise<number> {
	const version = await packageVersion(root, WEB_ACCESS_PACKAGE_NAME);
	if (version !== WEB_ACCESS_VERSION) {
		if (version !== null) {
			log(`unsupported ${WEB_ACCESS_PACKAGE_NAME} version ${version}; expected ${WEB_ACCESS_VERSION} — web fetch cache relocation skipped`);
		}
		return 0;
	}
	return patchPinnedCacheFile(root, "storage.ts", patchWebFetchCachePathInSource, "web-fetch-cache-relocation");
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

/** Repair npm replacement artifacts in the package and its exact hoisted
 * managed-prefix dependency root, never in an ancestor/global installation. */
async function repairManagedDeleteArtifacts(root: string): Promise<number> {
	const managedNodeModules = path.dirname(root);
	if (path.basename(root) !== "pi-web-access"
		|| path.basename(managedNodeModules) !== "node_modules"
		|| path.basename(path.dirname(managedNodeModules)) !== "npm") {
		return repairDeleteArtifacts(root);
	}
	const readabilityRoot = path.join(managedNodeModules, "@mozilla", "readability");
	const packageRestored = await repairDeleteArtifacts(root);
	const dependencyRestored = await repairDeleteArtifacts(readabilityRoot);
	return packageRestored + dependencyRestored;
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
		await repairManagedDeleteArtifacts(root);
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
function expandedAgentDir(deps: PackageRootLookupDeps): string {
	const configured = deps.getAgentDir();
	if (configured === "~") return deps.getHomeDir();
	if (/^[~][\\/]/.test(configured)) return path.join(deps.getHomeDir(), configured.slice(2));
	return configured;
}

/** Resolve the same canonical cache root used by the Pi backend client. */
function canonicalGuardCacheDir(agentDir: string): string | undefined {
	try {
		return resolvePieDataPaths({ agentDir, environment: process.env }).cacheDir;
	} catch (err) {
		log(`canonical Pie cache root is unresolved: ${describeErr(err)}`);
		return undefined;
	}
}
/** Locate a package in Pi's active managed npm install only. */
async function resolveManagedPackageRoot(
	packageName: string,
	deps: PackageRootLookupDeps,
): Promise<string | null> {
	const managed = managedPackageRoot(expandedAgentDir(deps), packageName);
	return (await deps.pathExists(path.join(managed, "package.json"))) ? managed : null;
}

/**
 * Locate the active managed `pi-web-access` install. Modern Pi installs user
 * npm packages exclusively under `<agentDir>/npm/node_modules`; stale global
 * package fallbacks are deliberately ignored because Pi will not load them
 * when the managed package exists.
 */
export async function resolvePackageRoot(
	deps: PackageRootLookupDeps = PRODUCTION_LOOKUP_DEPS,
): Promise<string | null> {
	return resolveManagedPackageRoot(WEB_ACCESS_PACKAGE_NAME, deps);
}

/** Locate the active managed `pi-mcp-adapter` install. */
export async function resolveMcpAdapterRoot(
	deps: PackageRootLookupDeps = PRODUCTION_LOOKUP_DEPS,
): Promise<string | null> {
	return resolveManagedPackageRoot(MCP_ADAPTER_PACKAGE_NAME, deps);
}

/** Inspect both required packages below the active managed agent directory. */
export async function inspectManagedPackages(
	deps: PackageRootLookupDeps = PRODUCTION_LOOKUP_DEPS,
): Promise<ManagedPackageReadiness[]> {
	const agentDir = expandedAgentDir(deps);
	// PIE_CACHE_DIR is injected by the VS Code backend, but direct `pi` loads
	// the extension without that injection. Derive both cases from the one
	// canonical data-root authority; never guess a global or package-local path.
	const cacheDir = canonicalGuardCacheDir(agentDir);
	if (cacheDir) process.env.PIE_CACHE_DIR = cacheDir;
	return Promise.all(MANAGED_PACKAGE_REQUIREMENTS.map((requirement) =>
		inspectManagedPackageReadiness(managedPackageRoot(agentDir, requirement.name), requirement.name, cacheDir)));
}

/**
 * Self-heal entry point. `resolveRoot` is injectable for testing (sync or
 * async); in production it resolves the managed install via
 * `resolvePackageRoot`. Never throws — any failure is logged with an
 * actionable hint and swallowed so extension loading continues.
 */
export async function runManagedPackageSelfHeal(
	resolveRoot: () => string | null | Promise<string | null> = resolvePackageRoot,
	resolveMcpRoot: () => string | null | Promise<string | null> = resolveMcpAdapterRoot,
	inspect: () => Promise<ManagedPackageReadiness[]> = inspectManagedPackages,
	logger: (message: string) => void = log,
): Promise<void> {
	const readiness = await inspect();
	const root = await resolveRoot();
	const web = readiness.find((result) => result.name === WEB_ACCESS_PACKAGE_NAME);
	let webReady = web;
	if (webReady?.status === "missing-source" && root && !(await readabilityIntact(root))) {
		await repairManagedDeleteArtifacts(root);
		webReady = (await inspect()).find((result) => result.name === WEB_ACCESS_PACKAGE_NAME);
	}
	for (const result of readiness) {
		const current = result.name === WEB_ACCESS_PACKAGE_NAME ? webReady : result;
		if (current && current.status !== "ready") {
			logger(`${current.detail} Intended cache target: ${current.cacheTargets.join(", ")}. ${current.remediation}`);
		}
	}
	if (webReady?.status === "ready" && root) {
		await applyWebAccessGuard(root);
		await patchWebFetchCacheFiles(root);
	}
	const mcpRoot = await resolveMcpRoot();
	const mcp = readiness.find((result) => result.name === MCP_ADAPTER_PACKAGE_NAME);
	if (mcp?.status === "ready" && mcpRoot) await patchMcpCacheFiles(mcpRoot);
}

export async function runSelfHeal(
	resolveRoot: () => string | null | Promise<string | null> = resolvePackageRoot,
	resolveMcpRoot: () => string | null | Promise<string | null> = resolveMcpAdapterRoot,
): Promise<void> {
	try {
		// Injectable web-only tests must retain their direct patch behavior.
		// Production first reports the exact managed readiness state; a global
		// package is never considered a fallback or patched by this guard.
		if (resolveRoot === resolvePackageRoot) {
			await runManagedPackageSelfHeal(resolveRoot, resolveMcpRoot);
		} else {
			const root = await resolveRoot();
			if (!root) return;
			await applyWebAccessGuard(root);
			await patchWebFetchCacheFiles(root);
		}
	} catch (err) {
		log(`self-heal failed: ${describeErr(err)} — web tools may be unavailable; reinstall pi-web-access if its tools are missing`);
	}
}

/** pi extension factory — runs the self-heal at load time, before pi-web-access loads. */
export default async function (_pi: ExtensionAPI): Promise<void> {
	await runSelfHeal();
}
