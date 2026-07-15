type CopilotApi = 'anthropic-messages' | 'openai-completions' | 'openai-responses';

export const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
} as const;

type UnknownRecord = Record<string, unknown>;

export interface DiscoveredCopilotModel {
  id: string;
  name: string;
  api: CopilotApi;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: Array<'text' | 'image'>;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: Array<{
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }>;
  };
  contextWindow: number;
  maxTokens: number;
  compat?: UnknownRecord;
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function price(value: unknown): number {
  // Copilot reports integer US cents per one million tokens.
  return (finiteNumber(value) ?? 0) / 100;
}

function rates(value: unknown) {
  const source = record(value);
  return {
    input: price(source?.input_price),
    output: price(source?.output_price),
    cacheRead: price(source?.cache_price),
    cacheWrite: price(source?.cache_write_price),
  };
}

function chooseApi(vendor: unknown, endpoints: unknown): CopilotApi {
  const values = Array.isArray(endpoints) ? endpoints.filter((item): item is string => typeof item === 'string') : [];
  if (vendor === 'Anthropic' && values.includes('/v1/messages')) return 'anthropic-messages';
  if (values.includes('/responses')) return 'openai-responses';
  return 'openai-completions';
}

function thinkingMap(value: unknown): Record<string, string | null> | undefined {
  if (!Array.isArray(value)) return undefined;
  const supported = new Set(value.filter((item): item is string => typeof item === 'string'));
  if (supported.size === 0) return undefined;

  const result: Record<string, string | null> = {};
  // Match pi's built-in Copilot catalog: reasoning models do not expose an
  // off level even when the endpoint calls the lowest effort "none".
  if (supported.has('none')) result.off = null;
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    if (supported.has(level)) result[level] = level;
  }
  if (!('minimal' in result) && supported.has('low')) result.minimal = 'low';
  return result;
}

export function isSelectableCopilotModel(value: unknown): boolean {
  const item = record(value);
  const policy = record(item?.policy);
  const supports = record(record(item?.capabilities)?.supports);
  return item?.model_picker_enabled === true && policy?.state !== 'disabled' && supports?.tool_calls !== false;
}

export function toDiscoveredCopilotModel(value: unknown): DiscoveredCopilotModel | undefined {
  if (!isSelectableCopilotModel(value)) return undefined;
  const item = record(value)!; // isSelectableCopilotModel already requires a record.
  const id = item.id;
  if (typeof id !== 'string' || id.length === 0) return undefined;

  const capabilities = record(item.capabilities);
  const limits = record(capabilities?.limits);
  const supports = record(capabilities?.supports);
  const effortMap = thinkingMap(supports?.reasoning_effort);
  const api = chooseApi(item.vendor, item.supported_endpoints);
  const defaultPricing = record(record(item.billing)?.token_prices)?.default;
  const longPricing = record(record(item.billing)?.token_prices)?.long_context;
  const defaultRates = rates(defaultPricing);
  const threshold = finiteNumber(record(defaultPricing)?.context_max);
  const longRates = rates(longPricing);

  const cost: DiscoveredCopilotModel['cost'] = { ...defaultRates };
  if (longPricing && threshold !== undefined) {
    cost.tiers = [{ inputTokensAbove: threshold, ...longRates }];
  }

  let compat: UnknownRecord | undefined;
  if (api === 'anthropic-messages') {
    compat = {
      supportsEagerToolInputStreaming: false,
      ...(effortMap ? { forceAdaptiveThinking: true } : {}),
    };
  } else if (api === 'openai-completions') {
    compat = {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: effortMap !== undefined,
    };
  }

  return {
    id,
    name: typeof item.name === 'string' && item.name.length > 0 ? item.name : id,
    api,
    reasoning: effortMap !== undefined,
    ...(effortMap ? { thinkingLevelMap: effortMap } : {}),
    input: supports?.vision === true ? ['text', 'image'] : ['text'],
    cost,
    contextWindow: finiteNumber(limits?.max_context_window_tokens) ?? 128_000,
    maxTokens: finiteNumber(limits?.max_output_tokens) ?? 16_384,
    ...(compat ? { compat } : {}),
  };
}

export function parseCopilotModelsResponse(value: unknown): DiscoveredCopilotModel[] {
  const data = record(value)?.data;
  if (!Array.isArray(data)) throw new Error('Invalid Copilot models response');
  return data.flatMap((item) => {
    const model = toDiscoveredCopilotModel(item);
    return model ? [model] : [];
  });
}
