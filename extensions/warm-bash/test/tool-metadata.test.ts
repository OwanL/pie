import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerWarmBashTool } from '../src/tool-metadata.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sdkEntry = path.resolve(
  __dirname,
  '../../../extension/node_modules/@earendil-works/pi-coding-agent/dist/index.js',
);

type ToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: {
    properties: Record<string, Record<string, unknown>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

test('registered bash metadata documents the effective timeout without changing its schema', async () => {
  const { createBashTool } = await import(pathToFileURL(sdkEntry).href) as {
    createBashTool: (cwd: string) => ToolDefinition;
  };
  const baseTool = createBashTool(process.cwd());
  let registeredTool: ToolDefinition | undefined;

  registerWarmBashTool(
    { registerTool: (tool) => { registeredTool = tool; } },
    baseTool,
    async () => ({ content: [], details: {} }),
  );

  assert.ok(registeredTool, 'warm-bash registers its bash override');
  assert.equal(registeredTool.name, baseTool.name);
  assert.equal(registeredTool.label, baseTool.label);
  assert.ok(registeredTool.description.startsWith(baseTool.description));
  assert.match(registeredTool.description, /60 seconds.*PIE_BASH_DEFAULT_TIMEOUT/u);
  assert.match(registeredTool.description, /capped at 600 seconds/u);
  assert.match(registeredTool.description, /nonpositive values use the default/u);

  const inheritedTimeout = baseTool.parameters.properties.timeout;
  const registeredTimeout = registeredTool.parameters.properties.timeout;
  assert.match(String(registeredTimeout.description), /Defaults to 60 seconds/u);
  assert.match(String(registeredTimeout.description), /PIE_BASH_DEFAULT_TIMEOUT/u);
  assert.match(String(registeredTimeout.description), /capped at 600 seconds/u);
  assert.match(String(registeredTimeout.description), /nonpositive values use the default/u);

  const { description: _inheritedDescription, ...inheritedTimeoutSchema } = inheritedTimeout;
  const { description: _registeredDescription, ...registeredTimeoutSchema } = registeredTimeout;
  assert.deepEqual(registeredTimeoutSchema, inheritedTimeoutSchema, 'timeout validation schema is otherwise unchanged');
  assert.deepEqual(
    registeredTool.parameters.properties.command,
    baseTool.parameters.properties.command,
    'command validation schema is unchanged',
  );
  const { properties: _inheritedProperties, ...inheritedParameters } = baseTool.parameters;
  const { properties: _registeredProperties, ...registeredParameters } = registeredTool.parameters;
  assert.deepEqual(registeredParameters, inheritedParameters, 'top-level parameter validation is unchanged');
});
