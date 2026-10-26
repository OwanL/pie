/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';
import { writeTextToClipboard } from '../lib/components/clipboard';
import { Tooltip } from '../lib/components/tooltip';

function TaskPrompt({ task, agent }: { task: string; agent: string }) {
  const [copyStatus, setCopyStatus] = useState('Copy');
  return (
    <div class="subagent-task-popover">
      <div class="subagent-task-popover-heading">
        <span class="subagent-task-popover-title">Delegated prompt</span>
        <span class="subagent-task-popover-agent">{agent}</span>
        <button type="button" class="subagent-task-copy" aria-label="Copy delegated prompt" onClick={async () => {
          setCopyStatus(await writeTextToClipboard(task) ? 'Copied' : 'Copy failed');
        }}>{copyStatus}</button>
        <span class="sr-only" role="status">{copyStatus === 'Copy' ? '' : copyStatus}</span>
      </div>
      <div class="subagent-task-tooltip" tabIndex={0} aria-label="Full delegated prompt">{task}</div>
    </div>
  );
}

/** Keep the source prompt unformatted so selection and copying are lossless. */
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
        delayShow={200}
        align="start"
        contentNode={<TaskPrompt task={task} agent={agent} />}
        richRole="region"
        returnFocusOnEscape
        freezeWhileVisible
        dismissOnActivation
      >
        <div class="subagent-task" tabIndex={0} aria-label={`Task for ${agent}`}>
          <span class="subagent-task-excerpt">{task}</span>
          <svg class="subagent-task-inspect" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 3h4v4M7 9l6-6" /></svg>
        </div>
      </Tooltip>
    </span>
  );
}
