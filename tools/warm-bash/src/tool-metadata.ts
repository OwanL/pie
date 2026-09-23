/** Override only bash timeout documentation while preserving the SDK schema. */

export const BASH_DEFAULT_TIMEOUT = 60;
export const BASH_MAX_TIMEOUT = 600;

const BASH_TIMEOUT_DESCRIPTION =
  `Timeout in seconds. Defaults to ${BASH_DEFAULT_TIMEOUT} seconds (configurable via PIE_BASH_DEFAULT_TIMEOUT); nonpositive values use the default, and timeouts are capped at ${BASH_MAX_TIMEOUT} seconds.`;

const BASH_TIMEOUT_TOOL_GUIDANCE =
  ` Timeout defaults to ${BASH_DEFAULT_TIMEOUT} seconds (configurable via PIE_BASH_DEFAULT_TIMEOUT); explicit timeouts are capped at ${BASH_MAX_TIMEOUT} seconds, and nonpositive values use the default.`;

type SchemaProperty = Record<string, unknown>;

type BashToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: {
    properties: Record<string, SchemaProperty>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type ToolRegistrar = {
  registerTool(tool: BashToolDefinition & { execute: (...args: any[]) => Promise<unknown> }): void;
};

/** Register the SDK bash tool with accurate timeout metadata, keeping every
 * inherited schema field and validation rule unchanged. */
export function registerWarmBashTool(
  pi: ToolRegistrar,
  baseTool: BashToolDefinition,
  execute: (...args: any[]) => Promise<unknown>,
): void {
  const timeoutSchema = baseTool.parameters.properties.timeout;
  pi.registerTool({
    ...baseTool,
    description: `${baseTool.description}${BASH_TIMEOUT_TOOL_GUIDANCE}`,
    parameters: {
      ...baseTool.parameters,
      properties: {
        ...baseTool.parameters.properties,
        timeout: {
          ...timeoutSchema,
          description: BASH_TIMEOUT_DESCRIPTION,
        },
      },
    },
    execute,
  });
}
