import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import lockfile from "proper-lockfile";
import {
	AuthStorage,
	type AuthStorageBackend,
	FileAuthStorageBackend,
	InMemoryAuthStorageBackend,
} from "../src/core/auth-storage.ts";

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture(t: TestContext) {
	const dir = mkdtempSync(join(tmpdir(), "pi-auth-async-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "auth.json");
	writeFileSync(path, "{}");
	return { path, read: () => JSON.parse(readFileSync(path, "utf8")) };
}

const key = (value: string) => ({ type: "api_key" as const, key: value });

function delayNextCompletion(backend: InMemoryAuthStorageBackend) {
	const entered = gate();
	const release = gate();
	const realAsync = backend.withLockAsync.bind(backend);
	let pause = true;
	backend.withLockAsync = async (fn, options) => {
		const result = await realAsync(fn, options);
		if (pause) {
			pause = false;
			entered.resolve();
			await release.promise;
		}
		return result;
	};
	return { entered, release };
}

test("async factories, reload and CRUD never use synchronous locking", async (t) => {
	const backend = new InMemoryAuthStorageBackend();
	t.mock.method(backend, "withLock", () => {
		throw new Error("sync lock forbidden");
	});
	const storage = await AuthStorage.fromStorageAsync(backend);
	assert.deepEqual(storage.drainErrors(), []);
	await storage.setAsync("first", key("first"));
	await storage.reloadAsync();
	assert.deepEqual(storage.list(), ["first"]);
	await storage.removeAsync("first");
	assert.deepEqual(storage.list(), []);

	const { path } = fixture(t);
	t.mock.method(lockfile, "lockSync", () => {
		throw new Error("sync file lock forbidden");
	});
	const file = await AuthStorage.createAsync(path);
	await file.setAsync("file", key("file"));
	await file.reloadAsync();
	await file.removeAsync("file");
	assert.deepEqual(file.drainErrors(), []);
});

test("two file instances merge only their provider into fresh locked contents", async (t) => {
	const { path, read } = fixture(t);
	const [first, second] = await Promise.all([AuthStorage.createAsync(path), AuthStorage.createAsync(path)]);
	await Promise.all([first.setAsync("first", key("first")), second.setAsync("second", key("second"))]);
	assert.deepEqual(read(), { first: key("first"), second: key("second") });
	writeFileSync(path, JSON.stringify({ ...read(), external: key("external") }));
	await first.removeAsync("first");
	assert.deepEqual(read(), { second: key("second"), external: key("external") });
	await second.reloadAsync();
	assert.deepEqual(second.getAll(), read());
	if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("waiting for a live file lock yields to timers and then persists", async (t) => {
	const { path, read } = fixture(t);
	const storage = await AuthStorage.createAsync(path);
	const release = await lockfile.lock(path);
	let released = false;
	t.after(async () => {
		if (!released) await release();
	});
	const pending = storage.setAsync("waiting", key("waiting"));
	await delay(25);
	assert.deepEqual(read(), {});
	await release();
	released = true;
	await pending;
	assert.deepEqual(read(), { waiting: key("waiting") });
});

for (const backendKind of ["file", "memory"] as const) {
	test(`${backendKind} backend rejects cancellation before acquisition and after awaited callback`, async (t) => {
		const backend =
			backendKind === "file" ? new FileAuthStorageBackend(fixture(t).path) : new InMemoryAuthStorageBackend();
		const controller = new AbortController();
		const reason = new Error("cancel write");
		controller.abort(reason);
		let called = false;
		await assert.rejects(
			backend.withLockAsync(
				async () => {
					called = true;
					return { result: undefined, next: "bad" };
				},
				{ signal: controller.signal },
			),
			(error) => error === reason,
		);
		assert.equal(called, false);

		const late = new AbortController();
		await assert.rejects(
			backend.withLockAsync(
				async () => {
					// The callback completes successfully. Abort in the microtask between
					// its return and the backend's canonical write, not inside the callback.
					queueMicrotask(() => late.abort(reason));
					return { result: undefined, next: "bad" };
				},
				{ signal: late.signal },
			),
			(error) => error === reason,
		);
		assert.notEqual(
			backend.withLock((current) => ({ result: current })),
			"bad",
		);
	});
}

test("cancel while waiting for the file lock prevents callback and late CRUD writes", async (t) => {
	const { path, read } = fixture(t);
	const storage = await AuthStorage.createAsync(path);
	await storage.setAsync("saved", key("original"));
	const release = await lockfile.lock(path);
	const controller = new AbortController();
	const pending = storage.removeAsync("saved", { signal: controller.signal });
	const rejected = assert.rejects(pending, { name: "AbortError" });
	controller.abort();
	await release();
	await rejected;
	assert.deepEqual(read(), { saved: key("original") });
	assert.deepEqual(storage.get("saved"), key("original"));
});

test("CRUD forwards the cancellation signal to the backend write checkpoint", async () => {
	const backend = new InMemoryAuthStorageBackend();
	const storage = await AuthStorage.fromStorageAsync(backend);
	const realAsync = backend.withLockAsync.bind(backend);
	const controller = new AbortController();
	backend.withLockAsync = (fn, options) =>
		realAsync(async (current) => {
			assert.equal(options?.signal, controller.signal);
			const result = await fn(current);
			queueMicrotask(() => controller.abort());
			return result;
		}, options);
	await assert.rejects(storage.setAsync("late", key("late"), { signal: controller.signal }), { name: "AbortError" });
	assert.equal(storage.has("late"), false);
	assert.deepEqual(
		backend.withLock((current) => ({ result: current })),
		undefined,
	);
});

test("in-memory async transactions serialize and conflicting sync access fails explicitly", async () => {
	const backend = new InMemoryAuthStorageBackend();
	const entered = gate();
	const release = gate();
	const first = backend.withLockAsync(async () => {
		entered.resolve();
		await release.promise;
		return { result: undefined, next: "first" };
	});
	await entered.promise;
	let secondEntered = false;
	const second = backend.withLockAsync(async (current) => {
		secondEntered = true;
		assert.equal(current, "first");
		return { result: undefined, next: "second" };
	});
	assert.throws(() => backend.withLock(() => ({ result: undefined })), /synchronously during an async transaction/);
	assert.equal(secondEntered, false);
	release.resolve();
	await Promise.all([first, second]);
	assert.equal(
		backend.withLock((current) => ({ result: current })),
		"second",
	);
});

test("in-memory failed and cancelled transactions release the queue without writing", async () => {
	const backend = new InMemoryAuthStorageBackend();
	const entered = gate();
	const release = gate();
	const failed = backend.withLockAsync(async () => {
		entered.resolve();
		await release.promise;
		throw new Error("failed callback");
	});
	const failure = assert.rejects(failed, /failed callback/);
	await entered.promise;
	const controller = new AbortController();
	let called = false;
	const cancelled = backend.withLockAsync(
		async () => {
			called = true;
			return { result: undefined, next: "bad" };
		},
		{ signal: controller.signal },
	);
	const cancellation = assert.rejects(cancelled, { name: "AbortError" });
	controller.abort();
	release.resolve();
	await Promise.all([failure, cancellation]);
	assert.equal(called, false);
	await backend.withLockAsync(async (current) => {
		assert.equal(current, undefined);
		return { result: undefined, next: "recovered" };
	});
	assert.equal(
		backend.withLock((current) => ({ result: current })),
		"recovered",
	);
});

test("malformed reload retains cached data, blocks writes, records errors and recovers", async (t) => {
	const { path, read } = fixture(t);
	const storage = await AuthStorage.createAsync(path);
	await storage.setAsync("kept", key("kept"));
	writeFileSync(path, "{malformed");
	await storage.reloadAsync();
	assert.deepEqual(storage.get("kept"), key("kept"));
	await assert.rejects(
		storage.setAsync("bad", key("bad")),
		/Cannot update auth storage because it could not be loaded/,
	);
	await assert.rejects(storage.removeAsync("kept"), /Cannot update auth storage because it could not be loaded/);
	assert.equal(readFileSync(path, "utf8"), "{malformed");
	assert.ok(storage.drainErrors().length >= 3);
	assert.deepEqual(storage.drainErrors(), []);
	writeFileSync(path, JSON.stringify({ external: key("external") }));
	await storage.setAsync("recovered", key("recovered"));
	assert.deepEqual(read(), { external: key("external"), recovered: key("recovered") });
});

test("a newly malformed canonical file is never overwritten by async CRUD", async (t) => {
	const { path } = fixture(t);
	const storage = await AuthStorage.createAsync(path);
	writeFileSync(path, "{malformed");
	await assert.rejects(storage.setAsync("bad", key("bad")), SyntaxError);
	assert.equal(readFileSync(path, "utf8"), "{malformed");
	assert.equal(storage.has("bad"), false);
});

test("finite async acquisition failures are buffered on load and rejected on persistence", async (t) => {
	const { path, read } = fixture(t);
	const failure = new Error("lock unavailable");
	t.mock.method(lockfile, "lock", async (...[_path, options]: Parameters<typeof lockfile.lock>) => {
		assert.ok(options);
		assert.ok(typeof options.retries === "object");
		assert.ok(!Array.isArray(options.retries));
		assert.equal(options.retries.retries, 10);
		assert.equal(options.retries.maxTimeout, 10000);
		assert.equal(options.stale, 30000);
		throw failure;
	});
	const storage = await AuthStorage.createAsync(path);
	assert.deepEqual(storage.drainErrors(), [failure]);
	await assert.rejects(
		storage.setAsync("bad", key("bad")),
		/Cannot update auth storage because it could not be loaded/,
	);
	assert.deepEqual(read(), {});
});

test("compromised lock after callback completion prevents canonical write", async (t) => {
	const { path, read } = fixture(t);
	const realLock = lockfile.lock.bind(lockfile);
	let compromise!: () => void;
	t.mock.method(lockfile, "lock", async (...[file, options]: Parameters<typeof lockfile.lock>) => {
		assert.ok(options);
		assert.ok(options.onCompromised);
		const onCompromised = options.onCompromised;
		compromise = () => onCompromised(new Error("compromised"));
		return realLock(file, options);
	});
	const backend = new FileAuthStorageBackend(path);
	await assert.rejects(
		backend.withLockAsync(async () => {
			queueMicrotask(compromise);
			return { result: undefined, next: "bad" };
		}),
		/compromised/,
	);
	assert.deepEqual(read(), {});
});

test("two expired file instances reuse one rotating refresh and preserve unrelated credentials", async (t) => {
	const { path, read } = fixture(t);
	const providerId = "test-auth-async-rotation";
	const entered = gate();
	const release = gate();
	let refreshes = 0;
	registerOAuthProvider({
		id: providerId,
		name: "Synthetic rotation",
		async login() {
			throw new Error("not used");
		},
		async refreshToken(credentials) {
			refreshes++;
			entered.resolve();
			await release.promise;
			return { ...credentials, refresh: "rotated-refresh", access: "rotated-access", expires: Date.now() + 60000 };
		},
		getApiKey: (credentials) => credentials.access,
	});
	t.after(() => unregisterOAuthProvider(providerId));
	t.after(release.resolve);
	writeFileSync(
		path,
		JSON.stringify({
			[providerId]: { type: "oauth", refresh: "old-refresh", access: "expired", expires: 1 },
			kept: key("kept"),
		}),
	);
	const [first, second] = await Promise.all([AuthStorage.createAsync(path), AuthStorage.createAsync(path)]);
	const a = first.getApiKey(providerId);
	await entered.promise;
	const b = second.getApiKey(providerId);
	await delay(25);
	assert.equal(refreshes, 1);
	release.resolve();
	assert.deepEqual(await Promise.all([a, b]), ["rotated-access", "rotated-access"]);
	assert.equal(refreshes, 1);
	assert.equal(read()[providerId].refresh, "rotated-refresh");
	assert.deepEqual(read().kept, key("kept"));
});

test("refresh failure recovery reloads asynchronously without losing a peer rotation", async (t) => {
	const providerId = "test-auth-async-recovery";
	registerOAuthProvider({
		id: providerId,
		name: "Synthetic recovery",
		async login() {
			throw new Error("not used");
		},
		async refreshToken() {
			throw new Error("refresh failed");
		},
		getApiKey: (credentials) => credentials.access,
	});
	t.after(() => unregisterOAuthProvider(providerId));
	const backend = new InMemoryAuthStorageBackend();
	backend.withLock(() => ({
		result: undefined,
		next: JSON.stringify({ [providerId]: { type: "oauth", refresh: "old", access: "old", expires: 1 } }),
	}));
	const storage = await AuthStorage.fromStorageAsync(backend);
	const realAsync = backend.withLockAsync.bind(backend);
	let fail = true;
	backend.withLockAsync = async (fn, options) => {
		if (fail) {
			fail = false;
			await realAsync(async () => ({
				result: undefined,
				next: JSON.stringify({
					[providerId]: { type: "oauth", refresh: "rotated", access: "peer", expires: Date.now() + 60000 },
				}),
			}));
			throw new Error("refresh acquisition failed");
		}
		return realAsync(fn, options);
	};
	t.mock.method(backend, "withLock", () => {
		throw new Error("sync recovery forbidden");
	});
	assert.equal(await storage.getApiKey(providerId), "peer");
	assert.equal(storage.drainErrors().length, 1);
});

test("login awaits async persistence and forwards the callback cancellation signal", async (t) => {
	const providerId = "test-auth-async-login";
	const controller = new AbortController();
	registerOAuthProvider({
		id: providerId,
		name: "Synthetic login",
		async login() {
			controller.abort();
			return { refresh: "refresh", access: "access", expires: Date.now() + 60000 };
		},
		async refreshToken(credentials) {
			return credentials;
		},
		getApiKey: (credentials) => credentials.access,
	});
	t.after(() => unregisterOAuthProvider(providerId));
	const backend: AuthStorageBackend = new InMemoryAuthStorageBackend();
	const storage = await AuthStorage.fromStorageAsync(backend);
	const callbacks: OAuthLoginCallbacks = {
		onAuth() {
			throw new Error("Unexpected authorization callback");
		},
		onDeviceCode() {
			throw new Error("Unexpected device-code callback");
		},
		async onPrompt() {
			throw new Error("Unexpected prompt callback");
		},
		async onSelect() {
			throw new Error("Unexpected selector callback");
		},
		signal: controller.signal,
	};
	await assert.rejects(storage.login(providerId, callbacks), { name: "AbortError" });
	assert.equal(storage.has(providerId), false);
});

test("sync reload conflict cannot consume an in-flight memory commit's publication ticket", async () => {
	const storage = AuthStorage.inMemory();
	const pending = storage.setAsync("saved", key("committed"));
	await Promise.resolve();
	storage.reload();
	await pending;
	assert.deepEqual(storage.getAll(), { saved: key("committed") });
	assert.match(storage.drainErrors()[0]?.message ?? "", /synchronously during an async transaction/);
	storage.reload();
	assert.deepEqual(storage.getAll(), { saved: key("committed") });
	assert.deepEqual(storage.drainErrors(), []);
});

for (const mutationAlreadyObserved of [false, true]) {
	test(
		`delayed acquisition failure cannot poison a ${mutationAlreadyObserved ? "previously pending" : "subsequent"} confirmed observation`,
		{ timeout: 15000 },
		async (t) => {
			const backend = new InMemoryAuthStorageBackend();
			const storage = await AuthStorage.fromStorageAsync(backend);
			const paused = mutationAlreadyObserved ? delayNextCompletion(backend) : undefined;
			const mutation = paused ? storage.setAsync("saved", key("committed")) : undefined;
			if (paused) {
				t.after(paused.release.resolve);
				await paused.entered.promise;
			}
			const realAsync = backend.withLockAsync.bind(backend);
			const failedAcquisition = gate();
			t.after(failedAcquisition.resolve);
			let failNext = true;
			backend.withLockAsync = async (fn, options) => {
				if (failNext) {
					failNext = false;
					await failedAcquisition.promise;
					throw new Error("acquisition failed before callback");
				}
				return realAsync(fn, options);
			};
			const olderReload = storage.reloadAsync();
			if (paused) {
				paused.release.resolve();
				await mutation;
			} else {
				await storage.setAsync("saved", key("committed"));
			}
			failedAcquisition.resolve();
			await olderReload;
			assert.deepEqual(storage.getAll(), { saved: key("committed") });
			assert.deepEqual(
				storage.drainErrors().map((error) => error.message),
				["acquisition failed before callback"],
			);
			const syncLock = t.mock.method(backend, "withLock");
			storage.set("next", key("next"));
			assert.equal(syncLock.mock.callCount(), 1, "A stale acquisition error must not force a recovery reload");
		},
	);
}

test("a failed locked read still fences an older pending snapshot", { timeout: 15000 }, async (t) => {
	const backend = new InMemoryAuthStorageBackend();
	const storage = await AuthStorage.fromStorageAsync(backend);
	await storage.setAsync("saved", key("original"));
	const { entered, release } = delayNextCompletion(backend);
	t.after(release.resolve);
	const olderMutation = storage.setAsync("saved", key("older"));
	await entered.promise;
	backend.withLock(() => ({ result: undefined, next: "{malformed" }));
	await storage.reloadAsync();
	release.resolve();
	await olderMutation;
	assert.deepEqual(storage.getAll(), { saved: key("original") });
	assert.equal(storage.drainErrors()[0]?.name, "SyntaxError");
	assert.equal(
		backend.withLock((current) => ({ result: current })),
		"{malformed",
	);
	backend.withLock(() => ({ result: undefined, next: JSON.stringify({ recovered: key("newer") }) }));
	await storage.reloadAsync();
	assert.deepEqual(storage.getAll(), { recovered: key("newer") });
	assert.deepEqual(storage.drainErrors(), []);
});

for (const failure of [false, true]) {
	test(
		`rotated refresh snapshot is published only after backend confirmation (${failure ? "failed" : "successful"} write)`,
		{ timeout: 15000 },
		async (t) => {
			const providerId = `test-auth-async-confirmation-${failure}`;
			const expired = { type: "oauth" as const, refresh: "old-refresh", access: "expired", expires: 1 };
			const rotated = {
				...expired,
				refresh: "rotated-refresh",
				access: "rotated-access",
				expires: Date.now() + 60000,
			};
			registerOAuthProvider({
				id: providerId,
				name: "Synthetic confirmed rotation",
				async login() {
					throw new Error("not used");
				},
				async refreshToken() {
					return rotated;
				},
				getApiKey: (credentials) => credentials.access,
			});
			t.after(() => unregisterOAuthProvider(providerId));
			const backend = new InMemoryAuthStorageBackend();
			backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [providerId]: expired }) }));
			const storage = await AuthStorage.fromStorageAsync(backend);
			const realAsync = backend.withLockAsync.bind(backend);
			const entered = gate();
			const release = gate();
			t.after(release.resolve);
			let recovery = false;
			backend.withLockAsync = (fn, options) => {
				if (recovery) return Promise.reject(new Error("recovery reload failed"));
				return realAsync(async (current) => {
					const result = await fn(current);
					assert.notEqual(result.next, undefined);
					entered.resolve();
					await release.promise;
					if (failure) {
						recovery = true;
						throw new Error("canonical write failed");
					}
					return result;
				}, options);
			};
			const resolving = storage.getApiKey(providerId);
			await entered.promise;
			assert.deepEqual(storage.get(providerId), expired, "Callback completion must not expose an uncommitted token");
			release.resolve();
			assert.equal(await resolving, failure ? undefined : rotated.access);
			assert.deepEqual(storage.get(providerId), failure ? expired : rotated);
			assert.deepEqual(
				JSON.parse(backend.withLock((current) => ({ result: current! })))[providerId],
				failure ? expired : rotated,
			);
			if (failure) {
				assert.deepEqual(
					storage.drainErrors().map((error) => error.message),
					["canonical write failed", "recovery reload failed"],
				);
				backend.withLockAsync = realAsync;
				await storage.reloadAsync();
				assert.equal(await storage.getApiKey(providerId), rotated.access);
				assert.deepEqual(storage.get(providerId), rotated);
			}
		},
	);
}

