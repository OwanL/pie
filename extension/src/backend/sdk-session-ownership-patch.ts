export const SDK_SESSION_OWNERSHIP_MANAGER_PATCH_VERSION = 2 as const;
export const SDK_SESSION_REPLACEMENT_RUNTIME_PATCH_VERSION = 10 as const;
export const SDK_SESSION_MANAGER_RELATIVE_PATH = 'dist/core/session-manager.js';
export const SDK_SESSION_RUNTIME_RELATIVE_PATH = 'dist/core/agent-session-runtime.js';

const MANAGER_HELPER_ANCHOR = `export class SessionManager {\n    sessionId = "";`;
const MANAGER_HELPER_REPLACEMENT = `export class StaleSessionWriteLeaseError extends Error {
    code = "STALE_SESSION_WRITE_LEASE";
    constructor(message) {
        super(message);
        this.name = "StaleSessionWriteLeaseError";
    }
}
function pieResolvedPathKey(value) {
    const resolved = resolvePath(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function assertPieLeaseShape(lease, canonicalPath, seam) {
    if (!lease || typeof lease !== "object" || !Number.isSafeInteger(lease.coordinatorGeneration) || lease.coordinatorGeneration <= 0 ||
        typeof lease.workerId !== "string" || lease.workerId.length === 0 || !Number.isSafeInteger(lease.workerGeneration) || lease.workerGeneration <= 0 ||
        !Number.isSafeInteger(lease.ownershipRevision) || lease.ownershipRevision <= 0 || typeof lease.nonce !== "string" || lease.nonce.length === 0 ||
        typeof lease.canonicalSessionPath !== "string" || pieResolvedPathKey(lease.canonicalSessionPath) !== pieResolvedPathKey(canonicalPath)) {
        throw new StaleSessionWriteLeaseError(\`Invalid or wrong-path session write lease at \${seam}.\`);
    }
}
export class SessionManager {
    sessionId = "";
    pieOwnershipAdapter;
    pieWriteLease;
    piePreparedKind;
    piePreparedNeedsWrite = false;
    piePreparedWriteMode = "w";`;

/** Previous manager patch accepted Windows drive-letter casing drift in no
 * places. Keep its exact semantic shape as a one-way upgrade candidate so an
 * installed SDK patched by the prior extension can be safely strengthened. */
const MANAGER_HELPER_REPLACEMENT_V1 = MANAGER_HELPER_REPLACEMENT
  .replace(`function pieResolvedPathKey(value) {
    const resolved = resolvePath(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
`, '')
  .replace('pieResolvedPathKey(lease.canonicalSessionPath) !== pieResolvedPathKey(canonicalPath)', 'resolvePath(lease.canonicalSessionPath) !== resolvePath(canonicalPath)');

const MANAGER_METHODS_ANCHOR = `    /**
     * Create a new session.
     * @param cwd Working directory (stored in session header)`;
