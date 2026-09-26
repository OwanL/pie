/**
 * Rotating, serialized async JSONL writer shared by the skill-pruner,
 * tool-result-pruner, and warm-bash extension loggers.
 *
 * Each extension creates an instance with its own log path and warning label,
 * then calls `append()` with a pre-serialized JSON string. The writer handles:
 *
 *   - Serialized async writes (concurrent appends preserve line ordering
 *     without blocking the event loop).
 *   - Size-based rotation with numbered backups (`.1`, `.2`, …).
 *   - Best-effort error handling (a write failure warns and is swallowed so
 *     logging never breaks the agent runtime).
 *   - Test seams to redirect the log path and lower the rotation threshold.
 *
 * This is a small utility, not a framework: the event types, serialization,
 * and public recording APIs stay in each extension's own logger module.
 */

import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { toErrorMessage } from "./error-message.js";

const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROTATIONS = 2;

export interface JsonlWriterOptions {
	/** Default log path (used when no test override is set). */
	defaultLogPath: string;
	/** Label for write-failure warnings, e.g. `"[skill-pruner] failed to append pruning log"`. */
	warnLabel: string;
	/** Rotation threshold in bytes (default ~5 MB). */
	maxBytes?: number;
	/** Number of rotated backups to keep, newest first (default 2). */
	maxRotations?: number;
}

/** A rotating, serialized async JSONL writer. See module doc for details. */
export class JsonlWriter {
	private writeQueue: Promise<void> = Promise.resolve();
	private logPathOverride: string | null = null;
	private maxLogBytesOverride: number | null = null;
	private readonly defaultLogPath: string;
	private readonly warnLabel: string;
	private readonly maxBytes: number;
	private readonly maxRotations: number;

	constructor(options: JsonlWriterOptions) {
		this.defaultLogPath = options.defaultLogPath;
		this.warnLabel = options.warnLabel;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
		this.maxRotations = options.maxRotations ?? DEFAULT_MAX_ROTATIONS;
	}

	private getLogPath(): string {
		return this.logPathOverride ?? this.defaultLogPath;
	}

	private getLogByteLimit(): number {
		return this.maxLogBytesOverride ?? this.maxBytes;
	}

	/** Append a pre-serialized JSON string (without trailing newline) to the
	 *  log. Non-blocking: chains an async write onto the internal queue.
	 *  Captures the resolved path here — not at write time — so an
	 *  already-queued write stays pointed at the right file if the override
	 *  changes later (e.g. between tests). */
	append(json: string): void {
		const logPath = this.getLogPath();
		const line = `${json}\n`;
		this.writeQueue = this.writeQueue
			.then(() => this.writeJsonLine(logPath, line))
			.catch((error) => {
				console.warn(`${this.warnLabel}: ${toErrorMessage(error)}`);
			});
	}

	private async writeJsonLine(logPath: string, line: string): Promise<void> {
		await mkdir(path.dirname(logPath), { recursive: true });
		if (await this.shouldRotateLog(logPath)) {
			await this.rotateLog(logPath);
		}
		await appendFile(logPath, line, "utf-8");
	}

	private async shouldRotateLog(logPath: string): Promise<boolean> {
		try {
			const stats = await stat(logPath);
			return stats.size >= this.getLogByteLimit();
		} catch {
			return false;
		}
	}

	/** Rename the current log to `.1` (shifting older backups down) so the
	 *  next append starts a fresh file. Keeps the newest `maxRotations` backups. */
	private async rotateLog(logPath: string): Promise<void> {
		await rm(`${logPath}.${this.maxRotations}`, { force: true });
		for (let i = this.maxRotations - 1; i >= 1; i--) {
			await this.safeRename(`${logPath}.${i}`, `${logPath}.${i + 1}`);
		}
		await this.safeRename(logPath, `${logPath}.1`);
	}

	private async safeRename(from: string, to: string): Promise<void> {
		try {
			await rename(from, to);
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
	}

	/** Wait for all queued log writes to finish. Tests await this before
	 *  reading the JSONL file; production may call it to drain on shutdown. */
	flush(): Promise<void> {
		return this.writeQueue;
	}

	/** Test seam: redirect the log to a temp path. Pass null to clear. */
	setLogPathForTesting(logPath: string | null): void {
		this.logPathOverride = logPath;
	}

	/** Test seam: lower the rotation threshold so tests can exercise
	 *  rotation without writing 5 MB. Pass null to restore the default. */
	setMaxLogBytesForTesting(bytes: number | null): void {
		this.maxLogBytesOverride = bytes;
	}
}

function isEnoent(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
