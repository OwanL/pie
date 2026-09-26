/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { SystemPromptMessage } from '../../context-inspector/system-prompts';
import { registerRowRenderer, type RowRendererProps } from '../registry';

function renderSystemPrompts({ systemPrompts }: RowRendererProps) {
  return <SystemPromptMessage prompts={systemPrompts} />;
}

registerRowRenderer('systemPrompts', renderSystemPrompts);
