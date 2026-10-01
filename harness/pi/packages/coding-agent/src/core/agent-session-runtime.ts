import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager, type ContextMessageOmissionsResolver } from "./session-manager.ts";
import type {
	SessionOwnershipAdapter,
	SessionOwnershipReservation,
	SessionReplacementReason,
	SessionWriteLease,
} from "./session-ownership.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
	contextMessageOmissions?: ContextMessageOmissionsResolver;
}) => Promise<CreateAgentSessionRuntimeResult>;

/** Initial target and caller-owned policies for a shared session runtime. */
export interface CreateAgentSessionRuntimeOptions {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	contextMessageOmissions?: ContextMessageOmissionsResolver;
	ownershipAdapter?: SessionOwnershipAdapter;
	writeLease?: SessionWriteLease;
}

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function sameResolvedPath(left: string, right: string): boolean {
	const resolvedLeft = resolve(left);
	const resolvedRight = resolve(right);
	return process.platform === "win32"
		? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
		: resolvedLeft === resolvedRight;
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private readonly ownershipAdapter?: SessionOwnershipAdapter;
	private writeLease?: SessionWriteLease;
	private replacementTail: Promise<void> = Promise.resolve();
	private replacementSequence = 0;
	private ownershipFailedClosed = false;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
		ownershipAdapter?: SessionOwnershipAdapter,
		writeLease?: SessionWriteLease,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
		this.ownershipAdapter = ownershipAdapter;
		this.writeLease = writeLease;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		return { cancelled: result?.cancel === true };
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason,
			targetSessionFile,
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		if (this.rebindSession) {
			await this.rebindSession(this.session);
		}
		if (withSession) {
			await withSession(this.session.createReplacedSessionContext());
		}
	}

	private serializeReplacement<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.replacementTail.then(() => {
			if (this.ownershipFailedClosed) {
				throw new Error("Worker session ownership already failed closed.");
			}
			return operation();
		});
		this.replacementTail = run.then(() => undefined, () => undefined);
		return run;
	}

	private nextReplacementOperationId(reason: SessionReplacementReason): string {
		this.replacementSequence += 1;
		return `pie-replacement:${reason}:${this.replacementSequence}`;
	}

	private async quiesceSource(): Promise<void> {
		this.session.clearQueue();
		this.session.abortCompaction();
		this.session.abortBranchSummary();
		this.session.abortBash();
		this.session.abortRetry();
		await this.session.abort();
		await this.session.agent.waitForIdle();
		while (this.session.isCompacting || this.session.isRetrying || this.session.isBashRunning) {
			await new Promise<void>((resolveIdle) => setTimeout(resolveIdle, 0));
		}
	}

	private async abortReplacementReservation(
		reservation: SessionOwnershipReservation,
		error: unknown,
	): Promise<void> {
		try {
			await this.ownershipAdapter!.abortPrecommit(
				reservation,
				error instanceof Error ? error.message : String(error),
			);
		} catch (abortError) {
			this.ownershipFailedClosed = true;
			await this.ownershipAdapter!.failClosed(abortError);
		}
	}

	private async replaceOwnedSession<T>(spec: {
		reason: SessionReplacementReason;
		shutdownReason: SessionShutdownEvent["reason"];
		startReason: SessionStartEvent["reason"];
		destinationPath: string;
		destinationMustNotExist: boolean;
		prepareAfterTeardown?: boolean;
		intent?: {
			requestedPath?: string;
			importSourcePath?: string;
			parentSessionPath?: string;
			entryId?: string;
			position?: "before" | "at";
		};
		prepare: (canonicalPath: string, canonicalSelfReopen: boolean) => Promise<SessionManager> | SessionManager;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
		projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		result: T;
	}): Promise<T> {
		if (this.ownershipFailedClosed) {
			throw new Error("Worker session ownership already failed closed.");
		}
		const adapter = this.ownershipAdapter;
		const sourceLease = this.writeLease;
		const sourcePath = this.session.sessionFile;
		if (!adapter || !sourceLease || !sourcePath) {
			throw new Error("Worker replacement requires an active source write lease.");
		}

		let reservation: SessionOwnershipReservation | undefined;
		let sourceTeardownStarted = false;
		let commitAttempted = false;
		try {
			reservation = await adapter.reserveReplacement({
				operationId: this.nextReplacementOperationId(spec.reason),
				reason: spec.reason,
				source: sourceLease,
				destinationPath: spec.destinationPath,
				destinationMustNotExist: spec.destinationMustNotExist,
				...spec.intent,
			});

			const canonicalSelfReopen = sameResolvedPath(
				reservation.canonicalSourcePath,
				reservation.canonicalDestinationPath,
			);
			let manager: SessionManager | undefined;
			if (!spec.prepareAfterTeardown && !canonicalSelfReopen) {
				manager = await spec.prepare(reservation.canonicalDestinationPath, canonicalSelfReopen);
			}
			if (manager) {
				manager.bindPiePreparedPath(reservation.canonicalDestinationPath);
				const preparedPath = manager.getSessionFile();
				if (!preparedPath || !sameResolvedPath(preparedPath, reservation.canonicalDestinationPath)) {
					throw new Error("Prepared SDK destination does not match the canonical reservation.");
				}
			}

			await this.quiesceSource();
			sourceTeardownStarted = true;
			await this.teardownCurrent(spec.shutdownReason, reservation.canonicalDestinationPath);

			if (!manager) {
				manager = await spec.prepare(reservation.canonicalDestinationPath, canonicalSelfReopen);
				manager.bindPiePreparedPath(reservation.canonicalDestinationPath);
			}
			const preparedPath = manager.getSessionFile();
			if (!preparedPath || !sameResolvedPath(preparedPath, reservation.canonicalDestinationPath)) {
				throw new Error("Prepared SDK destination does not match the canonical reservation.");
			}

			// Revoke locally before asking the coordinator to commit. If that call
			// is ambiguous, no retained source manager can regain write authority.
			this.session.sessionManager.revokePieWriteLease();
			commitAttempted = true;
			const authorization = await adapter.commitTransfer(reservation, sourceLease);
			const destinationLease = await manager.activatePiePrepared(authorization);
			this.writeLease = destinationLease;

			const result = await this.createRuntime({
				cwd: manager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager: manager,
				sessionStartEvent: {
					type: "session_start",
					reason: spec.startReason,
					previousSessionFile: sourcePath,
				},
				projectTrustContext: spec.projectTrustContextFactory?.(manager.getCwd()),
			});
			this.apply(result);
			if (spec.setup) {
				await spec.setup(this.session.sessionManager);
				this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
			}

			const actualPath = this.session.sessionFile;
			if (!actualPath || !sameResolvedPath(actualPath, reservation.canonicalDestinationPath)) {
				throw new Error("Created runtime did not activate the reserved destination.");
			}
			await adapter.runtimeReady(destinationLease, resolve(actualPath));
			if (this.rebindSession) {
				await this.rebindSession(this.session);
			}
			if (spec.withSession) {
				await spec.withSession(this.session.createReplacedSessionContext());
			}
			return spec.result;
		} catch (error) {
			if (reservation && !sourceTeardownStarted) {
				await this.abortReplacementReservation(reservation, error);
				throw error;
			}
			if (sourceTeardownStarted || commitAttempted) {
				this.ownershipFailedClosed = true;
				this.session.sessionManager.revokePieWriteLease();
				return await adapter.failClosed(error);
			}
			throw error;
		}
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		if (!this.ownershipAdapter) {
			return this.legacySwitchSession(sessionPath, options);
		}
		return this.serializeReplacement(async () => {
			const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
			if (beforeResult.cancelled) {
				return beforeResult;
			}
			const requestedPath = resolvePath(sessionPath);
			const sourcePath = this.session.sessionFile;
			const reason: SessionReplacementReason = sourcePath && sameResolvedPath(sourcePath, requestedPath)
				? "self-reopen"
				: "switch";
			return this.replaceOwnedSession({
				reason,
				shutdownReason: "resume",
				startReason: "resume",
				destinationPath: requestedPath,
				destinationMustNotExist: false,
				prepareAfterTeardown: reason === "self-reopen",
				intent: { requestedPath: sessionPath },
				prepare: (canonicalPath) => {
					const manager = SessionManager.preparePieOpen(
						canonicalPath,
						undefined,
						options?.cwdOverride,
						this.ownershipAdapter!,
					);
					assertSessionCwdExists(manager, this.cwd);
					return manager;
				},
				withSession: options?.withSession,
				projectTrustContextFactory: options?.projectTrustContextFactory,
				result: { cancelled: false },
			});
		});
	}

	private async legacySwitchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		if (!this.ownershipAdapter) {
			return this.legacyNewSession(options);
		}
		return this.serializeReplacement(async () => {
			const beforeResult = await this.emitBeforeSwitch("new");
			if (beforeResult.cancelled) {
				return beforeResult;
			}
			// Allocate a destination candidate without publishing its session header;
			// the ownership reservation is still the first durable side effect.
			const prepared = SessionManager.preparePieCreate(
				this.cwd,
				this.session.sessionManager.getSessionDir(),
				{ parentSession: options?.parentSession },
				this.ownershipAdapter!,
			);
			return this.replaceOwnedSession({
				reason: "new",
				shutdownReason: "new",
				startReason: "new",
				destinationPath: prepared.getSessionFile()!,
				destinationMustNotExist: true,
				intent: { parentSessionPath: options?.parentSession },
				prepare: () => prepared,
				setup: options?.setup,
				withSession: options?.withSession,
				result: { cancelled: false },
			});
		});
	}

	private async legacyNewSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		let sessionManager: SessionManager;
		if (this.session.sessionManager.isPersisted()) {
			sessionManager = SessionManager.create(
				this.cwd,
				sessionDir,
				options?.parentSession ? { parentSession: options.parentSession } : undefined,
			);
		} else {
			sessionManager = SessionManager.inMemory(this.cwd);
			if (options?.parentSession) {
				sessionManager.newSession({ parentSession: options.parentSession });
			}
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
		);
		if (options?.setup) {
			await options.setup(this.session.sessionManager);
			this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
		}
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		if (!this.ownershipAdapter) {
			return this.legacyFork(entryId, options);
		}
		return this.serializeReplacement(async () => {
			const position = options?.position ?? "before";
			const beforeResult = await this.emitBeforeFork(entryId, { position });
			if (beforeResult.cancelled) {
				return { cancelled: true };
			}
			const selectedEntry = this.session.sessionManager.getEntry(entryId);
			if (!selectedEntry) {
				throw new Error("Invalid entry ID for forking");
			}

			let targetLeafId: string | null;
			let selectedText: string | undefined;
			if (position === "at") {
				targetLeafId = selectedEntry.id;
			} else {
				if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
					throw new Error("Invalid entry ID for forking");
				}
				targetLeafId = selectedEntry.parentId;
				selectedText = extractUserMessageText(selectedEntry.message.content);
			}

			const sourcePath = this.session.sessionFile;
			if (!sourcePath) {
				throw new Error("Persisted session is missing a session file");
			}
			// Allocate only the destination candidate before reserving it. Branch
			// content is assembled by the read-only prepare step after reservation.
			const candidate = SessionManager.preparePieCreate(
				this.cwd,
				this.session.sessionManager.getSessionDir(),
				{ parentSession: sourcePath },
				this.ownershipAdapter!,
			);
			const reason: SessionReplacementReason = !targetLeafId
				? "root-fork"
				: position === "at" ? "clone" : "branch-fork";
			return this.replaceOwnedSession({
				reason,
				shutdownReason: "fork",
				startReason: "fork",
				destinationPath: candidate.getSessionFile()!,
				destinationMustNotExist: true,
				intent: { entryId, position, parentSessionPath: sourcePath },
				prepare: () => targetLeafId
					? SessionManager.preparePieBranched(this.session.sessionManager, targetLeafId, this.ownershipAdapter!)
					: candidate,
				withSession: options?.withSession,
				result: { cancelled: false, selectedText },
			});
		});
	}

	private async legacyFork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir, { parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				this.apply(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			this.apply(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: this.session.sessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		if (!this.ownershipAdapter) {
			return this.legacyImportFromJsonl(inputPath, cwdOverride);
		}
		return this.serializeReplacement(async () => {
			const resolvedPath = resolvePath(inputPath);
			if (!existsSync(resolvedPath)) {
				throw new SessionImportFileNotFoundError(resolvedPath);
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			const destinationPath = join(sessionDir, basename(resolvedPath));
			const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
			if (beforeResult.cancelled) {
				return beforeResult;
			}

			const sourcePath = this.session.sessionFile;
			const selfReopen = Boolean(sourcePath && sameResolvedPath(sourcePath, destinationPath));
			const importAlreadyAtDestination = sameResolvedPath(destinationPath, resolvedPath);
			return this.replaceOwnedSession({
				reason: selfReopen ? "self-reopen" : "import",
				shutdownReason: "resume",
				startReason: "resume",
				destinationPath,
				destinationMustNotExist: !importAlreadyAtDestination,
				prepareAfterTeardown: selfReopen,
				intent: { requestedPath: inputPath, importSourcePath: resolvedPath },
				prepare: (canonicalPath, canonicalSelfReopen) => {
					const importingCurrentPath = canonicalSelfReopen && sameResolvedPath(resolvedPath, canonicalPath);
					const manager = importAlreadyAtDestination || importingCurrentPath
						? SessionManager.preparePieOpen(
								canonicalPath,
								sessionDir,
								cwdOverride,
								this.ownershipAdapter!,
							)
						: SessionManager.preparePieImport(
								resolvedPath,
								canonicalPath,
								sessionDir,
								cwdOverride,
								this.ownershipAdapter!,
							);
					assertSessionCwdExists(manager, this.cwd);
					return manager;
				},
				result: { cancelled: false },
			});
		});
	}

	private async legacyImportFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		const destinationPath = join(sessionDir, basename(resolvedPath));
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (resolve(destinationPath) !== resolvedPath) {
			copyFileSync(resolvedPath, destinationPath);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		this.apply(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async dispose(): Promise<void> {
		await emitSessionShutdownEvent(this.session.extensionRunner, {
			type: "session_shutdown",
			reason: "quit",
		});
		this.beforeSessionInvalidate?.();
		this.session.dispose();
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: CreateAgentSessionRuntimeOptions,
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const hasOwnershipAdapter = options.ownershipAdapter !== undefined;
	const hasWriteLease = options.writeLease !== undefined;
	if (hasOwnershipAdapter !== hasWriteLease) {
		throw new Error("Worker session runtime requires both ownershipAdapter and writeLease.");
	}
	if (options.ownershipAdapter && options.writeLease) {
		options.sessionManager.attachPieWriteLease(options.ownershipAdapter, options.writeLease);
	}
	// Keep the caller's synchronous context policy on the shared factory so all
	// replacement, self-reopen, and rebuild paths receive the same resolver.
	const sharedFactory: CreateAgentSessionRuntimeFactory = options.contextMessageOmissions
		? (runtimeOptions) => {
				runtimeOptions.sessionManager.setContextMessageOmissionsResolver(options.contextMessageOmissions);
				return createRuntime({
					...runtimeOptions,
					contextMessageOmissions: options.contextMessageOmissions,
				});
			}
		: createRuntime;
	const result = await sharedFactory(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		sharedFactory,
		result.diagnostics,
		result.modelFallbackMessage,
		options.ownershipAdapter,
		options.writeLease,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
