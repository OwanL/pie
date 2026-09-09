import type { RuntimeIdentity, PublishedRuntimeGeneration, RuntimeGeneration } from '../runtime/runtime-generations.cjs';
export function publishRuntimeGeneration(options: { sourceOutDir: string; extensionDir: string; identity: RuntimeIdentity }): Promise<PublishedRuntimeGeneration>;
export function resolveRuntimeGeneration(options: { extensionDir: string; identity: RuntimeIdentity }): Promise<RuntimeGeneration>;
export function hasRuntimeBootstrap(extensionDir: string): Promise<boolean>;
export function installRuntimeBootstrap(options: { extensionDir: string; pkg: RuntimeIdentity & Record<string, unknown> }): Promise<string>;
