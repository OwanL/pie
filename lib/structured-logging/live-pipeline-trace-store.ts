import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import {
  createLivePipelineTraceRecord,
  type LivePipelineTraceEvent,
  type LivePipelineTraceHealthMetadata,
  type LivePipelineTraceProcess,
  type LivePipelineTraceRecord,
} from './live-pipeline-trace.js';

const DEFAULT_DIRECTORY = join(tmpdir(), 'pie-live-pipeline-traces');
const DEFAULT_MAX_QUEUE_SIZE = 512;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RETAINED_FILES = 8;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface LivePipelineTraceSink {
  append(filePath: string, data: string): Promise<void>;
  size(filePath: string): Promise<number>;
  rotate(sourcePath: string, targetPath: string): Promise<void>;
  list(directory: string): Promise<string[]>;
  remove(filePath: string): Promise<void>;
}

export interface LivePipelineTraceStoreOptions {
  enabled?: boolean;
  process: LivePipelineTraceProcess;
  traceRunId: string;
  sampleRate?: number;
  maxQueueSize?: number;
  maxFileBytes?: number;
  maxRetainedFiles?: number;
  maxAgeMs?: number;
  directory?: string;
  fileName?: string;
  hmacKey: string | Uint8Array;
  wallClock?: () => number;
  monoClock?: () => number;
  random?: () => number;
  sink?: LivePipelineTraceSink;
}

export interface LivePipelineTraceHealth {
  enabled: boolean;
  emitted: number;
  sampled: number;
  dropped: number;
  unflushed: number;
  writeFailures: number;
  rotations: number;
  currentBytes: number;
  retainedFiles: number;
  retentionMaxAgeMs: number;
  retentionMaxFiles: number;
}

/** Bounded best-effort store. Disabled record() returns before reading its event. */
export class LivePipelineTraceStore {
  private enabled: boolean;
  private readonly process: LivePipelineTraceProcess;
  private readonly traceRunId: string;
  private readonly sampleRate: number;
  private readonly maxQueueSize: number;
  private readonly maxFileBytes: number;
  private readonly maxRetainedFiles: number;
  private readonly maxAgeMs: number;
  private readonly directory: string;
  private readonly activePath: string;
  private readonly rotatedNamePrefix: string;
  private readonly hmacKey: string | Uint8Array;
  private readonly wallClock: () => number;
  private readonly monoClock: () => number;
  private readonly random: () => number;
  private readonly sink: LivePipelineTraceSink;
  private readonly queue: LivePipelineTraceRecord[] = [];
  private flushing: Promise<boolean> | undefined;
  private emitted = 0;
  private sampled = 0;
  private dropped = 0;
  private writeFailures = 0;
  private rotations = 0;
  private currentBytes = 0;
  private retainedFiles = 0;
  private processSeq = 0;

