/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { ToolCallCard } from '../tool-call-card';
import { getToolCallContextType } from '../../shell/chat-prefs';
import { handleDelegatedFilePathContextMenu } from '../file-path-interactions';
import { registerToolRenderer, type ToolRendererProps } from '../registry';

function renderDefaultTool({ toolCall, prefs, workingDirectory, onOpenFile, onContextMenu }: ToolRendererProps) {
  const contextType = getToolCallContextType(toolCall.name);
  const handleContextMenu = (e: MouseEvent) => {
    if (handleDelegatedFilePathContextMenu(e, workingDirectory, onContextMenu)) return;
    onContextMenu(
      contextType,
      JSON.stringify(toolCall, null, 2),
      e,
    );
  };

  return (
    <ToolCallCard
      toolCall={toolCall}
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