const MANAGER_METHODS_REPLACEMENT = `    attachPieWriteLease(adapter, lease) {
        if (!adapter || typeof adapter.assertWriteLease !== "function") {
            throw new StaleSessionWriteLeaseError("Worker session ownership adapter is missing.");
        }
        const sessionFile = this.getSessionFile();
        if (!sessionFile) {
            throw new StaleSessionWriteLeaseError("Worker session manager has no canonical session path.");
        }
        assertPieLeaseShape(lease, sessionFile, "attachPieWriteLease");
        adapter.assertWriteLease(lease, resolvePath(sessionFile), "attachPieWriteLease");
        this.pieOwnershipAdapter = adapter;
        this.pieWriteLease = lease;
    }
    revokePieWriteLease() {
        this.pieWriteLease = undefined;
    }
    _assertPieWriteLease(seam) {
        if (process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR) {
            try {
                const traceDir = process.env.PIE_WRITE_OWNERSHIP_TRACE_DIR;
                const traceLease = this.pieWriteLease;
                const traceRecord = { event: "pie.write-ownership", ts: Date.now(), pid: process.pid, seam, sessionPath: this.getSessionFile() ?? null, ownerRole: this.pieOwnershipAdapter ? "worker" : "coordinator" };
                if (traceLease) {
                    traceRecord.workerId = traceLease.workerId;
                    traceRecord.workerGeneration = traceLease.workerGeneration;
                    traceRecord.coordinatorGeneration = traceLease.coordinatorGeneration;
                }
                appendFileSync(join(traceDir, "write-ownership-" + process.pid + ".jsonl"), JSON.stringify(traceRecord) + "\\n");
            } catch (error) { /* test-build ownership instrumentation is best-effort */ }
        }
        if (!this.pieOwnershipAdapter)
            return;
        const sessionFile = this.getSessionFile();
        if (!sessionFile || !this.pieWriteLease) {
            throw new StaleSessionWriteLeaseError(\`Stale session write lease at \${seam}.\`);
        }
        assertPieLeaseShape(this.pieWriteLease, sessionFile, seam);
        this.pieOwnershipAdapter.assertWriteLease(this.pieWriteLease, resolvePath(sessionFile), seam);
    }
    async activatePiePrepared(authorization) {
        if (!this.pieOwnershipAdapter || !this.piePreparedKind || this.pieWriteLease) {
            throw new StaleSessionWriteLeaseError("Session manager is not an inactive prepared destination.");
        }
        const sessionFile = this.getSessionFile();
        if (!sessionFile || !authorization || resolvePath(authorization.canonicalDestinationPath) !== resolvePath(sessionFile)) {
            throw new StaleSessionWriteLeaseError("Transfer authorization is for the wrong prepared destination.");
        }
        const lease = await this.pieOwnershipAdapter.consumeTransferAuthorization(authorization, resolvePath(sessionFile));
        assertPieLeaseShape(lease, sessionFile, "activatePiePrepared");
        this.pieWriteLease = lease;
        this._assertPieWriteLease("activatePiePrepared");
        const preparedKind = this.piePreparedKind;
        this.piePreparedKind = undefined;
        if (preparedKind === "create") {
            persistCreatedSessionHeader(this);
            this.flushed = true;
        }
        else if (this.piePreparedNeedsWrite) {
            this._rewriteFile();
            this.flushed = true;
        }
        this.piePreparedNeedsWrite = false;
        this.piePreparedWriteMode = "w";
        return lease;
    }
    static preparePieCreate(cwd, sessionDir, options, adapter) {
        const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDirPath(cwd);
        const manager = new SessionManager(cwd, "", undefined, false, options);
        manager.sessionDir = dir;
        manager.persist = true;
        const header = manager.getHeader();
        const fileTimestamp = header.timestamp.replace(/[:.]/g, "-");
        manager.sessionFile = join(dir, \`\${fileTimestamp}_\${manager.sessionId}.jsonl\`);
        manager.pieOwnershipAdapter = adapter;
        manager.piePreparedKind = "create";
        manager.piePreparedWriteMode = "wx";
        return manager;
    }
    static preparePieOpen(sessionPath, sessionDir, cwdOverride, adapter) {
        const resolvedPath = resolvePath(sessionPath);
        const entries = loadEntriesFromFile(resolvedPath);
        const existing = existsSync(resolvedPath);
        if (existing && entries.length === 0 && statSync(resolvedPath).size > 0) {
            throw new Error(\`Session file is not a valid pi session: \${resolvedPath}\`);
        }
        const header = entries.find((entry) => entry.type === "session");
        const cwd = cwdOverride ?? header?.cwd ?? process.cwd();
        const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
        const manager = new SessionManager(cwd, "", undefined, false);
        manager.sessionDir = dir;
        manager.persist = true;
        manager.sessionFile = resolvedPath;
        manager.pieOwnershipAdapter = adapter;
        manager.piePreparedKind = "open";
        if (entries.length === 0) {
            manager.piePreparedNeedsWrite = true;
            manager.piePreparedWriteMode = existing ? "w" : "wx";
        }
        else {
            manager.fileEntries = entries;
            manager.sessionId = header?.id ?? createSessionId();
            manager.piePreparedNeedsWrite = migrateToCurrentVersion(manager.fileEntries);
            manager.piePreparedWriteMode = "w";
            manager._buildIndex();
            manager.flushed = !manager.piePreparedNeedsWrite;
        }
        return manager;
    }
    static preparePieBranched(source, leafId, adapter) {
        source._assertPieWriteLease("preparePieBranched:source");
        const branchPath = source.getBranch(leafId);
        if (branchPath.length === 0)
            throw new Error(\`Entry \${leafId} not found\`);
        const manager = SessionManager.preparePieCreate(source.cwd, source.getSessionDir(), { parentSession: source.sessionFile }, adapter);
        const header = manager.getHeader();
        const retained = [];
        let parentId = null;
        for (const entry of branchPath) {
            if (entry.type === "label")
                continue;
            retained.push({ ...entry, parentId });
            parentId = entry.id;
        }
        const retainedIds = new Set(retained.map((entry) => entry.id));
        const labels = [];
        for (const [targetId, label] of source.labelsById) {
            if (!retainedIds.has(targetId))
                continue;
            const labelEntry = {
                type: "label",
                id: generateId(new Set([...retainedIds, ...labels.map((entry) => entry.id)])),
                parentId,
                timestamp: source.labelTimestampsById.get(targetId),
                targetId,
                label,
            };
            labels.push(labelEntry);
            parentId = labelEntry.id;
        }
        manager.fileEntries = [header, ...retained, ...labels];
        manager._buildIndex();
        manager.piePreparedKind = "branch";
        manager.piePreparedNeedsWrite = true;
        manager.piePreparedWriteMode = "wx";
        return manager;
    }
    static preparePieImport(sourcePath, destinationPath, sessionDir, cwdOverride, adapter) {
        const sourceEntries = loadEntriesFromFile(sourcePath);
        if (sourceEntries.length === 0)
            throw new Error(\`Cannot import empty or invalid session: \${sourcePath}\`);
        const header = sourceEntries.find((entry) => entry.type === "session");
        if (!header)
            throw new Error(\`Cannot import session without a header: \${sourcePath}\`);
        const manager = new SessionManager(cwdOverride ?? header.cwd ?? process.cwd(), "", undefined, false);
        manager.sessionDir = normalizePath(sessionDir);
        manager.persist = true;
        manager.sessionFile = resolvePath(destinationPath);
        manager.fileEntries = sourceEntries;
        migrateToCurrentVersion(manager.fileEntries);
        manager.sessionId = header.id;
        manager._buildIndex();
        manager.pieOwnershipAdapter = adapter;
        manager.piePreparedKind = "import";
        manager.piePreparedNeedsWrite = true;
        manager.piePreparedWriteMode = "wx";
        return manager;
    }
    /**
     * Create a new session.
     * @param cwd Working directory (stored in session header)`;

const MANAGER_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [MANAGER_HELPER_ANCHOR, MANAGER_HELPER_REPLACEMENT],
  [MANAGER_METHODS_ANCHOR, MANAGER_METHODS_REPLACEMENT],
  [`    setSessionFile(sessionFile) {\n        this.sessionFile = resolvePath(sessionFile);`, `    setSessionFile(sessionFile) {
        if (this.pieOwnershipAdapter)
            throw new StaleSessionWriteLeaseError("Worker session manager cannot change paths without a replacement transfer.");
        this.sessionFile = resolvePath(sessionFile);`],
  [`    newSession(options) {\n        if (options?.id !== undefined) {`, `    newSession(options) {
        if (this.pieOwnershipAdapter)
            throw new StaleSessionWriteLeaseError("Worker session manager cannot allocate a new path without a replacement reservation.");
        if (options?.id !== undefined) {`],
  [`    _rewriteFile() {\n        if (!this.persist || !this.sessionFile)\n            return;\n        const fd = openSync(this.sessionFile, "w");`, `    _rewriteFile() {
        if (!this.persist || !this.sessionFile)
            return;
        this._assertPieWriteLease("_rewriteFile");
        const fd = openSync(this.sessionFile, this.piePreparedWriteMode ?? "w");`],
  [`    _persist(entry) {\n        if (!this.persist || !this.sessionFile)\n            return;`, `    _persist(entry) {
        if (!this.persist || !this.sessionFile)
            return;
        this._assertPieWriteLease("_persist");`],
  [`    _appendEntry(entry) {\n        this.fileEntries.push(entry);`, `    _appendEntry(entry) {
        this._assertPieWriteLease("_appendEntry");
        this.fileEntries.push(entry);`],
  [`    branch(branchFromId) {\n        if (!this.byId.has(branchFromId)) {`, `    branch(branchFromId) {
        this._assertPieWriteLease("branch");
        if (!this.byId.has(branchFromId)) {`],
  [`    resetLeaf() {\n        this.leafId = null;`, `    resetLeaf() {
        this._assertPieWriteLease("resetLeaf");
        this.leafId = null;`],
  [`    branchWithSummary(branchFromId, summary, details, fromHook) {\n        if (branchFromId !== null`, `    branchWithSummary(branchFromId, summary, details, fromHook) {
        this._assertPieWriteLease("branchWithSummary");
        if (branchFromId !== null`],
  [`    createBranchedSession(leafId) {\n        const previousSessionFile = this.sessionFile;`, `    createBranchedSession(leafId) {
        if (this.pieOwnershipAdapter)
            throw new StaleSessionWriteLeaseError("Worker branch destinations require preparePieBranched and a transfer authorization.");
        const previousSessionFile = this.sessionFile;`],
];

