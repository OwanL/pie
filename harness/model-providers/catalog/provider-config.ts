// Management configuration only; reading does not activate runtime models.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseDocument, visit, isAlias, isScalar, type Document } from 'yaml';
import Ajv from 'ajv';
// The checked-in JSON schema is the sole runtime validation authority, embedded by bundlers.
import schema from './provider-config.schema.json';
const validator: {
  (value: unknown): boolean;
  errors?: { keyword: string; instancePath: string; message?: string; params: { additionalProperty?: string } }[] | null;
} =
  new Ajv({ allErrors: true, strict: true }).compile(schema);

/** Protocol choices come from the sole runtime schema authority. */
export const providerProtocolOptions: readonly string[] = Object.freeze([...schema.definitions.provider.properties.api.enum]);

export type ProviderApi = 'openai-completions' | 'mistral-conversations' | 'openai-responses'
  | 'azure-openai-responses' | 'openai-codex-responses' | 'anthropic-messages'
  | 'bedrock-converse-stream' | 'google-generative-ai' | 'google-vertex';
export type PricingRates = { input: number; output: number; cacheRead?: number; cacheWrite?: number };
export type ProviderPricing = 'unknown' | (PricingRates & {
  tiers?: (Required<PricingRates> & { inputTokensAbove: number })[];
});
export interface ProviderModelOverride {
  name?: string;
  input?: ('text' | 'image')[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  pricing?: ProviderPricing;
}
export interface ProviderEntry {
  enabled: boolean;
  /** Explicit removal masks inherited inventory; must remain disabled. */
  removed?: true;
  /** Omitted for built-in providers whose integration supplies the protocol. */
  api?: ProviderApi;
  baseUrl?: string;
  credentialRef?: { source: 'saved' } | { source: 'legacy' } | { source: 'environment'; name: string } | { source: 'none' };
  manualModels?: string[];
  modelOverrides?: Record<string, ProviderModelOverride>;
  modelPreferences?: Record<string, { visible?: boolean; subagentEligible?: boolean }>;
}
export interface ProviderConfig { version: 1; providers: Record<string, ProviderEntry> }
export type ProviderConfigDiagnostic = {
  code: 'yaml-invalid' | 'schema-invalid' | 'unreadable';
  message: string;
  issues?: { path: string; message: string }[];
};
export type ProviderConfigValidation =
  | { status: 'valid'; config: ProviderConfig }
  | { status: 'invalid'; diagnostic: ProviderConfigDiagnostic };
export type ProviderConfigReadResult =
  | (Extract<ProviderConfigValidation, { status: 'valid' }> & { revision: string })
  | Extract<ProviderConfigValidation, { status: 'invalid' }>
  | { status: 'missing'; config: ProviderConfig; revision: null }
  | { status: 'unreadable'; diagnostic: ProviderConfigDiagnostic };

export function validateProviderConfig(value: unknown): ProviderConfigValidation {
  if (validator(value)) return { status: 'valid', config: value as ProviderConfig };
  // Identify fields and rules, never their supplied values or document excerpts.
  const issues = (validator.errors ?? []).map(error => ({
    path: error.instancePath || '/',
    message: error.params.additionalProperty === undefined
      ? error.message ?? 'Schema validation failed.'
      : `Unknown field: ${error.params.additionalProperty}`,
  }));
  return { status: 'invalid', diagnostic: {
    code: 'schema-invalid', message: 'Provider configuration does not match the version 1 schema.', issues,
  } };
}

/** Shared reader/editor parser; validate mapping keys before lossy object projection. */
export function parseProviderConfigDocument(text: string):
  | { status: 'valid'; config: ProviderConfig; document: Document.Parsed }
  | Extract<ProviderConfigValidation, { status: 'invalid' }> {
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length > 0 || document.warnings.length > 0) throw new Error('Invalid YAML');
    let validKeys = true;
    let validValues = true;
    visit(document, {
      Map(_key, node) {
        if (node.tag && node.tag !== 'tag:yaml.org,2002:map') {
          validValues = false;
          return visit.BREAK;
        }
        const keys = new Set<string>();
        for (const pair of node.items) {
          const key = isAlias(pair.key) ? pair.key.resolve(document) : pair.key;
          if (!isScalar(key) || typeof key.value !== 'string' || keys.has(key.value)) {
            validKeys = false;
            return visit.BREAK;
          }
          keys.add(key.value);
        }
      },
      Seq(_key, node) {
        if (node.tag && node.tag !== 'tag:yaml.org,2002:seq') {
          validValues = false;
          return visit.BREAK;
        }
      },
      Scalar(_key, node) {
        const value = node.value;
        if (value !== null && typeof value !== 'string' && typeof value !== 'boolean'
          && !(typeof value === 'number' && Number.isFinite(value))) {
          validValues = false;
          return visit.BREAK;
        }
      },
    });
    if (!validValues) return { status: 'invalid', diagnostic: {
      code: 'yaml-invalid', message: 'Provider configuration YAML requires JSON-compatible values.',
    } };
    if (!validKeys) return { status: 'invalid', diagnostic: {
      code: 'yaml-invalid', message: 'Provider configuration YAML requires unique string mapping keys.',
    } };
    const validated = validateProviderConfig(document.toJS({ maxAliasCount: 100 }));
    return validated.status === 'valid' ? { ...validated, document } : validated;
  } catch {
    return { status: 'invalid', diagnostic: { code: 'yaml-invalid', message: 'Provider configuration is not valid YAML.' } };
  }
}

export function parseProviderConfig(text: string): ProviderConfigValidation {
  const parsed = parseProviderConfigDocument(text);
  return parsed.status === 'valid' ? { status: 'valid', config: parsed.config } : parsed;
}

/** Revision of the complete UTF-8 document, including comments and formatting. */
export function providerConfigRevision(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Reads only the explicit caller-selected path. No defaults, writes, credentials or discovery. */
export async function readProviderConfig(
  configPath: string,
  io: { readFile: (path: string, encoding: 'utf8') => Promise<string> } = { readFile },
): Promise<ProviderConfigReadResult> {
  let text: string;
  try {
    text = await io.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { status: 'missing', config: { version: 1, providers: {} }, revision: null };
    }
    return { status: 'unreadable', diagnostic: { code: 'unreadable', message: 'Provider configuration could not be read.' } };
  }
  const parsed = parseProviderConfig(text);
  return parsed.status === 'valid' ? { ...parsed, revision: providerConfigRevision(text) } : parsed;
}
