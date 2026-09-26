import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import {
  ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION,
  ActivationManifestError,
  isAnalyticsRestartNonce,
  type AnalyticsBackendDescriptor,
  type AnalyticsLoadedGenerationReceipt,
  validateAnalyticsLoadedGenerationReceipt,
} from './activation.js';
import { ActivationStore, type ActivationReadResult } from './activation-store.js';

/** Written by a host that completed canonical readiness, so post-restart
 * evidence can show which generation is loaded rather than only which one the
 * manifest records. */
export const LOADED_GENERATION_FILENAME = 'analytics-loaded-generation-v1.json';
export const TERMINAL_RESTART_RECEIPT_KIND = 'pie-p7-terminal-restart-v1' as const;

export interface AnalyticsTerminalRestartReceipt {
  readonly schemaVersion: 1;
  readonly kind: typeof TERMINAL_RESTART_RECEIPT_KIND;
  readonly status: 'ready';
  readonly generationId: string;
  readonly buildId: string;
  readonly restartNonce: string;
  readonly hostInstanceId: string;
  readonly processId: number;
  readonly loadedAt: string;
  readonly verifiedAt: string;
}

export function writeLoadedGenerationReceiptAtomically(
  stateDir: string,
  payload: AnalyticsLoadedGenerationReceipt,
  destination = path.join(stateDir, LOADED_GENERATION_FILENAME),
): void {
  if (!path.isAbsolute(destination) || destination.length > 4_096) {
    throw new ActivationManifestError('Loaded-generation receipt path is missing or invalid.');
  }
  const temporary = path.join(stateDir, `.${LOADED_GENERATION_FILENAME}.${process.pid}-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  let descriptor: number | undefined;
  try {
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
    descriptor = openSync(temporary, 'r+');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

/** Write terminal evidence at the exact helper-provided destination. */
export function writeTerminalRestartReceiptAtomically(
  destination: string,
  payload: AnalyticsTerminalRestartReceipt,
): void {
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}-${randomUUID()}.tmp`);
  const bytes = `${JSON.stringify(payload, null, 2)}\n`;
  let descriptor: number | undefined;
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx' });
    descriptor = openSync(temporary, 'r+');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    throw error;
  }
}

export type AnalyticsRuntimeActivationSnapshot = Pick<
  ActivationReadResult,
  'manifest' | 'sha256' | 'authority'
>;

export interface AnalyticsRuntimeAuthorityOptions {
  stateDir: string;
  workspaceId: string;
  processGeneration: string;
  buildId: string;
  manifestBuildId?: string;
  activationSnapshot?: AnalyticsRuntimeActivationSnapshot;
  restartNonce?: string | null;
  terminalRestartReceiptPath?: string;
  loadedGenerationPath?: string;
  onError?: (error: unknown, stage: string) => void;
}

/** Owns the validated activation snapshot and its durable loaded/terminal
 * evidence. Helper lifecycle and application drain remain in composition. */
export class AnalyticsRuntimeAuthority {
  private readonly store: ActivationStore;
  private descriptor: AnalyticsBackendDescriptor | undefined;
  private loadedGeneration: AnalyticsLoadedGenerationReceipt | undefined;

  constructor(private readonly options: AnalyticsRuntimeAuthorityOptions) {
    this.store = new ActivationStore({ stateDir: options.stateDir });
    if (options.restartNonce !== undefined && options.restartNonce !== null
      && !isAnalyticsRestartNonce(options.restartNonce)) {
      throw new ActivationManifestError('Analytics restart correlation nonce has an invalid format or exceeds 128 bytes.');
    }
  }

  readActivation(): AnalyticsRuntimeActivationSnapshot {
    const read = this.store.read();
    return { manifest: read.manifest, sha256: read.sha256, authority: read.authority };
  }

  activeDescriptor(): AnalyticsBackendDescriptor {
    if (this.descriptor) return this.descriptor;
    return this.descriptorFromActivation(this.readActivation());
  }

  descriptorFromActivation(activation: AnalyticsRuntimeActivationSnapshot): AnalyticsBackendDescriptor {
    const { manifest, sha256, authority } = activation;
    if (authority !== 'canonical' || !manifest?.activeGeneration || !sha256) {
      throw new ActivationManifestError('No active canonical analytics generation is recorded.');
    }
    return Object.freeze({
      generationId: manifest.activeGeneration.identity.generationId,
      buildId: manifest.activeGeneration.identity.buildId,
      manifestRevision: manifest.revision,
      manifestSha256: sha256,
      workspaceId: this.options.workspaceId,
      hostInstanceId: this.options.processGeneration,
    });
  }

