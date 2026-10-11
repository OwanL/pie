import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, test, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import type { SessionOwnershipAdapter } from "../src/core/session-ownership.ts";

// SessionManager only consumes uuidv7 at runtime; keep the agent/AI compiled
// package graph out of this source-unit test. No SessionManager code is mocked.
vi.mock("@earendil-works/pi-agent-core", () => ({ uuidv7: () => randomUUID() }));

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-prepared-settings-"));
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
	const manager = SessionManager.create(root, root);
	const sessionPath = manager.getSessionFile()!;
	return { root, manager, sessionPath, bytes: fs.readFileSync(sessionPath, "utf8") };
}

test("prepared settings stage once, retry one rename per commit, and never publish twice", () => {
	const { root, manager, sessionPath, bytes } = fixture();
	const prepared = manager.preparePieModelSettingsChange("fixture", "model", "high");
	const temporaryPath = path.join(root, fs.readdirSync(root).find((name) => name.endsWith(".tmp"))!);
	const stagedBytes = fs.readFileSync(temporaryPath, "utf8");
	assert.equal(fs.readFileSync(sessionPath, "utf8"), bytes);
	assert.deepEqual(manager.getEntries(), []);
	assert.equal(manager.getLeafId(), null);
	const rename = fs.renameSync;
	let attempts = 0;
	fs.renameSync = (() => {
		attempts++;
		throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
	}) as typeof fs.renameSync;
	syncBuiltinESMExports();
	try {
		assert.throws(() => prepared.commit(), { code: "EPERM" });
		assert.equal(attempts, 1);
	} finally {
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
	assert.equal(fs.readFileSync(temporaryPath, "utf8"), stagedBytes);
	assert.equal(fs.readFileSync(sessionPath, "utf8"), bytes);
	assert.deepEqual(manager.getEntries(), []);
	const result = prepared.commit();
	assert.ok(result.modelChangeId);
	assert.equal(manager.getLeafId(), result.thinkingLevelChangeId);
	assert.equal(fs.readFileSync(sessionPath, "utf8"), stagedBytes);
	assert.deepEqual(prepared.commit(), result);
	prepared.dispose();
	prepared.dispose();
	assert.equal(manager.getEntries().length, 2);
	assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
});

test("post-publication fsync and handle cleanup failures cannot undo a commit", () => {
	const { manager, sessionPath } = fixture();
	const prepared = manager.preparePieModelSettingsChange("fixture", "model", "high");
	const fsync = fs.fsyncSync;
	const close = fs.closeSync;
	fs.fsyncSync = () => {
		throw new Error("post-publication sync failed");
	};
	fs.closeSync = (fd) => {
		close(fd);
		throw new Error("post-publication cleanup failed");
	};
	syncBuiltinESMExports();
	try {
		const result = prepared.commit();
		assert.equal(manager.getLeafId(), result.thinkingLevelChangeId);
		assert.equal(manager.getEntries().length, 2);
		assert.deepEqual(prepared.commit(), result);
		prepared.dispose();
		assert.equal(fs.readFileSync(sessionPath, "utf8").trim().split("\n").length, 3);
	} finally {
		fs.fsyncSync = fsync;
		fs.closeSync = close;
		syncBuiltinESMExports();
	}
});

test("synchronous append retains its transient retry budget and error codes", () => {
	for (const code of ["EPERM", "EACCES", "EBUSY", "EIO"]) {
		const { root, manager, sessionPath, bytes } = fixture();
		const rename = fs.renameSync;
		const wait = Atomics.wait;
		const delays: number[] = [];
		let attempts = 0;
		fs.renameSync = (() => {
			attempts++;
			throw Object.assign(new Error("rename failed"), { code });
		}) as typeof fs.renameSync;
		Atomics.wait = ((_array, _index, _value, timeout) => {
			delays.push(timeout!);
			return "timed-out";
		}) as typeof Atomics.wait;
		syncBuiltinESMExports();
		try {
			assert.throws(() => manager.appendPieModelSettingsChange("fixture", "model", "high"), { code });
		} finally {
			fs.renameSync = rename;
			Atomics.wait = wait;
			syncBuiltinESMExports();
		}
		assert.equal(attempts, code === "EIO" ? 1 : 10);
		assert.deepEqual(delays, code === "EIO" ? [] : [10, 25, 50, 100, 250, 500, 1000, 2000, 4000]);
		assert.deepEqual(manager.getEntries(), []);
		assert.equal(fs.readFileSync(sessionPath, "utf8"), bytes);
		assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
	}
});

test("dispose removes an uncommitted image and prohibits commit", () => {
	const { root, manager, sessionPath, bytes } = fixture();
	const prepared = manager.preparePieModelSettingsChange(undefined, undefined, "high");
	prepared.dispose();
	prepared.dispose();
	assert.throws(() => prepared.commit(), /disposed/i);
	assert.equal(fs.readFileSync(sessionPath, "utf8"), bytes);
	assert.deepEqual(manager.getEntries(), []);
	assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
});

test("preparation and each commit retain admission; adapter postcommit unwind cannot undo publication", () => {
	const { root, manager, sessionPath, bytes } = fixture();
	const lease = {
		coordinatorGeneration: 1,
		workerId: "fixture",
		workerGeneration: 1,
		canonicalSessionPath: sessionPath,
		ownershipRevision: 1,
		nonce: "fixture",
	};
	let admitted = false;
	let denied = true;
	let unwindFailure = false;
	const releaseError = new Error("admission release failed");
	const seams: string[] = [];
	const adapter: SessionOwnershipAdapter = {
		assertWriteLease() {},
		runWriteMutation(_lease, _path, seam, _sessionId, mutation) {
			seams.push(seam);
			if (denied) throw new Error("admission denied");
			admitted = true;
			try {
				const result = mutation();
				if (unwindFailure) {
					if (seam === "preparePieModelSettingsChange") {
						assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 1);
					}
					throw releaseError;
				}
				return result;
			} finally {
				admitted = false;
			}
		},
		async reserveReplacement() {
			throw new Error("unused");
		},
		async abortPrecommit() {},
		async commitTransfer() {
			throw new Error("unused");
		},
		async consumeTransferAuthorization() {
			throw new Error("unused");
		},
		async runtimeReady() {},
		async failClosed(error: unknown): Promise<never> {
			throw error;
		},
	};
	manager.attachPieWriteLease(adapter, lease);
	assert.throws(() => manager.preparePieModelSettingsChange("fixture", "model", "high"), /admission denied/);
	assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
	const open = fs.openSync;
	const rename = fs.renameSync;
	let publications = 0;
	fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
		assert.equal(admitted, true, "staging and publication IO must retain admission");
		return open(...args);
	}) as typeof fs.openSync;
	fs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
		assert.equal(admitted, true);
		publications++;
		return rename(...args);
	}) as typeof fs.renameSync;
	syncBuiltinESMExports();
	try {
		denied = false;
		unwindFailure = true;
		assert.throws(
			() => manager.preparePieModelSettingsChange("fixture", "model", "high"),
			(error) => error === releaseError,
		);
		assert.equal(fs.readFileSync(sessionPath, "utf8"), bytes);
		assert.deepEqual(manager.getEntries(), []);
		assert.equal(manager.getLeafId(), null);
		assert.deepEqual(fs.readdirSync(root), [path.basename(sessionPath)]);
		unwindFailure = false;
		const prepared = manager.preparePieModelSettingsChange("fixture", "model", "high");
		denied = true;
		assert.throws(() => prepared.commit(), /admission denied/);
		assert.equal(fs.readFileSync(sessionPath, "utf8"), bytes);
		assert.deepEqual(manager.getEntries(), []);
		denied = false;
		unwindFailure = true;
		const result = prepared.commit();
		assert.equal(manager.getLeafId(), result.thinkingLevelChangeId);
		assert.equal(manager.getEntries().length, 2);
		assert.deepEqual(prepared.commit(), result);
		prepared.dispose();
		assert.equal(publications, 1);
		assert.deepEqual(seams, [
			"preparePieModelSettingsChange",
			"preparePieModelSettingsChange",
			"preparePieModelSettingsChange",
			"appendPieModelSettingsChange",
			"appendPieModelSettingsChange",
		]);
	} finally {
		fs.openSync = open;
		fs.renameSync = rename;
		syncBuiltinESMExports();
	}
});

