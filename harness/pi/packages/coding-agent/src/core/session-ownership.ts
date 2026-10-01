/** Host-supplied ownership hooks. The runtime does not allocate leases or
 * implement coordinator policy; callers omitting these hooks retain ordinary
 * SessionManager and AgentSessionRuntime behavior. */
export interface SessionWorkerOwnershipIdentity {
	coordinatorGeneration: number;
	workerId: string;
	workerGeneration: number;
}

export interface SessionWriteLease extends SessionWorkerOwnershipIdentity {
	canonicalSessionPath: string;
	ownershipRevision: number;
	nonce: string;
}

export interface SessionOwnershipFingerprint {
	exists: boolean;
	size: number;
	sha256: string | null;
}

export type SessionReplacementReason =
	| "new"
	| "switch"
	| "root-fork"
	| "branch-fork"
	| "clone"
	| "import"
	| "self-reopen";

export interface SessionReplacementIntent {
	operationId: string;
	reason: SessionReplacementReason;
	source: SessionWriteLease;
	destinationPath: string;
	destinationMustNotExist: boolean;
	requestedPath?: string;
	importSourcePath?: string;
	parentSessionPath?: string;
	entryId?: string;
	position?: "before" | "at";
}

export interface SessionOwnershipReservation {
	reservationId: string;
	operationId: string;
	canonicalSourcePath: string;
	canonicalDestinationPath: string;
	ownershipRevision: number;
	nonce: string;
	destinationFingerprint: SessionOwnershipFingerprint;
}

export interface SessionTransferAuthorization {
	authorizationId: string;
	reservationId: string;
	canonicalDestinationPath: string;
	ownershipRevision: number;
	nonce: string;
	destinationLease: SessionWriteLease;
}

export interface SessionOwnershipAdapter {
	reserveReplacement(intent: SessionReplacementIntent): Promise<SessionOwnershipReservation>;
	abortPrecommit(reservation: SessionOwnershipReservation, reason: string): Promise<void>;
	commitTransfer(
		reservation: SessionOwnershipReservation,
		sourceLease: SessionWriteLease,
	): Promise<SessionTransferAuthorization>;
	consumeTransferAuthorization(
		authorization: SessionTransferAuthorization,
		canonicalDestinationPath: string,
	): Promise<SessionWriteLease>;
	assertWriteLease(lease: SessionWriteLease, canonicalPath: string, seam: string): void;
	/** Optional synchronous critical section around the complete mutation,
	 * including in-memory state. Implementations must tolerate nested calls. */
	runWriteMutation?<T>(
		lease: SessionWriteLease,
		canonicalPath: string,
		seam: string,
		sessionId: string,
		mutation: () => T,
	): T;
	runtimeReady(lease: SessionWriteLease, canonicalPath: string): Promise<void>;
	failClosed(error: unknown): Promise<never>;
}
