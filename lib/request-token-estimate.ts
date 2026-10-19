import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';

const LITERAL_OPTIONS = { disallowedSpecial: new Set<string>() };
const countCl100k = (text: string) => (text ? encodeCl100k(text, LITERAL_OPTIONS).length : 0);

function countModern(text: string): number {
  return text ? encodeO200k(text, LITERAL_OPTIONS).length : 0;
}

/** Approximate prefix content only, not exact provider counts or chat/tool
 * framing. Provider usage remains authoritative. Unknown models
 * retain the compact-JSON/cl100k basis; recognized modern OpenAI models use
 * literal o200k text and unfitted TypeScript-like tool declarations. */
export interface RequestEstimateModel {
  id?: string;
  provider?: string;
  api?: string;
}

export interface RequestEstimateTool {
  name: string;
  description?: string;
  parameters?: unknown;
}

function modernModel(model?: RequestEstimateModel): boolean {
  return !!model?.id && /^(?:gpt-(?:4o|4\.1|5|6)|o[134])(?:$|[-.])/.test(model.id)
    && !!model.provider && ['openai', 'openai-codex', 'github-copilot'].includes(model.provider)
    && (model.api === undefined || ['openai-completions', 'openai-responses', 'openai-codex-responses'].includes(model.api));
}

function compactTokens(tools: readonly RequestEstimateTool[], count = countCl100k): number {
  try {
    return count(JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))) ?? '[unserializable]');
  } catch {
    return count('[unserializable]');
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
const spelling = (name: string) => /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
const comment = (text: string, indent: string) => text.split(/\r\n|[\n\r\u2028\u2029]/).map(line => `${indent}// ${line}\n`).join('');

/** JSON-safe annotation values: anything else (functions, undefined members,
 * non-finite numbers) falls back to compact JSON instead of being dropped. */
function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  if (record(value)) return Object.values(value).every(jsonValue);
  return false;
}
const nonNegativeInteger = (value: unknown): boolean => Number.isInteger(value) && (value as number) >= 0;
const finiteNumber = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value);

/** Recognized bounded annotations, validated and rendered as one compact TS
 * comment line before the annotated member with the standard schema key
 * names. Values must fit their member's type (minItems on arrays, lengths on
 * strings, bounds on numbers) — otherwise the schema falls back to compact
 * JSON instead of rendering a misleading member. The recorded Codex-route
 * decomposition (ask_user variants 2026-10-19) shows the provider charges
 * real tokens for each annotation class, so the full labels track it more
 * closely than abbreviated aliases; unrecognized keys still fall back. */
const annotations: readonly [key: string, alias: string, check: (value: unknown, type: string) => boolean][] = [
  ['minItems', 'minItems', (value, type) => type === 'array' && nonNegativeInteger(value)],
  ['maxItems', 'maxItems', (value, type) => type === 'array' && nonNegativeInteger(value)],
  ['minLength', 'minLength', (value, type) => type === 'string' && nonNegativeInteger(value)],
  ['maxLength', 'maxLength', (value, type) => type === 'string' && nonNegativeInteger(value)],
  ['minimum', 'minimum', (value, type) => (type === 'number' || type === 'integer') && finiteNumber(value)],
  ['maximum', 'maximum', (value, type) => (type === 'number' || type === 'integer') && finiteNumber(value)],
  ['default', 'default', jsonValue],
];

function annotationComment(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, alias, check] of annotations) {
    const item = value[key];
    if (item === undefined) continue;
    if (!check(item, value.type as string)) throw new Error(`Unsupported ${key}`);
    parts.push(`${alias}: ${JSON.stringify(item)}`);
  }
  return parts.length ? `// ${parts.join(', ')}\n` : '';
}

/** Strict supported subset: unknown constraints are never silently discarded.
 * additionalProperties:false is the benchmark's closed-object declaration
 * convention. Other additional-property policies use compact JSON instead.
 * Recognized annotations (see `annotations`) render as compact comments;
 * array-item and root descriptions render inside the type brackets instead of
 * being silently ignored. Structural rendering stays unindented at every
 * depth (measured against provider usage) while preserving Array<T>, comments
 * and newlines. */