export const SDK_SESSION_MANAGER_OWNERSHIP_MARKERS = [
  'export class StaleSessionWriteLeaseError extends Error',
  'assertPieLeaseShape(this.pieWriteLease, sessionFile, seam)',
  'attachPieWriteLease(adapter, lease)',
  'revokePieWriteLease()',
  'async activatePiePrepared(authorization)',
  'await this.pieOwnershipAdapter.consumeTransferAuthorization(authorization, resolvePath(sessionFile))',
  'static preparePieCreate(cwd, sessionDir, options, adapter)',
  'static preparePieOpen(sessionPath, sessionDir, cwdOverride, adapter)',
  'static preparePieBranched(source, leafId, adapter)',
  'static preparePieImport(sourcePath, destinationPath, sessionDir, cwdOverride, adapter)',
  'Worker session manager cannot change paths without a replacement transfer.',
  'Worker session manager cannot allocate a new path without a replacement reservation.',
  'this._assertPieWriteLease("_rewriteFile")',
  'this._assertPieWriteLease("_persist")',
  'this._assertPieWriteLease("_appendEntry")',
  'this._assertPieWriteLease("branch")',
  'this._assertPieWriteLease("resetLeaf")',
  'this._assertPieWriteLease("branchWithSummary")',
  'Worker branch destinations require preparePieBranched',
] as const;

const SDK_SESSION_MANAGER_OWNERSHIP_V1_MARKERS = SDK_SESSION_MANAGER_OWNERSHIP_MARKERS.map((marker) => (
  marker === 'async activatePiePrepared(authorization)'
    ? 'activatePiePrepared(authorization)'
    : marker === 'await this.pieOwnershipAdapter.consumeTransferAuthorization(authorization, resolvePath(sessionFile))'
      ? 'consumeTransferAuthorization(authorization, resolvePath(sessionFile))'
      : marker
));

const RUNTIME_CLASS_ANCHOR = `export class AgentSessionRuntime {\n    rebindSession;`;
const RUNTIME_CLASS_REPLACEMENT = `export class AgentSessionRuntime {
    rebindSession;
    ownershipAdapter;
    writeLease;
    replacementTail = Promise.resolve();
    replacementSequence = 0;
    ownershipFailedClosed = false;`;

const RUNTIME_CONSTRUCTOR_ANCHOR = `    constructor(_session, _services, createRuntime, _diagnostics = [], _modelFallbackMessage) {
        this._session = _session;
        this._services = _services;
        this.createRuntime = createRuntime;
        this._diagnostics = _diagnostics;
        this._modelFallbackMessage = _modelFallbackMessage;
    }`;
const RUNTIME_CONSTRUCTOR_REPLACEMENT = `    constructor(_session, _services, createRuntime, _diagnostics = [], _modelFallbackMessage, ownershipAdapter, writeLease) {
        this._session = _session;
        this._services = _services;
        this.createRuntime = createRuntime;
        this._diagnostics = _diagnostics;
        this._modelFallbackMessage = _modelFallbackMessage;
        this.ownershipAdapter = ownershipAdapter;
        this.writeLease = writeLease;
    }`;

