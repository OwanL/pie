/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	findEnvKeys,
	getEnvApiKey,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@earendil-works/pi-ai/compat";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { normalizePath } from "../utils/paths.ts";
import { resolveConfigValue } from "./resolve-config-value.ts";

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
	env?: Record<string, string>;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

export interface GetApiKeyOptions {
	includeFallback?: boolean;
}

type LockResult<T> = {
	result: T;
	next?: string;
};

const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;

export interface AuthStorageAsyncOptions {
	signal?: AbortSignal;
}

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	/**
	 * Exclude other transactions through callback completion and canonical write.
	 * Check signal before acquisition, after acquisition, and after awaiting fn,
	 * immediately before writing next (without an intervening await).
	 */
	withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options?: AuthStorageAsyncOptions,
	): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = normalizePath(authPath);
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options: AuthStorageAsyncOptions = {},
	): Promise<T> {
		options.signal?.throwIfAborted();
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			options.signal?.throwIfAborted();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			options.signal?.throwIfAborted();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;
	private asyncTail: Promise<void> = Promise.resolve();
	private pendingAsyncTransactions = 0;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		if (this.pendingAsyncTransactions > 0) {
			throw new Error("Cannot access auth storage synchronously during an async transaction");
		}
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(
		fn: (current: string | undefined) => Promise<LockResult<T>>,
		options: AuthStorageAsyncOptions = {},
	): Promise<T> {
		options.signal?.throwIfAborted();
		const previous = this.asyncTail;
		let release!: () => void;
		this.asyncTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.pendingAsyncTransactions++;
		try {
			await previous;
			options.signal?.throwIfAborted();
			const { result, next } = await fn(this.value);
			options.signal?.throwIfAborted();
			if (next !== undefined) {
				this.value = next;
			}
			return result;
		} finally {
			this.pendingAsyncTransactions--;
			release();
		}
	}
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;
	// Advance inside locked callbacks: invocation and backend return order can both differ from lock order.
	private observationVersion = 0;
	private appliedObservationVersion = 0;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
	}

	static create(authPath?: string): AuthStorage {
		return AuthStorage.fromStorage(new FileAuthStorageBackend(authPath));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		const authStorage = new AuthStorage(storage);
		authStorage.reload();
		return authStorage;
	}

	static async createAsync(authPath?: string): Promise<AuthStorage> {
		return AuthStorage.fromStorageAsync(new FileAuthStorageBackend(authPath));
	}

	static async fromStorageAsync(storage: AuthStorageBackend): Promise<AuthStorage> {
		const authStorage = new AuthStorage(storage);
		await authStorage.reloadAsync();
		return authStorage;
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/** Only publish confirmed backend results, ordered by locked observation rather than promise completion. */
	private publishSnapshot(data: AuthStorageData, version: number): void {
		if (version <= this.appliedObservationVersion) return;
		this.data = data;
		this.loadError = null;
		this.appliedObservationVersion = version;
	}

	private recordLoadError(error: unknown, version: number): void {
		if (version >= this.appliedObservationVersion) {
			this.loadError = error instanceof Error ? error : new Error(String(error));
			this.appliedObservationVersion = version;
		}
		this.recordError(error);
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		// Until the callback runs, a load failure must not claim an in-flight observation's ticket.
		let version = this.appliedObservationVersion;
		try {
			const data = this.storage.withLock((current) => {
				version = ++this.observationVersion;
				return { result: this.parseStorageData(current) };
			});
			this.publishSnapshot(data, version);
		} catch (error) {
			this.recordLoadError(error, version);
		}
	}

	/** Reload without synchronously waiting for a credential lock. Errors are buffered like reload(). */
	async reloadAsync(): Promise<void> {
		// Until the callback runs, a load failure must not claim an in-flight observation's ticket.
		let version = this.appliedObservationVersion;
		try {
			const data = await this.storage.withLockAsync(async (current) => {
				version = ++this.observationVersion;
				return { result: this.parseStorageData(current) };
			});
			this.publishSnapshot(data, version);
		} catch (error) {
			this.recordLoadError(error, version);
		}
	}

	private async persistProviderChangeAsync(
		provider: string,
		credential: AuthCredential | undefined,
		options: AuthStorageAsyncOptions,
	): Promise<void> {
		try {
			options.signal?.throwIfAborted();
			if (this.loadError) {
				await this.reloadAsync();
			}
			options.signal?.throwIfAborted();
			if (this.loadError) {
				throw new Error(`Cannot update auth storage because it could not be loaded: ${this.loadError.message}`);
			}

			let version = this.observationVersion;
			const persistedData = await this.storage.withLockAsync(async (current) => {
				version = ++this.observationVersion;
				const merged = { ...this.parseStorageData(current) };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: merged, next: JSON.stringify(merged, null, 2) };
			}, options);
			this.publishSnapshot(persistedData, version);
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			this.reload();
		}

		if (this.loadError) {
			const error = new Error(
				`Cannot update auth storage because it could not be loaded: ${this.loadError.message}`,
			);
			this.recordError(error);
			throw error;
		}

		try {
			let version = this.observationVersion;
			const persistedData = this.storage.withLock((current) => {
				version = ++this.observationVersion;
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: merged, next: JSON.stringify(merged, null, 2) };
			});
			this.publishSnapshot(persistedData, version);
		} catch (error) {
			this.recordError(error);
			throw error;
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Get provider-scoped environment values for an API key credential.
	 */
	getProviderEnv(provider: string): Record<string, string> | undefined {
		const cred = this.data[provider];
		return cred?.type === "api_key" && cred.env ? { ...cred.env } : undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		this.persistProviderChange(provider, undefined);
	}

	/** Persist one provider into fresh locked contents without synchronously waiting for the lock. */
	async setAsync(provider: string, credential: AuthCredential, options: AuthStorageAsyncOptions = {}): Promise<void> {
		await this.persistProviderChangeAsync(provider, credential, options);
	}

	/** Remove one provider from fresh locked contents. Cancellation before the write prevents persistence. */
	async removeAsync(provider: string, options: AuthStorageAsyncOptions = {}): Promise<void> {
		await this.persistProviderChangeAsync(provider, undefined, options);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.data[provider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		await this.setAsync(providerId, { type: "oauth", ...credentials }, { signal: callbacks.signal });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		let version = this.observationVersion;
		let snapshot: AuthStorageData = {};
		const result = await this.storage.withLockAsync(async (current) => {
			version = ++this.observationVersion;
			const currentData = this.parseStorageData(current);
			snapshot = currentData;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			snapshot = merged;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		this.publishSnapshot(snapshot, version);
		return result;
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 */
	async getApiKey(providerId: string, options: GetApiKeyOptions = {}): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return resolveConfigValue(cred.key, cred.env);
		}

		if (cred?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				// Unknown OAuth provider, can't get API key
				return undefined;
			}

			// Check if token needs refresh
			const needsRefresh = Date.now() >= cred.expires;

			if (needsRefresh) {
				// Use locked refresh to prevent race conditions
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return result.apiKey;
					}
				} catch (error) {
					this.recordError(error);
					// Refresh failed - re-read file to check if another instance succeeded
					await this.reloadAsync();
					const updatedCred = this.data[providerId];

					if (!this.loadError && updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
						// Another instance refreshed successfully, use those credentials
						return provider.getApiKey(updatedCred);
					}

					// Refresh truly failed - return undefined so model discovery skips this provider
					// User can /login to re-authenticate (credentials preserved for retry)
					return undefined;
				}
			} else {
				// Token not expired, use current access token
				return provider.getApiKey(cred);
			}
		}

		if (options.includeFallback === false) return undefined;

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		return undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}
}
