/** @jsxRuntime automatic */
/** @jsxImportSource preact */

interface AgentActivityLabelProps {
  label: string;
}

function normalizeActivityLabel(label: string): string {
  return label.trimEnd().replace(/(?:\.\.\.|…)$/, '');
}

export function AgentActivityLabel({ label }: AgentActivityLabelProps) {
  const text = normalizeActivityLabel(label);

  return (
    <span class="agent-activity-label" aria-hidden="true">
      <span class="agent-activity-text">{text}</span>
    </span>
  );
}