const RUNTIME_METHODS_ANCHOR = `    async switchSession(sessionPath, options) {`;
const RUNTIME_METHODS_REPLACEMENT = `    _pieSerializeReplacement(operation) {
        const run = this.replacementTail.then(operation, operation);
        this.replacementTail = run.then(() => undefined, () => undefined);
        return run;
    }
    _pieOperationId(reason) {
        this.replacementSequence += 1;
        return \`pie-replacement:\${reason}:\${this.replacementSequence}\`;
    }
    async _pieQuiesceSource() {
        this.session.clearQueue?.();
        this.session.abortCompaction?.();
        this.session.abortBranchSummary?.();
        this.session.abortBash?.();
        this.session.abortRetry?.();
        await this.session.abort();
        await this.session.agent?.waitForIdle?.();
        while (this.session.isCompacting || this.session.isRetrying || this.session.isBashRunning) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    async _pieAbortReservation(reservation, error) {
        try {
            await this.ownershipAdapter.abortPrecommit(reservation, error instanceof Error ? error.message : String(error));
        }
        catch (abortError) {
            return await this.ownershipAdapter.failClosed(abortError);
        }
    }
    async _pieReplace(spec) {
        if (this.ownershipFailedClosed)
            throw new Error("Worker session ownership already failed closed.");
        const sourceLease = this.writeLease;
        const sourcePath = this.session.sessionFile;
        if (!sourceLease || !sourcePath)
            throw new Error("Worker replacement requires an active source write lease.");
        let reservation;
        let commitAttempted = false;
        let sourceTeardownStarted = false;
        try {
            reservation = await this.ownershipAdapter.reserveReplacement({
                operationId: this._pieOperationId(spec.reason),
                reason: spec.reason,
                source: sourceLease,
                destinationPath: spec.destinationPath,
                destinationMustNotExist: spec.destinationMustNotExist,
                ...spec.intent,
            });
            const canonicalSelfReopen = resolve(reservation.canonicalSourcePath) === resolve(reservation.canonicalDestinationPath);
            let manager;
            if (!spec.prepareAfterTeardown && !canonicalSelfReopen)
                manager = await spec.prepare(reservation.canonicalDestinationPath);
            if (manager && resolve(manager.getSessionFile()) !== resolve(reservation.canonicalDestinationPath))
                throw new Error("Prepared SDK destination does not match the canonical reservation.");
            await this._pieQuiesceSource();
            sourceTeardownStarted = true;
            await this.teardownCurrent(spec.shutdownReason, reservation.canonicalDestinationPath);
            if (!manager)
                manager = await spec.prepare(reservation.canonicalDestinationPath);
            if (resolve(manager.getSessionFile()) !== resolve(reservation.canonicalDestinationPath))
                throw new Error("Prepared SDK destination does not match the canonical reservation.");
            // Fence the source manager locally before crossing the coordinator
            // commit boundary. IPC loss can no longer reactivate source writes.
            this.session.sessionManager.revokePieWriteLease?.();
            commitAttempted = true;
            const authorization = await this.ownershipAdapter.commitTransfer(reservation, sourceLease);
            const destinationLease = await manager.activatePiePrepared(authorization);
            const result = await this.createRuntime({
                cwd: manager.getCwd(),
                agentDir: this.services.agentDir,
                sessionManager: manager,
                sessionStartEvent: { type: "session_start", reason: spec.startReason, previousSessionFile: sourcePath },
                projectTrustContext: spec.projectTrustContextFactory?.(manager.getCwd()),
            });
            this.apply(result);
            this.writeLease = destinationLease;
            if (spec.setup) {
                await spec.setup(this.session.sessionManager);
                this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
            }
            const actualPath = this.session.sessionFile;
            if (!actualPath || resolve(actualPath) !== resolve(reservation.canonicalDestinationPath))
                throw new Error("Created runtime did not activate the reserved destination.");
            await this.ownershipAdapter.runtimeReady(destinationLease, resolve(actualPath));
            if (this.rebindSession)
                await this.rebindSession(this.session);
            if (spec.withSession)
                await spec.withSession(this.session.createReplacedSessionContext());
            return spec.result;
        }
        catch (error) {
            if (reservation && !sourceTeardownStarted) {
                await this._pieAbortReservation(reservation, error);
                throw error;
            }
            if (sourceTeardownStarted || commitAttempted) {
                this.ownershipFailedClosed = true;
                return await this.ownershipAdapter.failClosed(error);
            }
            throw error;
        }
    }
    async switchSession(sessionPath, options) {
        if (!this.ownershipAdapter)
            return await this._pieLegacySwitchSession(sessionPath, options);
        return await this._pieSerializeReplacement(async () => {
            const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
            if (beforeResult.cancelled)
                return beforeResult;
            const requested = resolvePath(sessionPath);
            const source = this.session.sessionFile ? resolve(this.session.sessionFile) : undefined;
            const reason = source === resolve(requested) ? "self-reopen" : "switch";
            return await this._pieReplace({
                reason,
                shutdownReason: "resume",
                startReason: "resume",
                destinationPath: requested,
                destinationMustNotExist: false,
                prepareAfterTeardown: reason === "self-reopen",
                intent: { requestedPath: sessionPath },
                prepare: async (canonicalPath) => {
                    const manager = SessionManager.preparePieOpen(canonicalPath, undefined, options?.cwdOverride, this.ownershipAdapter);
                    assertSessionCwdExists(manager, this.cwd);
                    return manager;
                },
                withSession: options?.withSession,
                projectTrustContextFactory: options?.projectTrustContextFactory,
                result: { cancelled: false },
            });
        });
    }
    async newSession(options) {
        if (!this.ownershipAdapter)
            return await this._pieLegacyNewSession(options);
        return await this._pieSerializeReplacement(async () => {
            const beforeResult = await this.emitBeforeSwitch("new");
            if (beforeResult.cancelled)
                return beforeResult;
            const prepared = SessionManager.preparePieCreate(this.cwd, this.session.sessionManager.getSessionDir(), { parentSession: options?.parentSession }, this.ownershipAdapter);
            return await this._pieReplace({
                reason: "new",
                shutdownReason: "new",
                startReason: "new",
                destinationPath: prepared.getSessionFile(),
                destinationMustNotExist: true,
                intent: { parentSessionPath: options?.parentSession },
                prepare: async (canonicalPath) => {
                    prepared.sessionFile = canonicalPath;
                    return prepared;
                },
                setup: options?.setup,
                withSession: options?.withSession,
                result: { cancelled: false },
            });
        });
    }
    async fork(entryId, options) {
        if (!this.ownershipAdapter)
            return await this._pieLegacyFork(entryId, options);
        return await this._pieSerializeReplacement(async () => {
            const position = options?.position ?? "before";
            const beforeResult = await this.emitBeforeFork(entryId, { position });
            if (beforeResult.cancelled)
                return { cancelled: true };
            const selectedEntry = this.session.sessionManager.getEntry(entryId);
            if (!selectedEntry)
                throw new Error("Invalid entry ID for forking");
            let targetLeafId;
            let selectedText;
            if (position === "at")
                targetLeafId = selectedEntry.id;
            else {
                if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user")
                    throw new Error("Invalid entry ID for forking");
                targetLeafId = selectedEntry.parentId;
                selectedText = extractUserMessageText(selectedEntry.message.content);
            }
            const sourcePath = this.session.sessionFile;
            let prepared;
            let reason;
            if (!targetLeafId) {
                prepared = SessionManager.preparePieCreate(this.cwd, this.session.sessionManager.getSessionDir(), { parentSession: sourcePath }, this.ownershipAdapter);
                reason = "root-fork";
            }
            else {
                prepared = SessionManager.preparePieBranched(this.session.sessionManager, targetLeafId, this.ownershipAdapter);
                reason = position === "at" ? "clone" : "branch-fork";
            }
            return await this._pieReplace({
                reason,
                shutdownReason: "fork",
                startReason: "fork",
                destinationPath: prepared.getSessionFile(),
                destinationMustNotExist: true,
                intent: { entryId, position, parentSessionPath: sourcePath },
                prepare: async (canonicalPath) => {
                    prepared.sessionFile = canonicalPath;
                    return prepared;
                },
                withSession: options?.withSession,
                result: { cancelled: false, selectedText },
            });
        });
    }
    async importFromJsonl(inputPath, cwdOverride) {
        if (!this.ownershipAdapter)
            return await this._pieLegacyImportFromJsonl(inputPath, cwdOverride);
        return await this._pieSerializeReplacement(async () => {
            const resolvedPath = resolvePath(inputPath);
            if (!existsSync(resolvedPath))
                throw new SessionImportFileNotFoundError(resolvedPath);
            const sessionDir = this.session.sessionManager.getSessionDir();
            const destinationPath = join(sessionDir, basename(resolvedPath));
            const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
            if (beforeResult.cancelled)
                return beforeResult;
            const source = this.session.sessionFile ? resolve(this.session.sessionFile) : undefined;
            const selfReopen = process.platform === "win32"
                ? source?.toLowerCase() === resolve(destinationPath).toLowerCase()
                : source === resolve(destinationPath);
            const importAlreadyAtDestination = process.platform === "win32"
                ? resolve(destinationPath).toLowerCase() === resolvedPath.toLowerCase()
                : resolve(destinationPath) === resolvedPath;
            return await this._pieReplace({
                reason: selfReopen ? "self-reopen" : "import",
                shutdownReason: "resume",
                startReason: "resume",
                destinationPath,
                destinationMustNotExist: !importAlreadyAtDestination,
                prepareAfterTeardown: selfReopen,
                intent: { requestedPath: inputPath, importSourcePath: resolvedPath },
                prepare: async (canonicalPath) => importAlreadyAtDestination
                    ? SessionManager.preparePieOpen(canonicalPath, sessionDir, cwdOverride, this.ownershipAdapter)
                    : SessionManager.preparePieImport(resolvedPath, canonicalPath, sessionDir, cwdOverride, this.ownershipAdapter),
                result: { cancelled: false },
            });
        });
    }
    async _pieLegacySwitchSession(sessionPath, options) {`;