  assertStartupActivationUnchanged(current: AnalyticsRuntimeActivationSnapshot): void {
    const expected = this.options.activationSnapshot;
    if (!expected) return;
    if (expected.authority !== current.authority
      || expected.sha256 !== current.sha256
      || (expected.manifest?.revision ?? null) !== (current.manifest?.revision ?? null)) {
      throw new ActivationManifestError(
        'Analytics activation changed during host startup; refusing to mix authority snapshots.',
      );
    }
  }

  setDescriptor(descriptor: AnalyticsBackendDescriptor): void {
    this.descriptor = descriptor;
  }

  clearDescriptor(): void {
    this.descriptor = undefined;
  }

  backendDescriptor(canonicalReady: boolean): AnalyticsBackendDescriptor | undefined {
    return canonicalReady ? this.descriptor : undefined;
  }

  recordLoadedGeneration(canonicalReady: boolean): void {
    if (!canonicalReady) return;
    try {
      const descriptor = this.descriptor;
      if (!descriptor) return;
      const current = this.readActivation();
      if (current.authority !== 'canonical'
        || current.sha256 !== descriptor.manifestSha256
        || current.manifest?.revision !== descriptor.manifestRevision
        || current.manifest.activeGeneration?.identity.generationId !== descriptor.generationId) {
        this.options.onError?.(
          new ActivationManifestError('Analytics activation changed before loaded evidence could be recorded.'),
          'loaded-generation',
        );
        return;
      }
      const payload = validateAnalyticsLoadedGenerationReceipt({
        schemaVersion: ANALYTICS_LOADED_GENERATION_SCHEMA_VERSION,
        generationId: descriptor.generationId,
        buildId: descriptor.buildId,
        manifestRevision: descriptor.manifestRevision,
        manifestSha256: descriptor.manifestSha256,
        workspaceId: descriptor.workspaceId,
        hostInstanceId: descriptor.hostInstanceId,
        restartNonce: this.options.restartNonce ?? null,
        loadedAt: new Date().toISOString(),
      });
      mkdirSync(this.options.stateDir, { recursive: true });
      writeLoadedGenerationReceiptAtomically(
        this.options.stateDir,
        payload,
        this.options.loadedGenerationPath,
      );
      this.loadedGeneration = payload;
    } catch {
      // Diagnostic only. Never fail a working activation over this record.
    }
  }

  recordTerminalRestartReceipt(canonicalReady: boolean): void {
    if (!canonicalReady || this.options.restartNonce === null
      || this.options.restartNonce === undefined) return;
    const destination = this.options.terminalRestartReceiptPath;
    if (!destination || !path.isAbsolute(destination) || destination.length > 4_096) {
      throw new ActivationManifestError('Terminal restart receipt path is missing or invalid.');
    }
    const loaded = this.loadedGeneration;
    const descriptor = this.descriptor;
    if (!loaded || !descriptor || loaded.restartNonce !== this.options.restartNonce) {
      throw new ActivationManifestError('Loaded-generation evidence is missing for the terminal restart receipt.');
    }
    const current = this.readActivation();
    this.assertStartupActivationUnchanged(current);
    if (current.authority !== 'canonical'
      || current.sha256 !== descriptor.manifestSha256
      || current.manifest?.revision !== descriptor.manifestRevision
      || current.manifest.activeGeneration?.identity.generationId !== descriptor.generationId) {
      throw new ActivationManifestError('Analytics activation changed before terminal restart evidence could be recorded.');
    }
    const payload: AnalyticsTerminalRestartReceipt = {
      schemaVersion: 1,
      kind: TERMINAL_RESTART_RECEIPT_KIND,
      status: 'ready',
      generationId: descriptor.generationId,
      buildId: descriptor.buildId,
      restartNonce: this.options.restartNonce,
      hostInstanceId: descriptor.hostInstanceId,
      processId: process.pid,
      loadedAt: loaded.loadedAt,
      verifiedAt: new Date().toISOString(),
    };
    writeTerminalRestartReceiptAtomically(destination, payload);
  }
}

/** Stable workspace identity helper shared by capture and the descriptor. */
export function analyticsWorkspaceId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 32);
}
