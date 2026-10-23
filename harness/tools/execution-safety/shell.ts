import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { win32 as win32Path } from "node:path";
import {
	collapseLeadingSlashes,
	isUnderCwd,
	isWindowsLikePath,
	normalizeSlashes,
	resolvePathForComparison,
	trimTrailingPathSeparatorForComparison,
} from "./paths";

export interface ShellInvocation {
	name: string;
	args: string[];
	/** Reconstructed command text with quoting removed. Use for narrow argument checks only. */
	text: string;
	/** Unquoted shell operator following this invocation, when present. */
	operatorAfter?: "|" | "&&" | "||" | ";" | "&" | "newline";
	/** Leading shell '!' inverts exit status, not the command's effects. */
	negated?: boolean;
}

/**
 * Removes heredoc bodies before analysis. The body is data, not shell syntax, and
 * scanning it was the largest source of false positives when agents generated
 * scripts, docs, or test fixtures containing dangerous-looking examples.
 */
export function stripHeredocBodies(command: string): string {
	const lines = command.split("\n");
	const kept: string[] = [];
	let delimiter: string | undefined;
	let stripTabs = false;

	for (const line of lines) {
		if (delimiter !== undefined) {
			const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
			if (candidate.trimEnd() === delimiter) {
				delimiter = undefined;
				stripTabs = false;
				kept.push("");
			}
			continue;
		}

		kept.push(line);
		const match = line.match(/<<(-)?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/);
		if (match) {
			stripTabs = Boolean(match[1]);
			delimiter = match[3];
		}
	}
	return kept.join("\n");
}

/** Returns shell syntax with quoted/comment data blanked while preserving
 * character positions. Useful for narrow syntax checks such as redirections. */
export function maskShellData(command: string): string {
	const source = stripHeredocBodies(command);
	let result = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let atTokenStart = true;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		if (escaped) {
			result += quote ? " " : char;
			escaped = false;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') escaped = true;
			result += " ";
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			result += " ";
			continue;
		}
		if (char === "#" && atTokenStart) {
			while (index < source.length && source[index] !== "\n") {
				result += " ";
				index += 1;
			}
			result += "\n";
			atTokenStart = true;
			continue;
		}
		result += char;
		atTokenStart = /\s/.test(char);
	}
	return result;
}

/** Lightweight shell lexer. It is deliberately conservative: only unquoted
 * shell operators create command boundaries, and quoted arguments remain data.
 * This is not an execution parser; it exists to avoid matching words in grep
 * patterns, echo text, comments, and inline file content as executable commands.
 */