const RUNTIME_RENAMES: ReadonlyArray<readonly [string, string]> = [
  [`    async newSession(options) {`, `    async _pieLegacyNewSession(options) {`],
  [`    async fork(entryId, options) {`, `    async _pieLegacyFork(entryId, options) {`],
  [`    async importFromJsonl(inputPath, cwdOverride) {`, `    async _pieLegacyImportFromJsonl(inputPath, cwdOverride) {`],
];

const RUNTIME_FACTORY_ANCHOR = `export async function createAgentSessionRuntime(createRuntime, options) {
    assertSessionCwdExists(options.sessionManager, options.cwd);
    const result = await createRuntime(options);
    return new AgentSessionRuntime(result.session, result.services, createRuntime, result.diagnostics, result.modelFallbackMessage);
}`;
const RUNTIME_FACTORY_REPLACEMENT = `export async function createAgentSessionRuntime(createRuntime, options) {
    assertSessionCwdExists(options.sessionManager, options.cwd);
    if ((options.ownershipAdapter && !options.writeLease) || (!options.ownershipAdapter && options.writeLease))
        throw new Error("Worker session runtime requires both ownershipAdapter and writeLease.");
    if (options.ownershipAdapter)
        options.sessionManager.attachPieWriteLease(options.ownershipAdapter, options.writeLease);
    const result = await createRuntime(options);
    return new AgentSessionRuntime(result.session, result.services, createRuntime, result.diagnostics, result.modelFallbackMessage, options.ownershipAdapter, options.writeLease);
}`;

const SDK_SESSION_RUNTIME_OWNERSHIP_V1_MARKERS = [
  '_pieSerializeReplacement(operation)',
  '_pieQuiesceSource()',
  'reserveReplacement({',
  'await this.teardownCurrent(spec.shutdownReason, reservation.canonicalDestinationPath)',
  'commitTransfer(reservation, sourceLease)',
  'revokePieWriteLease?.()',
  'await manager.activatePiePrepared(authorization)',
  'await this.ownershipAdapter.runtimeReady',
  'await spec.withSession(this.session.createReplacedSessionContext())',
  'return await this.ownershipAdapter.failClosed(error)',
  'async _pieLegacySwitchSession(sessionPath, options)',
  'options.sessionManager.attachPieWriteLease(options.ownershipAdapter, options.writeLease)',
] as const;

const SDK_SESSION_RUNTIME_OWNERSHIP_V2_MARKERS = [
  ...SDK_SESSION_RUNTIME_OWNERSHIP_V1_MARKERS,
  'let sourceTeardownStarted = false;',
] as const;

const RUNTIME_LEGACY_PARENT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [`        const sessionManager = this.session.sessionManager.isPersisted()
            ? SessionManager.create(this.cwd, sessionDir)
            : SessionManager.inMemory(this.cwd);
        if (options?.parentSession) {
            sessionManager.newSession({ parentSession: options.parentSession });
        }`, `        let sessionManager;
        if (this.session.sessionManager.isPersisted()) {
            sessionManager = SessionManager.create(this.cwd, sessionDir, options?.parentSession ? { parentSession: options.parentSession } : undefined);
        }
        else {
            sessionManager = SessionManager.inMemory(this.cwd);
            if (options?.parentSession)
                sessionManager.newSession({ parentSession: options.parentSession });
        }`],
  [`                const sessionManager = SessionManager.create(this.cwd, sessionDir);
                sessionManager.newSession({ parentSession: currentSessionFile });`, `                const sessionManager = SessionManager.create(this.cwd, sessionDir, { parentSession: currentSessionFile });`],
];

const SDK_SESSION_RUNTIME_OWNERSHIP_V3_MARKERS = [
  ...SDK_SESSION_RUNTIME_OWNERSHIP_V2_MARKERS,
  'SessionManager.create(this.cwd, sessionDir, options?.parentSession ? { parentSession: options.parentSession } : undefined)',
  'SessionManager.create(this.cwd, sessionDir, { parentSession: currentSessionFile })',
] as const;

const RUNTIME_LEGACY_IMPORT_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [`            const selfReopen = source === resolve(destinationPath);
            return await this._pieReplace({`, `            const selfReopen = source === resolve(destinationPath);
            const importAlreadyAtDestination = resolve(destinationPath) === resolvedPath;
            return await this._pieReplace({`],
  ['                destinationMustNotExist: !selfReopen,', '                destinationMustNotExist: !importAlreadyAtDestination,'],
  ['                prepare: async (canonicalPath) => selfReopen\n                    ? SessionManager.preparePieOpen', '                prepare: async (canonicalPath) => importAlreadyAtDestination\n                    ? SessionManager.preparePieOpen'],
];

const RUNTIME_WINDOWS_IMPORT_IDENTITY_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [`            const selfReopen = source === resolve(destinationPath);
            const importAlreadyAtDestination = resolve(destinationPath) === resolvedPath;`, `            const selfReopen = process.platform === "win32"
                ? source?.toLowerCase() === resolve(destinationPath).toLowerCase()
                : source === resolve(destinationPath);
            const importAlreadyAtDestination = process.platform === "win32"
                ? resolve(destinationPath).toLowerCase() === resolvedPath.toLowerCase()
                : resolve(destinationPath) === resolvedPath;`],
];

