/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { Tooltip } from '../lib/components/tooltip';

/** The prompt is deliberately plain text: copying it must preserve the task. */
export function SubagentTaskPreview({ task, agent }: { task: string; agent: string }) {
  return (
    <span
      style={{ display: 'contents' }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <Tooltip
        triggerClassName="subagent-task-trigger"
        contentNode={
          <div class="subagent-task-popover">
            <div class="subagent-task-popover-heading">Delegated prompt · {agent}</div>
            <div class="subagent-task-tooltip" tabIndex={0}>{task}</div>
          </div>
        }
        richRole="region"
        returnFocusOnEscape
        freezeWhileVisible
        dismissOnActivation
      >
        <div class="subagent-task" tabIndex={0} aria-label={`Task for ${agent}`}>
          {task}
        </div>
      </Tooltip>
    </span>
  );
}
