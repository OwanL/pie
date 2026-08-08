/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { ToolCallCard } from '../tool-call-card';
import { getToolCallContextType } from '../../chat-prefs';
import { registerToolRenderer, type ToolRendererProps } from '../registry';

function renderDefaultTool({ toolCall, prefs, workingDirectory, onOpenFile, onContextMenu }: ToolRendererProps) {
  const contextType = getToolCallContextType(toolCall.name);
  const handleContextMenu = (e: MouseEvent) => onContextMenu(
    contextType,
    JSON.stringify(toolCall, null, 2),
    e,
  );

  return (
    <ToolCallCard
      toolCall={toolCall}
      autoExpand={prefs.autoExpandToolCalls}
      activityTailLines={prefs.activityTailLines}
      workingDirectory={workingDirectory}
      prefs={prefs}
      onOpenFile={onOpenFile}
      onContextMenu={handleContextMenu}
    />
  );
}

// Register as the fallback '__default' renderer
registerToolRenderer('__default', renderDefaultTool);