const SDK_SESSION_RUNTIME_OWNERSHIP_V4_MARKERS = [
  ...SDK_SESSION_RUNTIME_OWNERSHIP_V3_MARKERS,
  'const importAlreadyAtDestination = resolve(destinationPath) === resolvedPath;',
  'destinationMustNotExist: !importAlreadyAtDestination',
  'prepare: async (canonicalPath) => importAlreadyAtDestination',
] as const;

const RUNTIME_SELF_REOPEN_REFRESH_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [`            const manager = await spec.prepare(reservation.canonicalDestinationPath);
            if (resolve(manager.getSessionFile()) !== resolve(reservation.canonicalDestinationPath))
                throw new Error("Prepared SDK destination does not match the canonical reservation.");
            await this._pieQuiesceSource();`, `            let manager;
            if (!spec.prepareAfterQuiesce)
                manager = await spec.prepare(reservation.canonicalDestinationPath);
            if (manager && resolve(manager.getSessionFile()) !== resolve(reservation.canonicalDestinationPath))
                throw new Error("Prepared SDK destination does not match the canonical reservation.");
            await this._pieQuiesceSource();
            if (!manager)
                manager = await spec.prepare(reservation.canonicalDestinationPath);
            if (resolve(manager.getSessionFile()) !== resolve(reservation.canonicalDestinationPath))
                throw new Error("Prepared SDK destination does not match the canonical reservation.");`],
  ['                destinationMustNotExist: false,\n                intent: { requestedPath: sessionPath },', '                destinationMustNotExist: false,\n                prepareAfterQuiesce: reason === "self-reopen",\n                intent: { requestedPath: sessionPath },'],
  ['                destinationMustNotExist: !importAlreadyAtDestination,\n                intent: { requestedPath: inputPath, importSourcePath: resolvedPath },', '                destinationMustNotExist: !importAlreadyAtDestination,\n                prepareAfterQuiesce: selfReopen,\n                intent: { requestedPath: inputPath, importSourcePath: resolvedPath },'],
];

const SDK_SESSION_RUNTIME_OWNERSHIP_V5_MARKERS = [
  ...SDK_SESSION_RUNTIME_OWNERSHIP_V4_MARKERS,
  'if (!spec.prepareAfterQuiesce)',
  'prepareAfterQuiesce: reason === "self-reopen"',
  'prepareAfterQuiesce: selfReopen',
] as const;

const RUNTIME_COMPLETE_QUIESCE_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [`    async _pieQuiesceSource() {
        if (this.session.isStreaming) {
            await this.session.abort();
        }
        await this.session.agent?.waitForIdle?.();
    }`, `    async _pieQuiesceSource() {
        this.session.clearQueue?.();
        this.session.abortCompaction?.();
        this.session.abortBranchSummary?.();
        this.session.abortBash?.();
        this.session.abortRetry?.();
        await this.session.abort();
        await this.session.agent?.waitForIdle?.();
        while (this.session.isCompacting || this.session.isRetrying || this.session.isBashRunning) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }`],
  ['            if (!spec.prepareAfterQuiesce)\n', '            if (!spec.prepareAfterTeardown)\n'],
  [`            await this._pieQuiesceSource();
            if (!manager)
                manager = await spec.prepare(reservation.canonicalDestinationPath);
            if (resolve(manager.getSessionFile()) !== resolve(reservation.canonicalDestinationPath))
                throw new Error("Prepared SDK destination does not match the canonical reservation.");
            sourceTeardownStarted = true;
            await this.teardownCurrent(spec.shutdownReason, reservation.canonicalDestinationPath);`, `            await this._pieQuiesceSource();
            sourceTeardownStarted = true;
            await this.teardownCurrent(spec.shutdownReason, reservation.canonicalDestinationPath);
            if (!manager)
                manager = await spec.prepare(reservation.canonicalDestinationPath);
            if (resolve(manager.getSessionFile()) !== resolve(reservation.canonicalDestinationPath))
                throw new Error("Prepared SDK destination does not match the canonical reservation.");`],
  ['prepareAfterQuiesce: reason === "self-reopen"', 'prepareAfterTeardown: reason === "self-reopen"'],
  ['prepareAfterQuiesce: selfReopen', 'prepareAfterTeardown: selfReopen'],
];

const SDK_SESSION_RUNTIME_OWNERSHIP_V6_MARKERS = [
  ...SDK_SESSION_RUNTIME_OWNERSHIP_V4_MARKERS,
  'this.session.abortCompaction?.()',
  'while (this.session.isCompacting || this.session.isRetrying || this.session.isBashRunning)',
  'if (!spec.prepareAfterTeardown)',
  'prepareAfterTeardown: reason === "self-reopen"',
  'prepareAfterTeardown: selfReopen',
] as const;

const RUNTIME_CANONICAL_SELF_REOPEN_REPLACEMENTS: ReadonlyArray<readonly [string, string]> = [
  [`            });
            let manager;
            if (!spec.prepareAfterTeardown)
`, `            });
            const canonicalSelfReopen = resolve(reservation.canonicalSourcePath) === resolve(reservation.canonicalDestinationPath);
            let manager;
            if (!spec.prepareAfterTeardown && !canonicalSelfReopen)
`],
];

const SDK_SESSION_RUNTIME_OWNERSHIP_V9_MARKERS = [
  ...SDK_SESSION_RUNTIME_OWNERSHIP_V4_MARKERS,
  'this.session.clearQueue?.()',
  'this.session.abortCompaction?.()',
  'this.session.abortBranchSummary?.()',
  'this.session.abortBash?.()',
  'this.session.abortRetry?.()',
  'await this.session.abort()',
  'await this.session.agent?.waitForIdle?.()',
  'while (this.session.isCompacting || this.session.isRetrying || this.session.isBashRunning)',
  'this.session.sessionManager.revokePieWriteLease?.();\n            commitAttempted = true;\n            const authorization = await this.ownershipAdapter.commitTransfer',
  'const canonicalSelfReopen = resolve(reservation.canonicalSourcePath) === resolve(reservation.canonicalDestinationPath)',
  'if (!spec.prepareAfterTeardown && !canonicalSelfReopen)',
  'prepareAfterTeardown: reason === "self-reopen"',
  'prepareAfterTeardown: selfReopen',
] as const;

export const SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS = SDK_SESSION_RUNTIME_OWNERSHIP_V9_MARKERS.map((marker) => (
  marker === 'const importAlreadyAtDestination = resolve(destinationPath) === resolvedPath;'
    ? 'const importAlreadyAtDestination = process.platform === "win32"'
    : marker
));