export function parseShellInvocations(command: string): ShellInvocation[] {
	const source = stripHeredocBodies(command);
	const invocations: ShellInvocation[] = [];
	let tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let atTokenStart = true;
	let awaitingRedirectionTarget = false;
	let discardingRedirectionTarget = false;

	const pushToken = () => {
		if (token.length > 0) tokens.push(token);
		token = "";
		atTokenStart = true;
	};
	const pushInvocation = () => {
		pushToken();
		let start = 0;
		while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[start] ?? "")) start += 1;
		let negated = false;
		while (tokens[start] === "!") { negated = !negated; start += 1; }
		if (tokens[start] === "command") start += 1;
		if (tokens[start] === "env") {
			start += 1;
			while (start < tokens.length && (/^-/.test(tokens[start] ?? "") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[start] ?? ""))) start += 1;
		}
		const executable = tokens[start];
		if (executable) {
			const normalizedName = executable.replace(/^.*[\\/]/, "").toLowerCase();
			const args = tokens.slice(start + 1);
			invocations.push({ name: normalizedName, args, text: [normalizedName, ...args].join(" "), ...(negated ? { negated } : {}) });
		}
		tokens = [];
	};

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
		// POSIX removes an unquoted/double-quoted backslash-newline pair
		// before tokenization, even in the middle of a command name.
		if (char === "\\" && source[index + 1] === "\n" && quote !== "'" && !escaped) {
			index += 1;
			continue;
		}

		if (awaitingRedirectionTarget) {
			if (/\s/.test(char) && char !== "\n") continue;
			awaitingRedirectionTarget = false;
			if (!/[;|&\n]/.test(char)) discardingRedirectionTarget = true;
		}
		if (discardingRedirectionTarget) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (quote) {
				if (char === quote) quote = undefined;
				else if (char === "\\" && quote === '"') escaped = true;
				continue;
			}
			if (char === "'" || char === '"') {
				quote = char;
				continue;
			}
			if (char === "\\") {
				const next = source[index + 1] ?? "";
				if (/\s|[\\'";|&#]/.test(next)) escaped = true;
				continue;
			}
			if (!/\s|[;|&<>]/.test(char)) continue;
			discardingRedirectionTarget = false;
		}
		if (escaped) {
			token += char;
			escaped = false;
			atTokenStart = false;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && quote === '"') escaped = true;
			else token += char;
			atTokenStart = false;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			atTokenStart = false;
			continue;
		}
		if (char === "\\") {
			// Preserve Windows path separators. In POSIX shell a backslash only
			// needs lexical handling here when it escapes whitespace/metacharacters.
			const next = source[index + 1] ?? "";
			if (/\s|[\\'";|&#]/.test(next)) escaped = true;
			else token += char;
			atTokenStart = false;
			continue;
		}
		if (char === "&" && source[index + 1] === ">") {
			pushToken();
			index += 1;
			while (source[index + 1] === ">") index += 1;
			awaitingRedirectionTarget = true;
			continue;
		}
		if (char === ">" || char === "<") {
			if (/^\d+$/.test(token)) {
				token = "";
				atTokenStart = true;
			} else {
				pushToken();
			}
			while (source[index + 1] === ">" || source[index + 1] === "<") index += 1;
			if (source[index + 1] === "&" || source[index + 1] === "|") index += 1;
			awaitingRedirectionTarget = true;
			continue;
		}
		if (char === "#" && atTokenStart) {
			while (index < source.length && source[index] !== "\n") index += 1;
			pushInvocation();
			continue;
		}
		if (/\s/.test(char)) {
			pushToken();
			if (char === "\n") {
				pushInvocation();
				const previous = invocations.at(-1);
				if (previous && previous.operatorAfter === undefined) previous.operatorAfter = "newline";
			}
			continue;
		}
		if (char === ";" || char === "|" || char === "&") {
			pushInvocation();
			const doubled = source[index + 1] === char;
			const operator = (doubled ? `${char}${char}` : char) as ShellInvocation["operatorAfter"];
			const previous = invocations.at(-1);
			if (previous) previous.operatorAfter = operator;
			if (doubled) index += 1;
			continue;
		}
		token += char;
		atTokenStart = false;
	}
	pushInvocation();
	return invocations;
}

function isRecursiveForceRmToken(token: string): { recursive: boolean; force: boolean } {
	if (!token.startsWith("-")) return { recursive: false, force: false };
	const lower = token.toLowerCase();
	if (lower === "--recursive") return { recursive: true, force: false };
	if (lower === "--force") return { recursive: false, force: true };
	if (lower.startsWith("--")) return { recursive: false, force: false };
	return { recursive: lower.includes("r"), force: lower.includes("f") };
}

function isRootDeleteTarget(target: string): boolean {
	const trimmed = collapseLeadingSlashes(normalizeSlashes(target.trim())).toLowerCase();
	return trimmed === "/" || trimmed === "/*" || trimmed === "~" || trimmed === "~/" || /^[a-z]:\/$/.test(trimmed);
}