  constructor(options: LivePipelineTraceStoreOptions) {
    this.enabled = options.enabled ?? false;
    this.process = options.process;
    this.traceRunId = options.traceRunId;
    this.sampleRate = clamp(options.sampleRate ?? 1, 0, 1);
    this.maxQueueSize = Math.max(1, Math.floor(options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE));
    this.maxFileBytes = Math.max(0, Math.floor(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
    this.maxRetainedFiles = Math.max(0, Math.floor(options.maxRetainedFiles ?? DEFAULT_MAX_RETAINED_FILES));
    this.maxAgeMs = Math.max(0, Math.floor(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS));
    this.directory = options.directory ?? DEFAULT_DIRECTORY;
    const fileName = options.fileName ?? `live-pipeline-${options.process}.jsonl`;
    if (fileName.length === 0 || basename(fileName) !== fileName) throw new RangeError('Trace fileName must not be a path.');
    this.activePath = join(this.directory, fileName);
    const stem = fileName.endsWith('.jsonl') ? fileName.slice(0, -6) : fileName;
    this.rotatedNamePrefix = `${stem}.`;
    this.hmacKey = options.hmacKey;
    this.wallClock = options.wallClock ?? Date.now;
    this.monoClock = options.monoClock ?? (() => performance.now());
    this.random = options.random ?? Math.random;
    this.sink = options.sink ?? createNodeLivePipelineTraceSink();
  }

  isEnabled(): boolean { return this.enabled; }
  setEnabled(value: boolean): boolean { this.enabled = value; return this.enabled; }
  getFilePath(): string { return this.activePath; }

  record(event: LivePipelineTraceEvent): boolean {
    if (!this.enabled) return false;
    if (this.sampleRate === 0 || (this.sampleRate < 1 && this.random() >= this.sampleRate)) {
      this.sampled += 1;
      return false;
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.dropped += 1;
      return false;
    }
    try {
      this.queue.push(createLivePipelineTraceRecord(event, {
        hmacKey: this.hmacKey,
        wallTimestampMs: this.wallClock(),
        monoMs: this.monoClock(),
        runId: this.traceRunId,
        processSeq: this.processSeq,
      }));
      this.processSeq += 1;
      return true;
    } catch {
      this.dropped += 1;
      return false;
    }
  }

  async flush(): Promise<void> {
    // Drain until the queue is empty. A flush that resolves while records
    // buffered after its batch splice remain queued would surface those
    // records in a later, unrelated causal window (for example the next
    // test's trace slice), so callers wait for full quiescence. Persistent
    // sink failures stay bounded: the failed batch is re-queued and the loop
    // stops instead of retrying forever.
    for (;;) {
      if (this.flushing !== undefined) {
        await this.flushing;
        continue;
      }
      if (this.queue.length === 0) return;
      this.flushing = this.flushQueuedRecords().finally(() => { this.flushing = undefined; });
      if (!(await this.flushing)) return;
    }
  }

  async close(): Promise<void> { await this.flush(); }

  getHealth(): LivePipelineTraceHealth {
    return {
      enabled: this.enabled,
      emitted: this.emitted,
      sampled: this.sampled,
      dropped: this.dropped,
      unflushed: this.queue.length,
      writeFailures: this.writeFailures,
      rotations: this.rotations,
      currentBytes: this.currentBytes,
      retainedFiles: this.retainedFiles,
      retentionMaxAgeMs: this.maxAgeMs,
      retentionMaxFiles: this.maxRetainedFiles,
    };
  }

  private async flushQueuedRecords(): Promise<boolean> {
    const batch = this.queue.splice(0, this.queue.length);
    const projectedHealth = this.healthMetadata(batch.length, 0);
    let healthRecord: LivePipelineTraceRecord;
    try {
      healthRecord = createLivePipelineTraceRecord({
        process: this.process,
        stage: 'trace.health',
        kind: 'health',
        identifiers: { hostInstance: this.traceRunId },
        health: projectedHealth,
      }, {
        hmacKey: this.hmacKey,
        wallTimestampMs: this.wallClock(),
        monoMs: this.monoClock(),
        runId: this.traceRunId,
        processSeq: this.processSeq,
      });
      this.processSeq += 1;
    } catch {
      this.queue.unshift(...batch);
      this.dropped += 1;
      return false;
    }
    const data = `${[...batch, healthRecord].map((record) => JSON.stringify(record)).join('\n')}\n`;
    const bytes = Buffer.byteLength(data, 'utf8');
    try {
      await this.rotateIfNeeded(bytes);
      await this.sink.append(this.activePath, data);
      this.currentBytes += bytes;
      this.emitted += batch.length;
    } catch {
      this.writeFailures += 1;
      this.queue.unshift(...batch);
      while (this.queue.length > this.maxQueueSize) {
        this.queue.pop();
        this.dropped += 1;
      }
      return false;
    }
    return true;
  }

  private healthMetadata(additionalEmitted: number, unflushed: number): LivePipelineTraceHealthMetadata {
    return {
      emitted: this.emitted + additionalEmitted,
      sampled: this.sampled,
      dropped: this.dropped,
      unflushed,
      writeFailures: this.writeFailures,
      rotations: this.rotations,
      currentBytes: this.currentBytes,
      retainedFiles: this.retainedFiles,
      retentionMaxAgeMs: this.maxAgeMs,
      retentionMaxFiles: this.maxRetainedFiles,
    };
  }

  private async rotateIfNeeded(nextWriteBytes: number): Promise<void> {
    const now = this.wallClock();
    this.currentBytes = Math.max(0, await this.sink.size(this.activePath));
    if (this.maxFileBytes > 0 && this.currentBytes > 0 && this.currentBytes + nextWriteBytes > this.maxFileBytes) {
      const rotatedPath = join(this.directory, `${this.rotatedNamePrefix}${pad(now)}-${pad(this.rotations + 1)}.jsonl`);
      await this.sink.rotate(this.activePath, rotatedPath);
      this.rotations += 1;
      this.currentBytes = 0;
    }
    await this.enforceRetention(now);
  }

  private async enforceRetention(now: number): Promise<void> {
    const names = (await this.sink.list(this.directory))
      .filter((name) => name.startsWith(this.rotatedNamePrefix) && name.endsWith('.jsonl'))
      .sort();
    const survivors: string[] = [];
    for (const name of names) {
      const createdAt = rotatedTimestamp(name, this.rotatedNamePrefix);
      if (this.maxAgeMs > 0 && createdAt !== null && now - createdAt > this.maxAgeMs) {
        await this.sink.remove(join(this.directory, name));
      } else {
        survivors.push(name);
      }
    }
    const excess = Math.max(0, survivors.length - this.maxRetainedFiles);
    for (const name of survivors.slice(0, excess)) await this.sink.remove(join(this.directory, name));
    this.retainedFiles = survivors.length - excess;
  }
}

export function createNodeLivePipelineTraceSink(): LivePipelineTraceSink {
  return {
    async append(filePath, data) { await fs.mkdir(dirname(filePath), { recursive: true }); await fs.appendFile(filePath, data, 'utf8'); },
    async size(filePath) { try { return (await fs.stat(filePath)).size; } catch { return 0; } },
    rotate: fs.rename,
    async list(directory) { try { return await fs.readdir(directory); } catch { return []; } },
    async remove(filePath) { try { await fs.unlink(filePath); } catch { /* best effort */ } },
  };
}

function rotatedTimestamp(name: string, prefix: string): number | null {
  const match = name.slice(prefix.length).match(/^(\d+)-/u);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}
function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : maximum;
}
function pad(value: number): string { return String(Math.max(0, Math.floor(value))).padStart(16, '0'); }
