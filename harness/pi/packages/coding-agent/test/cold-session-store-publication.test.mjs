import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test, vi } from "vitest";
import {
	ColdSessionStore,
	StaleColdSessionLeaseError,
} from "../../../../session-storage/lifecycle/cold-session-store.ts";
import { SessionManager } from "../src/core/session-manager.ts";

// The fixture needs only SessionManager, not the SDK's application-facing methods.
/** @type {{ SessionManager: typeof SessionManager }} */
const sdk = { SessionManager };

vi.mock("@earendil-works/pi-agent-core", () => ({ uuidv7: () => randomUUID() }));

/**
 * @param {string} sessionPath
 * @returns {{ ready: Promise<void>, release: () => void, close: () => Promise<void> }}
 */
function holdWindowsDestination(sessionPath) {
	const script = `
$ErrorActionPreference = 'Stop'
$stream = [IO.File]::Open($env:PIE_LOCK_FIXTURE_PATH, 'Open', 'Read', 'ReadWrite')
try {
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  $null = [Console]::In.ReadLine()
} finally { $stream.Dispose() }
`;
	const child = spawn(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, PIE_LOCK_FIXTURE_PATH: sessionPath },
		},
	);
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	child.stdin.on("error", () => {
		/* Exit status below diagnoses a failed child. */
	});
	/** @type {Promise<number | null>} */
	const exited = new Promise((resolve) => {
		child.once("close", (code) => resolve(code));
	});
	/** @type {Promise<void>} */
	const ready = new Promise((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error(`Lock child did not become ready: ${stderr}`)), 5000);
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			if (stdout.includes("READY")) {
				clearTimeout(deadline);
				resolve();
			}
		});
		child.once("error", (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		void exited.then((code) => {
			clearTimeout(deadline);
			reject(new Error(`Lock child exited before READY (${code}): ${stderr}`));
		});
	});
	return {
		ready,
		release: () => {
			if (!child.stdin.writableEnded) child.stdin.end("release\n");
		},
		async close() {
			if (!child.stdin.writableEnded) child.stdin.end("release\n");
			let killed = false;
			const deadline = setTimeout(() => {
				killed = true;
				child.kill();
			}, 3000);
			try {
				const code = await exited;
				assert.equal(killed, false, "lock child needed forced termination");
				assert.equal(code, 0, stderr);
			} finally {
				clearTimeout(deadline);
			}
		},
	};
}

