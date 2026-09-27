export interface RuntimeIdentity {
  publisher: string;
  name: string;
  version: string;
}

export interface RuntimeGeneration {
  generation: string | null;
  outDir: string;
  publishedAt: number;
}

export interface PublishedRuntimeGeneration {
  generation: string;
  outDir: string;
  publishedAt: number;
}

export interface RuntimeLease extends RuntimeGeneration {
  release(): Promise<void>;
}

export function publishRuntimeGeneration(options: {
  sourceOutDir: string;
  extensionDir: string;
  identity: RuntimeIdentity;
  beforeSelect?: (publication: PublishedRuntimeGeneration) => void | Promise<void>;
}): Promise<PublishedRuntimeGeneration>;

export function resolveRuntimeGeneration(options: {
  extensionDir: string;
  identity: RuntimeIdentity;
}): Promise<RuntimeGeneration>;

export function acquireRuntimeGeneration(options: {
  extensionDir: string;
  identity: RuntimeIdentity;
}): Promise<RuntimeLease>;