for (const operation of ["reload", "set", "remove"] as const) {
	test(
		`older async ${operation} completion cannot replace a newer synchronous snapshot`,
		{ timeout: 15000 },
		async (t) => {
			const backend = new InMemoryAuthStorageBackend();
			const storage = await AuthStorage.fromStorageAsync(backend);
			await storage.setAsync("saved", key("original"));
			const { entered, release } = delayNextCompletion(backend);
			t.after(release.resolve);
			const older =
				operation === "reload"
					? storage.reloadAsync()
					: operation === "set"
						? storage.setAsync("saved", key("older"))
						: storage.removeAsync("saved");
			await entered.promise;
			if (operation === "set") storage.remove("saved");
			else storage.set("saved", key("newer"));
			const newest = storage.getAll();
			release.resolve();
			await older;
			assert.deepEqual(storage.getAll(), newest);
			assert.deepEqual(JSON.parse(backend.withLock((current) => ({ result: current! }))), newest);
		},
	);
}

for (const asynchronous of [false, true]) {
	test(
		`older async mutation completion cannot replace a newer ${asynchronous ? "async" : "sync"} reload`,
		{ timeout: 15000 },
		async (t) => {
			const backend = new InMemoryAuthStorageBackend();
			const storage = await AuthStorage.fromStorageAsync(backend);
			const { entered, release } = delayNextCompletion(backend);
			t.after(release.resolve);
			const older = storage.setAsync("saved", key("older"));
			await entered.promise;
			backend.withLock(() => ({ result: undefined, next: JSON.stringify({ external: key("newer") }) }));
			if (asynchronous) await storage.reloadAsync();
			else storage.reload();
			release.resolve();
			await older;
			assert.deepEqual(storage.getAll(), { external: key("newer") });
		},
	);
}