/**
 * Temp cleanup is a routine development operation, even though the OS temp
 * directory normally lives outside the project. Only exempt a concrete child:
 * deleting the temp root itself, a wildcard spanning it, an unevaluated brace
 * expansion (the lexer does not evaluate `{a,b}`, so a literal like
 * `/c/dev/scratch/{keep,../data}` passes the prefix check while bash expands
 * it into `/c/dev/data`), or a path that normalizes back out of it must still
 * prompt.
 *
 * `/tmp` and `/var/tmp` are included explicitly because Windows-hosted Git Bash
 * exposes those virtual paths while Node reports a native `%TEMP%` path.
 * `C:/dev/scratch` is the machine-designated disposable tree in
 * `C:/dev/AGENTS.md`; keep both its native and Git Bash spellings literal and
 * child-only rather than introducing a configurable exemption.
 */
const MACHINE_DISPOSABLE_SCRATCH_ROOTS = ["C:/dev/scratch", "/c/dev/scratch"] as const;

function canonicalizeExistingWindowsPathPrefix(target: string, cwd: string): string | undefined {
	if (process.platform !== "win32") return undefined;
	let existingPrefix = trimTrailingPathSeparatorForComparison(resolvePathForComparison(target, cwd));
	if (!/^[a-z]:\//i.test(existingPrefix)) return undefined;
	const missingSegments: string[] = [];

	while (true) {
		try {
			const canonicalPrefix = realpathSync.native(existingPrefix);
			const canonicalTarget = missingSegments.length > 0
				? win32Path.join(canonicalPrefix, ...missingSegments)
				: canonicalPrefix;
			return trimTrailingPathSeparatorForComparison(resolvePathForComparison(canonicalTarget, cwd));
		} catch {
			const parent = win32Path.dirname(existingPrefix);
			if (parent === existingPrefix) return undefined;
			missingSegments.unshift(win32Path.basename(existingPrefix));
			existingPrefix = parent;
		}
	}
}

function isTemporaryDirectoryChild(target: string, cwd: string): boolean {
	// Unevaluated glob and brace syntax is rejected conservatively: the lexer
	// cannot know what bash would expand `*`, `?`, `[...]`, or `{a,b}` into, so
	// any target containing it must still prompt.
	if (/[*?[\]{}]/.test(target)) return false;
	const normalizedTarget = trimTrailingPathSeparatorForComparison(resolvePathForComparison(target, cwd));
	const canonicalTarget = canonicalizeExistingWindowsPathPrefix(target, cwd);
	const normalizedTargets = canonicalTarget ? [normalizedTarget, canonicalTarget] : [normalizedTarget];
	const platformTempRoot = tmpdir();
	let canonicalPlatformTempRoot: string | undefined;
	try {
		// Windows may expose the same temp directory through an 8.3 path in
		// TEMP/TMP while tools emit its long path (or vice versa).
		canonicalPlatformTempRoot = realpathSync.native(platformTempRoot);
	} catch {
		// The lexical platform root remains useful if canonicalization fails.
	}
	const tempRoots = [
		"/tmp",
		"/var/tmp",
		platformTempRoot,
		canonicalPlatformTempRoot,
		...MACHINE_DISPOSABLE_SCRATCH_ROOTS,
	].filter((root): root is string => typeof root === "string");
	return tempRoots.some((root) => {
		const normalizedRoot = trimTrailingPathSeparatorForComparison(resolvePathForComparison(root, cwd));
		return normalizedTargets.some((candidate) => candidate.startsWith(`${normalizedRoot}/`));
	});
}

/** Undefined means a directory change could not be resolved statically. */
export interface ShellInvocationWithCwd extends ShellInvocation {
	cwds: (string | undefined)[];
}

export function resolveShellTarget(target: string, cwd: string | undefined): string | undefined {
	if (cwd !== undefined || target.startsWith("/") || isWindowsLikePath(target)) {
		return resolvePathForComparison(target, cwd ?? "/");
	}
	return undefined;
}

/** Track possible directories without executing commands. Failed cd branches
 * remain possible after ';', but only its success branch reaches '&&'. This
 * intentionally models simple command lists, not a complete shell grammar. */
export function shellInvocationsWithCwd(invocations: ShellInvocation[], initialCwds: (string | undefined)[]): ShellInvocationWithCwd[] {
	const merge = (...groups: (string | undefined)[][]): (string | undefined)[] => {
		const values = [...new Set(groups.flat())];
		return values.length > 32 ? [undefined] : values;
	};
	let success = initialCwds;
	let failure = initialCwds;
	let previousOperator: ShellInvocation["operatorAfter"];
	let listStartCwds = initialCwds;
	return invocations.map((invocation) => {
		const cwds = previousOperator === "&&" ? success : previousOperator === "||" ? failure : merge(success, failure);
		if (previousOperator === undefined || [";", "newline", "&"].includes(previousOperator)) listStartCwds = cwds;
		const skippedSuccess = previousOperator === "||" ? success : [];
		const skippedFailure = previousOperator === "&&" ? failure : [];
		let changed = cwds;
		const inChild = previousOperator === "|" || invocation.operatorAfter === "|" || invocation.operatorAfter === "&";
		if (!inChild && ["cd", "pushd", "popd"].includes(invocation.name)) {
			const args = invocation.args.filter((arg, index) => !(index === 0 && ["--", "-P", "-L"].includes(arg)));
			const target = args.length === 1 ? args[0] : undefined;
			changed = invocation.name === "cd" && target && !/[$`~*?\[\]{}]/.test(target) && target !== "-"
				? merge(cwds.map((dir) => resolveShellTarget(target, dir)))
				: [undefined];
		}
		success = merge(invocation.negated ? cwds : changed, skippedSuccess);
		failure = merge(invocation.negated ? changed : cwds, skippedFailure);
		// '&' backgrounds the entire preceding and/or list, not just its
		// final command. Its directory changes never reach the parent shell.
		if (invocation.operatorAfter === "&") success = failure = listStartCwds;
		previousOperator = invocation.operatorAfter;
		return { ...invocation, cwds };
	});
}

export function analyzeRecursiveRm(command: string, cwd: string, invocations = shellInvocationsWithCwd(parseShellInvocations(command), [cwd])): { action: "allow" | "block" | "prompt"; reason?: string } | null {
	let foundRecursiveForceRm = false;
	let prompted: { action: "prompt"; reason: string } | undefined;
	for (const invocation of invocations) {
		if (invocation.name !== "rm") continue;
		let recursive = false;
		let force = false;
		const targets: string[] = [];
		let parsingFlags = true;
		for (const token of invocation.args) {
			if (parsingFlags && token === "--") {
				parsingFlags = false;
				continue;
			}
			if (parsingFlags && token.startsWith("-")) {
				const flags = isRecursiveForceRmToken(token);
				recursive ||= flags.recursive;
				force ||= flags.force;
				continue;
			}
			parsingFlags = false;
			targets.push(token);
		}
		if (!recursive || !force || targets.length === 0) continue;
		foundRecursiveForceRm = true;
		for (const target of targets) {
			const resolvedTargets = invocation.cwds.map((dir) => resolveShellTarget(target, dir));
			if (isRootDeleteTarget(target) || resolvedTargets.some((resolved) => resolved !== undefined && isRootDeleteTarget(resolved))) {
				return { action: "block", reason: "Recursive force-delete on root (/)" };
			}
			if (resolvedTargets.some((resolved) => resolved === undefined || (!isUnderCwd(resolved, cwd) && !isTemporaryDirectoryChild(resolved, cwd)))) {
				// Remember the prompt but keep scanning every rm invocation and
				// target: a later root-delete hard block must dominate this
				// earlier prompt (a confirmable prompt must never launder a
				// catastrophic delete).
				prompted ??= { action: "prompt", reason: "Recursive force-delete outside project directory" };
			}
		}
	}
	if (prompted) return prompted;
	return foundRecursiveForceRm ? { action: "allow" } : null;
}
