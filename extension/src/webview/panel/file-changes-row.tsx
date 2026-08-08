/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { FileChangeKind } from '../../shared/protocol';
import { KIND_LABEL } from './file-changes-stats';
import { formatPathWithParentDepth } from './file-path';

export function LineStats({
  additions,
  deletions,
  path,
  onDiff,
}: {
  additions?: number;
  deletions?: number;
  path: string;
  onDiff: () => void;
}) {
  if (!additions && !deletions) return null;
  return (
    <button
      class="file-change-stats"
      type="button"
      aria-label={`View diff of ${path}`}
      title={`Open diff: ${path}`}
      onClick={onDiff}
    >
      <span class="stat-additions">{additions ? `+${additions}` : ''}</span>
      <span class="stat-deletions">{deletions ? `-${deletions}` : ''}</span>
    </button>
  );
}

export function FileName({
  path,
  kind,
  disabled,
  parentDepth,
  onClick,
}: {
  path: string;
  kind: FileChangeKind;
  disabled?: boolean;
  parentDepth?: number;
  onClick: () => void;
}) {
  const displayPath = parentDepth !== undefined ? formatPathWithParentDepth(path, parentDepth) : path;
  const parts = displayPath.split('/');
  const name = parts.pop() ?? displayPath;
  const dir = parts.join('/');
  const label = disabled
    ? `${KIND_LABEL[kind]}: ${path} (deleted)`
    : `${KIND_LABEL[kind]}: open ${path} in the editor`;
  // The full path — directory prefix + basename — is the open-in-editor
  // hitbox, so the path-text itself is the <button>; dir and name are spans
  // inside it. Hovering anywhere on the path underlines it (CSS) so the
  // click target is discoverable across the whole path, not just the name.
  return (
    <button
      class="file-change-path-text"
      type="button"
      disabled={disabled}
      aria-label={label}
      title={disabled ? `Deleted — ${path}` : `Open ${path} in the editor`}
      onClick={onClick}
    >
      {dir ? <span class="file-change-dir">{dir}/</span> : null}
      <span class="file-change-name">{name}</span>
    </button>
  );
}
