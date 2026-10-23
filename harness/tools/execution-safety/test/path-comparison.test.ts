import assert from "node:assert/strict";
import test from "node:test";
import { isUnderCwd, normalizePath, resolvePathForComparison } from "../paths";

function onPlatform(platform: NodeJS.Platform, run: () => void): void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { value: platform });
	try {
		run();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

test("Windows Git Bash drive aliases compare equally in targets and cwd", () => {
	onPlatform("win32", () => {
		assert.equal(normalizePath("/c/Windows/System32"), "c:/windows/system32");
		assert.equal(resolvePathForComparison("/C/Windows/../Windows/System32", "D:/repo"), "c:/windows/system32");
		assert.equal(resolvePathForComparison("build", "/c/repo"), "c:/repo/build");
		assert.equal(resolvePathForComparison("", "/c/repo"), "c:/repo");
		assert.equal(isUnderCwd("/c/repo/build", "C:/repo"), true);
		assert.equal(isUnderCwd("C:/repo/build", "/c/repo"), true);
		assert.equal(isUnderCwd("/c/repository", "C:/repo"), false);
		assert.equal(isUnderCwd("/c/repo/../outside", "C:/repo"), false);
		assert.equal(isUnderCwd("/d/repo/build", "C:/repo"), false);
		assert.equal(normalizePath("/tmp/file"), "/tmp/file");
		assert.equal(resolvePathForComparison("/tmp/file", "C:/repo"), "/tmp/file");
	});
});

test("non-Windows POSIX drive-like directories stay POSIX", () => {
	onPlatform("linux", () => {
		assert.equal(normalizePath("/c/repo"), "/c/repo");
		assert.equal(resolvePathForComparison("build", "/c/repo"), "/c/repo/build");
		assert.equal(isUnderCwd("/c/repo/build", "C:/repo"), false);
	});
});

test("filesystem roots contain children without requiring a doubled separator", () => {
	onPlatform("win32", () => {
		assert.equal(isUnderCwd("C:/repo", "C:/"), true);
		assert.equal(isUnderCwd("/c/repo", "/c/"), true);
		assert.equal(isUnderCwd("D:/repo", "C:/"), false);
	});
	onPlatform("linux", () => {
		assert.equal(isUnderCwd("/repo", "/"), true);
		assert.equal(isUnderCwd("/", "/"), true);
	});
});