test("snapshot ordering follows actual lock acquisition, not API invocation order", { timeout: 15000 }, async (t) => {
	const backend = new InMemoryAuthStorageBackend();
	const storage = await AuthStorage.fromStorageAsync(backend);
	const realAsync = backend.withLockAsync.bind(backend);
	const entered = gate();
	const release = gate();
	t.after(release.resolve);
	let delayFirstAcquisition = true;
	backend.withLockAsync = async (fn, options) => {
		if (delayFirstAcquisition) {
			delayFirstAcquisition = false;
			entered.resolve();
			await release.promise;
		}
		return realAsync(fn, options);
	};
	const invokedFirst = storage.setAsync("first", key("first"));
	await entered.promise;
	await storage.setAsync("second", key("second"));
	assert.deepEqual(storage.getAll(), { second: key("second") });
	release.resolve();
	await invokedFirst;
	assert.deepEqual(storage.getAll(), { first: key("first"), second: key("second") });
	assert.deepEqual(JSON.parse(backend.withLock((current) => ({ result: current! }))), storage.getAll());
});

test("confirmed refresh completion cannot resurrect a later removed credential", { timeout: 15000 }, async (t) => {
	const providerId = "test-auth-async-refresh-order";
	registerOAuthProvider({
		id: providerId,
		name: "Synthetic ordered rotation",
		async login() {
			throw new Error("not used");
		},
		async refreshToken(credentials) {
			return { ...credentials, access: "rotated", refresh: "rotated-refresh", expires: Date.now() + 60000 };
		},
		getApiKey: (credentials) => credentials.access,
	});
	t.after(() => unregisterOAuthProvider(providerId));
	const backend = new InMemoryAuthStorageBackend();
	backend.withLock(() => ({
		result: undefined,
		next: JSON.stringify({ [providerId]: { type: "oauth", access: "expired", refresh: "refresh", expires: 1 } }),
	}));
	const storage = await AuthStorage.fromStorageAsync(backend);
	const { entered, release } = delayNextCompletion(backend);
	t.after(release.resolve);
	const resolving = storage.getApiKey(providerId);
	await entered.promise;
	storage.remove(providerId);
	release.resolve();
	assert.equal(
		await resolving,
		"rotated",
		"A confirmed refresh result is not discarded merely because publication was superseded",
	);
	assert.equal(storage.has(providerId), false);
	assert.deepEqual(JSON.parse(backend.withLock((current) => ({ result: current! }))), {});
});
