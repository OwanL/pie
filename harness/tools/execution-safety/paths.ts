import * as path from "node:path";

export function normalizeSlashes(value: string): string {
	return value.replace(/\\/g, "/");
}

export function collapseLeadingSlashes(value: string): string {
	return value.startsWith("//./") ? value : value.replace(/^\/\/+/, "/");
}

export function isWindowsLikePath(value: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("//./");
}

export function normalizePath(p: string): string {
	const withSlashes = collapseLeadingSlashes(normalizeSlashes(p.trim()));
	const normalized = isWindowsLikePath(withSlashes)
		? path.win32.normalize(withSlashes).replace(/\\/g, "/")
		: path.posix.normalize(withSlashes || ".");
	return collapseLeadingSlashes(normalized).toLowerCase();
}

export function resolvePathForComparison(targetPath: string, cwd: string): string {
	const rawTarget = collapseLeadingSlashes(normalizeSlashes(targetPath.trim()));
	const rawCwd = collapseLeadingSlashes(normalizeSlashes(cwd.trim()));
	if (!rawTarget) {
		return normalizePath(rawCwd || "/");
	}
	if (isWindowsLikePath(rawTarget)) {
		const base = isWindowsLikePath(rawCwd) ? rawCwd : process.cwd();
		return normalizePath(path.win32.resolve(base, rawTarget));
	}
	if (rawTarget.startsWith("~")) {
		return normalizePath(rawTarget);
	}
	if (rawTarget.startsWith("/")) {
		// Absolute POSIX path — keep as-is regardless of cwd platform.
		return normalizePath(rawTarget);
	}
	// Relative target. Resolve against the cwd using the cwd's native platform
	// so that a Windows cwd (`D:/proj`) with a relative target (`dist`) resolves
	// to `D:/proj/dist` instead of being mangled by posix.resolve (which treats
	// `D:/proj` as a relative path and re-prepends process.cwd()).
	const base = rawCwd || process.cwd().replace(/\\/g, "/");
	if (isWindowsLikePath(base)) {
		return normalizePath(path.win32.resolve(base, rawTarget));
	}
	return normalizePath(path.posix.resolve(base, rawTarget));
}

export function trimTrailingPathSeparatorForComparison(p: string): string {
	if (p === "/" || /^[a-z]:\/$/i.test(p)) return p;
	return p.replace(/\/+$/g, "");
}

export function isUnderCwd(targetPath: string, cwd: string): boolean {
	const norm = trimTrailingPathSeparatorForComparison(resolvePathForComparison(targetPath, cwd));
	const cwdNorm = trimTrailingPathSeparatorForComparison(resolvePathForComparison(cwd, cwd));
	return norm === cwdNorm || norm.startsWith(`${cwdNorm}/`);
}