for (const revoke of [undefined, "ownership", "fingerprint"]) {
	test(`cold prepared publication yields to a timer and fences ${revoke ?? "recovery"}`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-cold-publication-"));
		let admissions = 0;
		const store = new ColdSessionStore({
			sdk,
			coordinatorGeneration: 1,
			startupCwd: root,
			agentDir: root,
			sessionDir: root,
			writerAdmission: {
				assertAdmitted: () => {
					assert.equal(admissions, 1);
				},
				acquire: () => {
					admissions++;
					return () => {
						admissions--;
					};
				},
			},
		});
		const handle = store.create();
		const sessionPath = handle.sessionPath;
		const before = fs.readFileSync(sessionPath, "utf8");
		const openOptions = {
			modelSettings: { defaultModel: "old", defaultProvider: "fixture", defaultThinkingLevel: "medium" },
		};
		await store.openSnapshot(sessionPath, openOptions);
		assert.equal(store.getBrowseCacheStats().entries, 1);
		let staged = 0;
		const manager = handle.manager;
		const prepare = manager.preparePieModelSettingsChange.bind(manager);
		manager.preparePieModelSettingsChange = (...args) => {
			staged++;
			return prepare(...args);
		};
		const rename = fs.renameSync;
		let denied = true;
		let attempts = 0;
		fs.renameSync = (source, target) => {
			if (String(target) === sessionPath) {
				attempts++;
				if (denied) throw Object.assign(new Error("sharing violation"), { code: "EPERM", syscall: "rename" });
			}
			return rename(source, target);
		};
		syncBuiltinESMExports();
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		try {
			const pending = store.setHandleModelSettings(handle, {
				model: { provider: "fixture", modelId: "model" },
				thinkingLevel: "high",
			});
			assert.equal(attempts, 1, "first commit runs synchronously");
			assert.equal(admissions, 1);
			assert.equal(staged, 1);
			assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 1);
			timer = setTimeout(() => {
				assert.equal(admissions, 1, "admission covers backoff");
				denied = false;
				if (revoke === "ownership") store.leases.invalidate(sessionPath);
				if (revoke === "fingerprint") fs.appendFileSync(sessionPath, "\n");
			}, 1);
			if (revoke) {
				await assert.rejects(
					pending,
					(error) =>
						error instanceof StaleColdSessionLeaseError &&
						error.reason === (revoke === "ownership" ? "ownership-revision" : "fingerprint"),
				);
				assert.equal(attempts, 1, "revocation stops before another rename");
				assert.equal(fs.readFileSync(sessionPath, "utf8"), before + (revoke === "fingerprint" ? "\n" : ""));
				assert.equal(manager.getEntries().length, 0);
				assert.equal(store.getBrowseCacheStats().entries, 1, "failed publication preserves cached bytes");
			} else {
				assert.deepEqual(await pending, { modelChanged: true, thinkingLevelChanged: true });
				assert.equal(attempts, 2);
				assert.equal(manager.getEntries().length, 2);
				assert.equal(store.getBrowseCacheStats().entries, 0, "publication retires old cached state");
				const snapshot = await store.openHandleSnapshot(handle, openOptions);
				assert.equal(snapshot.session.modelId, "model");
				assert.equal(snapshot.session.thinkingLevel, "high");
				assert.equal(
					store.handoff(handle, (retained) => retained),
					manager,
					"exact retained manager remains promotable",
				);
			}
			assert.equal(staged, 1);
			assert.equal(admissions, 0);
			assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
		} finally {
			clearTimeout(timer);
			fs.renameSync = rename;
			syncBuiltinESMExports();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

test("a committed settings write retires old browse state even when restamping fails", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-cold-postcommit-"));
	const store = new ColdSessionStore({ sdk, coordinatorGeneration: 1, startupCwd: root, agentDir: root, sessionDir: root });
	try {
		const handle = store.create();
		await store.openSnapshot(handle.sessionPath, { modelSettings: { defaultModel: "old", defaultProvider: "fixture", defaultThinkingLevel: "medium" } });
		assert.equal(store.getBrowseCacheStats().entries, 1);
		store.leases.restamp = () => { throw Object.assign(new Error("postcommit stat failed"), { code: "EACCES", syscall: "stat" }); };
		await assert.rejects(store.setHandleModelSettings(handle, { model: { provider: "fixture", modelId: "model" }, thinkingLevel: "high" }), /postcommit stat failed/);
		assert.equal(handle.manager.getEntries().length, 2, "the pair remains committed");
		assert.equal(store.getBrowseCacheStats().entries, 0, "obsolete browse data cannot survive publication");
		assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

for (const revoke of [false, true]) {
	test(`cold truncate retries a single staged rewrite with ownership fence (revoke=${revoke})`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-cold-truncate-"));
		const manager = SessionManager.create(root, root);
		const sessionPath = manager.getSessionFile();
		// A committed v3 transcript with a target row and settings to restore.
		fs.appendFileSync(
			sessionPath,
			`${[
				{
					type: "message",
					id: "target",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "edit", timestamp: Date.now() },
				},
				{
					type: "model_change",
					id: "model",
					parentId: "target",
					timestamp: new Date().toISOString(),
					provider: "fixture",
					modelId: "restore",
				},
				{
					type: "thinking_level_change",
					id: "thinking",
					parentId: "model",
					timestamp: new Date().toISOString(),
					thinkingLevel: "high",
				},
			]
				.map((row) => JSON.stringify(row))
				.join("\n")}\n`,
		);
		const before = fs.readFileSync(sessionPath, "utf8");
		let writes = 0,
			attempts = 0,
			commits = 0;
		const store = new ColdSessionStore({
			sdk,
			coordinatorGeneration: 1,
			startupCwd: root,
			agentDir: root,
			sessionDir: root,
			fileSystem: {
				writeFile: async (file, content) => {
					writes++;
					await fs.promises.writeFile(file, content);
				},
				renameSync: (source, target) => {
					attempts++;
					if (attempts === 1) {
						setTimeout(() => {
							if (revoke) store.leases.invalidate(sessionPath);
						}, 1);
						throw Object.assign(new Error("sharing violation"), { code: "EACCES", syscall: "rename" });
					}
					fs.renameSync(source, target);
				},
			},
		});
		try {
			const pending = store.truncateAfter(sessionPath, "target", {
				onCommit: () => {
					commits++;
				},
			});
			if (revoke) {
				await assert.rejects(
					pending,
					(error) => error instanceof StaleColdSessionLeaseError && error.reason === "ownership-revision",
				);
				assert.equal(fs.readFileSync(sessionPath, "utf8"), before);
				assert.equal(attempts, 1);
				assert.equal(commits, 0);
			} else {
				const result = await pending;
				assert.equal(attempts, 2);
				assert.equal(commits, 1);
				assert.equal(result.restoredModel, true);
				assert.equal(result.restoredThinkingLevel, true);
				const context = result.manager.buildSessionContext();
				assert.equal(context.model?.modelId, "restore");
				assert.equal(context.thinkingLevel, "high");
			}
			assert.equal(writes, 1);
			assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}

test.skipIf(process.platform !== "win32")(
	"real Windows lock starves synchronous retry but yields during cold publication",
	async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pie-cold-windows-lock-"));
		/** @type {ReturnType<typeof holdWindowsDestination> | undefined} */
		let lock;
		/** @type {ReturnType<typeof setTimeout> | undefined} */
		let timer;
		let admissions = 0;
		const store = new ColdSessionStore({
			sdk,
			coordinatorGeneration: 1,
			startupCwd: root,
			agentDir: root,
			sessionDir: root,
			writerAdmission: {
				assertAdmitted: () => {
					assert.equal(admissions, 1);
				},
				acquire: () => {
					admissions++;
					return () => {
						admissions--;
					};
				},
			},
		});
		const handle = store.create();
		const manager = handle.manager;
		const before = fs.readFileSync(handle.sessionPath, "utf8");
		const entriesBefore = manager.getEntries();
		const leafBefore = manager.getLeafId();
		const contextBefore = manager.buildSessionContext();
		let staged = 0;
		const prepare = manager.preparePieModelSettingsChange.bind(manager);
		manager.preparePieModelSettingsChange = (...args) => {
			staged++;
			return prepare(...args);
		};
		try {
			lock = holdWindowsDestination(handle.sessionPath);
			await lock.ready;
			let released = false;
			const baselineLock = lock;
			timer = setTimeout(() => {
				released = true;
				baselineLock.release();
			}, 100);
			const started = Date.now();
			assert.throws(
				() => manager.appendPieModelSettingsChange("fixture", "model", "high"),
				(error) => error instanceof Error && "code" in error && error.code === "EPERM",
			);
			assert.equal(released, false, "synchronous backoff starves the release timer");
			assert.ok(Date.now() - started >= 7000, "baseline exhausted the existing retry budget");
			assert.equal(fs.readFileSync(handle.sessionPath, "utf8"), before);
			assert.deepEqual(manager.getEntries(), entriesBefore);
			assert.equal(manager.getLeafId(), leafBefore);
			assert.deepEqual(manager.buildSessionContext(), contextBefore);
			assert.equal(staged, 1);
			assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
			clearTimeout(timer);
			await lock.close();
			lock = undefined;

			lock = holdWindowsDestination(handle.sessionPath);
			await lock.ready;
			staged = 0;
			released = false;
			const asyncLock = lock;
			timer = setTimeout(() => {
				released = true;
				asyncLock.release();
			}, 100);
			const pending = store.setHandleModelSettings(handle, {
				model: { provider: "fixture", modelId: "model" },
				thinkingLevel: "high",
			});
			assert.equal(admissions, 1);
			assert.equal(staged, 1);
			assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 1);
			assert.deepEqual(await pending, { modelChanged: true, thinkingLevelChanged: true });
			assert.equal(released, true, "async backoff permits the release timer to run");
			assert.equal(admissions, 0);
			assert.equal(staged, 1, "retries do not restage the pair");
			const entries = manager.getEntries();
			assert.deepEqual(
				entries.map((entry) => entry.type),
				["model_change", "thinking_level_change"],
			);
			assert.equal(entries[1].parentId, entries[0].id);
			const rows = fs
				.readFileSync(handle.sessionPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			assert.deepEqual(
				rows.map((row) => row.type),
				["session", "model_change", "thinking_level_change"],
			);
			assert.equal(manager.buildSessionContext().model?.modelId, "model");
			assert.equal(manager.buildSessionContext().thinkingLevel, "high");
			assert.equal(fs.readdirSync(root).filter((name) => name.endsWith(".tmp")).length, 0);
		} finally {
			clearTimeout(timer);
			// Never remove the fixture directory until our lock-owning child has exited.
			try {
				if (lock) await lock.close();
			} finally {
				fs.rmSync(root, { recursive: true, force: true });
			}
		}
	},
	30000,
);