function schemaType(value: unknown, ancestors = new Set<object>(), headerPosition = false): string {
  if (!record(value) || ancestors.has(value) || ancestors.size > 100) throw new Error('Unsupported schema');
  ancestors.add(value);
  try {
    const allowed = ['type', 'description', 'enum', ...annotations.map(([key]) => key)];
    if (value.type === 'object') allowed.push('properties', 'required', 'additionalProperties');
    if (value.type === 'array') allowed.push('items');
    if (Object.keys(value).some(key => !allowed.includes(key)) || (value.description !== undefined && typeof value.description !== 'string')) throw new Error('Unsupported schema');
    if (!['string', 'integer', 'number', 'boolean', 'null', 'object', 'array'].includes(value.type as string)) throw new Error('Unsupported type');
    const header = headerPosition ? (value.description !== undefined ? comment(value.description as string, '') : '') + annotationComment(value) : '';
    if (value.enum !== undefined) {
      if (!['string', 'integer', 'number', 'boolean', 'null'].includes(value.type as string) || !Array.isArray(value.enum) || !value.enum.length
        || value.enum.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item)
          || typeof item === 'number' && !Number.isFinite(item)
          || (value.type === 'null' ? item !== null : value.type === 'integer' ? !Number.isInteger(item) : typeof item !== value.type))) throw new Error('Unsupported enum');
      return header + value.enum.map(item => JSON.stringify(item)).join(' | ');
    }
    // Root calls and array items carry their own description/annotations
    // header; property members get theirs from the enclosing object render.
    if (value.type === 'array') {
      const inner = schemaType(value.items, ancestors, true);
      return header + (inner.startsWith('//') ? `Array<\n${inner}>` : `Array<${inner}>`);
    }
    if (value.type === 'object') {
      const properties = value.properties === undefined ? {} : value.properties;
      const required = value.required === undefined ? [] : value.required;
      if (!record(properties) || !Array.isArray(required) || required.some(key => typeof key !== 'string' || !Object.hasOwn(properties, key))
        || (value.additionalProperties !== undefined && value.additionalProperties !== false)) throw new Error('Unsupported object');
      return header + '{\n' + Object.entries(properties).map(([key, child]) => {
        const type = schemaType(child, ancestors);
        const description = (child as Record<string, unknown>).description;
        return (description !== undefined ? comment(description as string, '') : '') + annotationComment(child as Record<string, unknown>)
          + spelling(key) + (required.includes(key) ? '' : '?') + ': ' + type + ',\n';
      }).join('') + '}';
    }
    return header + (value.type === 'integer' ? 'number' : value.type);
  } finally {
    ancestors.delete(value);
  }
}

/** Count definitions in input order, excluding SDK bookkeeping fields. Empty
 * lists cost zero. Unsupported schemas retain their whole compact JSON using
 * the model's tokenizer, independently of supported neighboring tools.
 * Recognized modern routes frame all tools with one tools block: the measured
 * ~12-token block-overhead (recorded single-tool deltas 11–15; cookbook 12)
 * counts once per request, never per tool, and empty tool lists cost zero. */
export function estimateToolDefinitionsTokens(tools: readonly RequestEstimateTool[], model?: RequestEstimateModel): number {
  if (!tools.length) return 0;
  if (!modernModel(model)) return compactTokens(tools);
  const TOOLS_BLOCK_OVERHEAD = 12;
  return tools.reduce((total, tool) => {
    try {
      if (typeof tool.name !== 'string' || (tool.description !== undefined && typeof tool.description !== 'string')) throw new Error('Malformed tool');
      const declaration = comment(tool.description ?? '', '') + 'type ' + spelling(tool.name) + ' = (_: ' + schemaType(tool.parameters, new Set<object>(), true) + ') => any;';
      return total + countModern(declaration);
    } catch {
      return total + compactTokens([tool], countModern);
    }
  }, TOOLS_BLOCK_OVERHEAD);
}

/** Prompt whitespace and reserved-token spellings are ordinary literal text. */
export function estimateRequestPrefixTokens(systemPrompt: string, tools: readonly RequestEstimateTool[], model?: RequestEstimateModel): number {
  return (modernModel(model) ? countModern(systemPrompt) : countCl100k(systemPrompt)) + estimateToolDefinitionsTokens(tools, model);
}