test("prepared settings reject changed manager state, leaf, path and revoked lease", () => {
	for (const change of ["state", "leaf", "path", "lease"] as const) {
		const { manager, sessionPath } = fixture();
		manager.appendThinkingLevelChange("low");
		if (change === "lease") {
			const lease = {
				coordinatorGeneration: 1,
				workerId: "fixture",
				workerGeneration: 1,
				canonicalSessionPath: sessionPath,
				ownershipRevision: 1,
				nonce: "fixture",
			};
			manager.attachPieWriteLease(
				{
					assertWriteLease() {},
					async reserveReplacement() {
						throw new Error("unused");
					},
					async abortPrecommit() {},
					async commitTransfer() {
						throw new Error("unused");
					},
					async consumeTransferAuthorization() {
						throw new Error("unused");
					},
					async runtimeReady() {},
					async failClosed(error: unknown): Promise<never> {
						throw error;
					},
				},
				lease,
			);
		}
		const prepared = manager.preparePieModelSettingsChange("fixture", "model", "high");
		if (change === "state") manager.appendThinkingLevelChange("off");
		if (change === "leaf") manager.resetLeaf();
		if (change === "path") manager.newSession();
		if (change === "lease") manager.revokePieWriteLease();
		const bytes = fs.readFileSync(sessionPath, "utf8");
		const entries = manager.getEntries();
		assert.throws(() => prepared.commit(), { code: "STALE_SESSION_WRITE_LEASE" });
		assert.equal(fs.readFileSync(sessionPath, "utf8"), bytes);
		assert.deepEqual(manager.getEntries(), entries);
		prepared.dispose();
	}
});