const SDK_SESSION_RUNTIME_OWNERSHIP_V8_MARKERS = SDK_SESSION_RUNTIME_OWNERSHIP_V9_MARKERS.map((marker) => (
  marker === 'await manager.activatePiePrepared(authorization)'
    ? 'const destinationLease = manager.activatePiePrepared(authorization)'
    : marker
));

export type SdkSessionOwnershipTransformResult = 'patched' | 'already-present' | 'unsupported-shape';

function hasAll(source: string, markers: readonly string[]): boolean {
  return markers.every((marker) => source.includes(marker));
}

function replaceExactlyOnce(source: string, needle: string, replacement: string): string | undefined {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) return undefined;
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function applyForwardReplacements(
  source: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string | undefined {
  let transformed = source;
  for (const [needle, replacement] of replacements) {
    const next = replaceExactlyOnce(transformed, needle, replacement);
    if (next === undefined) return undefined;
    transformed = next;
  }
  return transformed;
}

function reverseReplacements(
  source: string,
  replacements: ReadonlyArray<readonly [string, string]>,
): string | undefined {
  let reversed = source;
  for (const [needle, replacement] of [...replacements].reverse()) {
    const next = replaceExactlyOnce(reversed, replacement, needle);
    if (next === undefined) return undefined;
    reversed = next;
  }
  return reversed;
}

/** Exact reversible structural transforms used by the patch barrier's semantic
 * fingerprint verifier. A marker-preserving reorder or weakened body cannot be
 * reversed to the pinned pristine 0.80.6 file. */
export function reverseSdkSessionManagerOwnership(source: string): string | undefined {
  let current = source;
  if (current.includes(MANAGER_HELPER_REPLACEMENT_V1)) {
    const upgraded = replaceExactlyOnce(current, MANAGER_HELPER_REPLACEMENT_V1, MANAGER_HELPER_REPLACEMENT);
    if (!upgraded) return undefined;
    current = upgraded;
  }
  if (hasAll(current, SDK_SESSION_MANAGER_OWNERSHIP_V1_MARKERS)
      && !hasAll(current, SDK_SESSION_MANAGER_OWNERSHIP_MARKERS)) {
    const asyncMethod = replaceExactlyOnce(
      current,
      '    activatePiePrepared(authorization) {',
      '    async activatePiePrepared(authorization) {',
    );
    const awaited = asyncMethod && replaceExactlyOnce(
      asyncMethod,
      '        const lease = this.pieOwnershipAdapter.consumeTransferAuthorization(authorization, resolvePath(sessionFile));',
      '        const lease = await this.pieOwnershipAdapter.consumeTransferAuthorization(authorization, resolvePath(sessionFile));',
    );
    if (!awaited) return undefined;
    current = awaited;
  }
  return reverseReplacements(current, MANAGER_REPLACEMENTS);
}

export function reverseSdkSessionRuntimeOwnership(source: string): string | undefined {
  let current = source;
  if (hasAll(current, SDK_SESSION_RUNTIME_OWNERSHIP_V9_MARKERS)
      && !hasAll(current, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)) {
    const upgraded = applyForwardReplacements(current, RUNTIME_WINDOWS_IMPORT_IDENTITY_REPLACEMENTS);
    if (!upgraded) return undefined;
    current = upgraded;
  }
  if (hasAll(current, SDK_SESSION_RUNTIME_OWNERSHIP_V8_MARKERS)
      && !hasAll(current, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)) {
    const upgraded = replaceExactlyOnce(
      current,
      '            const destinationLease = manager.activatePiePrepared(authorization);',
      '            const destinationLease = await manager.activatePiePrepared(authorization);',
    );
    if (!upgraded) return undefined;
    const pathUpgraded = applyForwardReplacements(upgraded, RUNTIME_WINDOWS_IMPORT_IDENTITY_REPLACEMENTS);
    if (!pathUpgraded) return undefined;
    current = pathUpgraded;
  }
  return reverseReplacements(current, [
    [RUNTIME_CLASS_ANCHOR, RUNTIME_CLASS_REPLACEMENT],
    [RUNTIME_CONSTRUCTOR_ANCHOR, RUNTIME_CONSTRUCTOR_REPLACEMENT],
    ...RUNTIME_LEGACY_PARENT_REPLACEMENTS,
    ...RUNTIME_RENAMES,
    [RUNTIME_METHODS_ANCHOR, RUNTIME_METHODS_REPLACEMENT],
    [RUNTIME_FACTORY_ANCHOR, RUNTIME_FACTORY_REPLACEMENT],
  ]);
}

export function transformSdkSessionManagerOwnership(source: string): {
  result: SdkSessionOwnershipTransformResult;
  source: string;
} {
  if (hasAll(source, SDK_SESSION_MANAGER_OWNERSHIP_MARKERS)) {
    const upgradedPathFence = replaceExactlyOnce(source, MANAGER_HELPER_REPLACEMENT_V1, MANAGER_HELPER_REPLACEMENT);
    if (upgradedPathFence !== undefined) return { result: 'patched', source: upgradedPathFence };
    return { result: 'already-present', source };
  }
  if (hasAll(source, SDK_SESSION_MANAGER_OWNERSHIP_V1_MARKERS)) {
    const asyncMethod = replaceExactlyOnce(
      source,
      '    activatePiePrepared(authorization) {',
      '    async activatePiePrepared(authorization) {',
    );
    const awaited = asyncMethod && replaceExactlyOnce(
      asyncMethod,
      '        const lease = this.pieOwnershipAdapter.consumeTransferAuthorization(authorization, resolvePath(sessionFile));',
      '        const lease = await this.pieOwnershipAdapter.consumeTransferAuthorization(authorization, resolvePath(sessionFile));',
    );
    return awaited && hasAll(awaited, SDK_SESSION_MANAGER_OWNERSHIP_MARKERS)
      ? { result: 'patched', source: awaited }
      : { result: 'unsupported-shape', source };
  }
  if (SDK_SESSION_MANAGER_OWNERSHIP_MARKERS.some((marker) => source.includes(marker))) {
    return { result: 'unsupported-shape', source };
  }
  let transformed = source;
  for (const [needle, replacement] of MANAGER_REPLACEMENTS) {
    const next = replaceExactlyOnce(transformed, needle, replacement);
    if (next === undefined) return { result: 'unsupported-shape', source };
    transformed = next;
  }
  return hasAll(transformed, SDK_SESSION_MANAGER_OWNERSHIP_MARKERS)
    ? { result: 'patched', source: transformed }
    : { result: 'unsupported-shape', source };
}

export function transformSdkSessionRuntimeOwnership(source: string): {
  result: SdkSessionOwnershipTransformResult;
  source: string;
} {
  if (hasAll(source, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)) return { result: 'already-present', source };
  if (hasAll(source, SDK_SESSION_RUNTIME_OWNERSHIP_V9_MARKERS)) {
    const upgraded = applyForwardReplacements(source, RUNTIME_WINDOWS_IMPORT_IDENTITY_REPLACEMENTS);
    return upgraded && hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)
      ? { result: 'patched', source: upgraded }
      : { result: 'unsupported-shape', source };
  }
  if (hasAll(source, SDK_SESSION_RUNTIME_OWNERSHIP_V8_MARKERS)) {
    const upgraded = replaceExactlyOnce(
      source,
      '            const destinationLease = manager.activatePiePrepared(authorization);',
      '            const destinationLease = await manager.activatePiePrepared(authorization);',
    );
    const pathUpgraded = upgraded && applyForwardReplacements(upgraded, RUNTIME_WINDOWS_IMPORT_IDENTITY_REPLACEMENTS);
    return pathUpgraded && hasAll(pathUpgraded, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)
      ? { result: 'patched', source: pathUpgraded }
      : { result: 'unsupported-shape', source };
  }
  if (hasAll(source, SDK_SESSION_RUNTIME_OWNERSHIP_V1_MARKERS)) {
    const v2Upgrades: ReadonlyArray<readonly [string, string]> = [
      ['        let commitAttempted = false;\n        try {', '        let commitAttempted = false;\n        let sourceTeardownStarted = false;\n        try {'],
      ['            await this._pieQuiesceSource();\n            await this.teardownCurrent(spec.shutdownReason, reservation.canonicalDestinationPath);', '            await this._pieQuiesceSource();\n            sourceTeardownStarted = true;\n            await this.teardownCurrent(spec.shutdownReason, reservation.canonicalDestinationPath);'],
      ['            if (reservation && !commitAttempted) {', '            if (reservation && !sourceTeardownStarted) {'],
      ['            if (commitAttempted) {', '            if (sourceTeardownStarted || commitAttempted) {'],
    ];
    let upgraded = source;
    if (!hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)) {
      const locallyFenced = replaceExactlyOnce(
        upgraded,
        '            commitAttempted = true;\n            const authorization = await this.ownershipAdapter.commitTransfer(reservation, sourceLease);\n            this.session.sessionManager.revokePieWriteLease?.();',
        '            // Fence the source manager locally before crossing the coordinator\n            // commit boundary. IPC loss can no longer reactivate source writes.\n            this.session.sessionManager.revokePieWriteLease?.();\n            commitAttempted = true;\n            const authorization = await this.ownershipAdapter.commitTransfer(reservation, sourceLease);',
      );
      if (locallyFenced !== undefined) upgraded = locallyFenced;
    }
    if (hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)) {
      return { result: 'patched', source: upgraded };
    }
    if (!hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_V2_MARKERS)) {
      for (const [needle, replacement] of v2Upgrades) {
        const next = replaceExactlyOnce(upgraded, needle, replacement);
        if (next === undefined) return { result: 'unsupported-shape', source };
        upgraded = next;
      }
    }
    if (!hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_V3_MARKERS)) {
      for (const [needle, replacement] of RUNTIME_LEGACY_PARENT_REPLACEMENTS) {
        const next = replaceExactlyOnce(upgraded, needle, replacement);
        if (next === undefined) return { result: 'unsupported-shape', source };
        upgraded = next;
      }
    }
    if (!hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_V4_MARKERS)) {
      for (const [needle, replacement] of RUNTIME_LEGACY_IMPORT_REPLACEMENTS) {
        const next = replaceExactlyOnce(upgraded, needle, replacement);
        if (next === undefined) return { result: 'unsupported-shape', source };
        upgraded = next;
      }
    }
    if (!hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_V6_MARKERS)) {
      if (!hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_V5_MARKERS)) {
        for (const [needle, replacement] of RUNTIME_SELF_REOPEN_REFRESH_REPLACEMENTS) {
          const next = replaceExactlyOnce(upgraded, needle, replacement);
          if (next === undefined) return { result: 'unsupported-shape', source };
          upgraded = next;
        }
      }
      for (const [needle, replacement] of RUNTIME_COMPLETE_QUIESCE_REPLACEMENTS) {
        const next = replaceExactlyOnce(upgraded, needle, replacement);
        if (next === undefined) return { result: 'unsupported-shape', source };
        upgraded = next;
      }
    }
    for (const [needle, replacement] of RUNTIME_CANONICAL_SELF_REOPEN_REPLACEMENTS) {
      const next = replaceExactlyOnce(upgraded, needle, replacement);
      if (next === undefined) return { result: 'unsupported-shape', source };
      upgraded = next;
    }
    return hasAll(upgraded, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)
      ? { result: 'patched', source: upgraded }
      : { result: 'unsupported-shape', source };
  }
  if (SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS.some((marker) => source.includes(marker))) {
    return { result: 'unsupported-shape', source };
  }
  let transformed = source;
  for (const [needle, replacement] of [
    [RUNTIME_CLASS_ANCHOR, RUNTIME_CLASS_REPLACEMENT],
    [RUNTIME_CONSTRUCTOR_ANCHOR, RUNTIME_CONSTRUCTOR_REPLACEMENT],
    ...RUNTIME_LEGACY_PARENT_REPLACEMENTS,
    ...RUNTIME_RENAMES,
    [RUNTIME_METHODS_ANCHOR, RUNTIME_METHODS_REPLACEMENT],
    [RUNTIME_FACTORY_ANCHOR, RUNTIME_FACTORY_REPLACEMENT],
  ] as ReadonlyArray<readonly [string, string]>) {
    const next = replaceExactlyOnce(transformed, needle, replacement);
    if (next === undefined) return { result: 'unsupported-shape', source };
    transformed = next;
  }
  return hasAll(transformed, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS)
    ? { result: 'patched', source: transformed }
    : { result: 'unsupported-shape', source };
}

export function hasSdkSessionManagerOwnershipMarkers(source: string): boolean {
  return hasAll(source, SDK_SESSION_MANAGER_OWNERSHIP_MARKERS);
}

export function hasSdkSessionRuntimeOwnershipMarkers(source: string): boolean {
  return hasAll(source, SDK_SESSION_RUNTIME_OWNERSHIP_MARKERS);
}
