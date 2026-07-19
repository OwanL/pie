import { tmpdir } from "node:os";
import {
	collapseLeadingSlashes,
	isUnderCwd,
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

	const pushToken = () => {
		if (token.length > 0) tokens.push(token);
		token = "";
		atTokenStart = true;
	};
	const pushInvocation = () => {
		pushToken();
		let start = 0;
		while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[start] ?? "")) start += 1;
		if (tokens[start] === "command") start += 1;
		if (tokens[start] === "env") {
			start += 1;
			while (start < tokens.length && (/^-/.test(tokens[start] ?? "") || /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[start] ?? ""))) start += 1;
		}
		const executable = tokens[start];
		if (executable) {
			const normalizedName = executable.replace(/^.*[\\/]/, "").toLowerCase();
			const args = tokens.slice(start + 1);
			invocations.push({ name: normalizedName, args, text: [normalizedName, ...args].join(" ") });
		}
		tokens = [];
	};

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] ?? "";
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
 * deleting the temp root itself, a wildcard spanning it, or a path that
 * normalizes back out of it must still prompt.
 *
 * `/tmp` and `/var/tmp` are included explicitly because Windows-hosted Git Bash
 * exposes those virtual paths while Node reports a native `%TEMP%` path.
 */
function isTemporaryDirectoryChild(target: string, cwd: string): boolean {
	if (/[*?\[]/.test(target)) return false;
	const normalizedTarget = trimTrailingPathSeparatorForComparison(resolvePathForComparison(target, cwd));
	const tempRoots = ["/tmp", "/var/tmp", tmpdir()];
	return tempRoots.some((root) => {
		const normalizedRoot = trimTrailingPathSeparatorForComparison(resolvePathForComparison(root, cwd));
		return normalizedTarget.startsWith(`${normalizedRoot}/`);
	});
}

export function analyzeRecursiveRm(command: string, cwd: string): { action: "allow" | "block" | "prompt"; reason?: string } | null {
	for (const invocation of parseShellInvocations(command)) {
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
		for (const target of targets) {
			if (isRootDeleteTarget(target)) return { action: "block", reason: "Recursive force-delete on root (/)" };
			if (!isUnderCwd(target, cwd) && !isTemporaryDirectoryChild(target, cwd)) {
				return { action: "prompt", reason: "Recursive force-delete outside project directory" };
			}
		}
		return { action: "allow" };
	}
	return null;
}
