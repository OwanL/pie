import { readFile } from 'node:fs/promises';

import { MAX_OBSERVATION_BYTES, type RuntimeResponse } from './types.js';

export function truncateUtf8(text: string, maxBytes = MAX_OBSERVATION_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text, truncated: false };
  const suffix = '\n[result text truncated]';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix));
  const source = Buffer.from(text);
  let end = budget;
  while (end > 0 && (source[end] & 0xc0) === 0x80) end -= 1;
  return { text: source.subarray(0, end).toString('utf8') + suffix, truncated: true };
}

function line(label: string, value: unknown): string | null {
  return value === undefined ? null : `${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`;
}

function eventLines(result: RuntimeResponse): string[] {
  const events = result.observation?.events;
  if (!events) return [];
  const rows: string[] = [];
  for (const entry of events.console) rows.push(`console_${entry.type}: ${entry.text}`);
  for (const entry of events.pageErrors) rows.push(`page_error: ${entry.message}`);
  for (const entry of events.failedRequests) rows.push(`failed_request: ${entry.method} ${entry.url} (${entry.failure})`);
  for (const entry of events.downloads) {
    const state = entry.state === 'saved' ? `saved ${entry.bytes ?? 0} bytes -> ${entry.path}`
      : entry.state === 'too_large' ? 'FAILED: download exceeded the artifact size cap and was deleted'
        : entry.state === 'failed' ? `failed: ${entry.error ?? 'unknown error'}`
          : 'saving...';
    rows.push(`download: ${entry.suggestedFilename} ${entry.url} ${state}`);
  }
  const dropped = Object.entries(events.dropped).filter(([, count]) => count > 0);
  if (dropped.length > 0) rows.push(`event_telemetry_dropped: ${dropped.map(([name, count]) => `${name}=${count}`).join(', ')}`);
  return rows;
}

function byteLength(rows: string[]): number { return Buffer.byteLength(rows.join('\n'), 'utf8'); }

function appendBounded(rows: string[], candidates: string[], omittedLabel: string, maxBytes: number): void {
  if (candidates.length === 0) return;
  const markerBudget = Buffer.byteLength(`\n${omittedLabel}: ${candidates.length}`, 'utf8');
  let added = 0;
  for (const candidate of candidates) {
    const next = [...rows, candidate];
    if (byteLength(next) + markerBudget > maxBytes) break;
    rows.push(candidate); added += 1;
  }
  const omitted = candidates.length - added;
  if (omitted > 0) {
    const marker = `${omittedLabel}: ${omitted}`;
    if (byteLength([...rows, marker]) <= maxBytes) rows.push(marker);
  }
}

export function renderPlaywrightText(action: string, result: RuntimeResponse, maxBytes = MAX_OBSERVATION_BYTES): string {
  const observation = result.observation;
  const rows = [
    `playwright ${action}: ok`,
    line('session', result.sessionId),
    result.headless === true ? 'browser: headless Chromium (isolated context; the user\'s browsers are never attached)' : null,
    result.actionKind ? line('action', result.actionKind) : null,
    line('page', observation?.pageId),
    line('url', observation?.url),
    line('title', observation?.title),
    observation?.revision !== undefined ? line('revision', observation.revision) : null,
    observation?.refsInvalidated === true ? 'refs_invalidated: true (call observe before using refs)' : null,
  ].filter((entry): entry is string => entry !== null);

  if (result.screenshot) {
    rows.push(`display_png: ${result.screenshot.displayImagePath}`);
    rows.push(`display_size: ${result.screenshot.imageWidth}x${result.screenshot.imageHeight}`);
    rows.push(`full_png: ${result.screenshot.fullImagePath}`);
    rows.push(`full_png_size: ${result.screenshot.sourceWidth}x${result.screenshot.sourceHeight}`);
  }
  if (result.storageStatePath) rows.push(`storage_state: ${result.storageStatePath}`);
  if (result.closed) {
    const shown = result.closed.sessionIds.slice(0, 20);
    rows.push(`closed_${result.closed.scope}: ${shown.join(', ') || '(no live sessions)'}`);
    const omitted = (result.closed.omittedSessionIds ?? 0) + result.closed.sessionIds.length - shown.length;
    if (omitted > 0) rows.push(`closed_sessions_omitted: ${omitted}`);
  }
  if (observation?.reduction) {
    rows.push(`snapshot_reduction: ${observation.reduction.reason}`);
    rows.push(`complete_snapshot: ${observation.reduction.fullSnapshotPath}`);
  }
  if (observation?.snapshot !== undefined) appendBounded(rows, ['snapshot:', observation.snapshot], 'snapshot_sections_omitted', maxBytes);

  if (result.runCode) {
    const runCodeRows = [
      `run_code_result_bytes: ${result.runCode.bytes}`,
      ...(result.runCode.artifactPath ? [`run_code_result_artifact: ${result.runCode.artifactPath}`] : []),
      ...(result.runCode.truncated ? ['run_code_result_truncated: true'] : []),
      'run_code_result:',
      result.runCode.text,
    ];
    appendBounded(rows, runCodeRows, 'run_code_result_lines_omitted', maxBytes);
  }
  const helperRows = (result.helperArtifacts ?? []).map((artifact) =>
    `run_code_artifact: ${artifact.artifactId} ${artifact.bytes} bytes -> ${artifact.path}`,
  );
  appendBounded(rows, helperRows, 'run_code_artifacts_omitted', maxBytes);

  const dialogRows = (result.dialogs ?? []).map((dialog) =>
    `dialog: ${dialog.result} ${dialog.type} ${JSON.stringify(dialog.message)}${dialog.defaultValue !== undefined ? ` default=${JSON.stringify(dialog.defaultValue)}` : ''}`,
  );
  if (result.dialogsDropped && result.dialogsDropped > 0) dialogRows.push(`dialogs_dropped: ${result.dialogsDropped}`);
  appendBounded(rows, dialogRows, 'dialog_lines_omitted', maxBytes);
  appendBounded(rows, eventLines(result), 'event_lines_omitted', maxBytes);

  const tabRows = observation?.tabs?.map((tab) => `tab: ${tab.pageId} ${tab.url}${tab.active ? ' (active)' : ''}`) ?? [];
  if (observation?.tabsDropped && observation.tabsDropped > 0) tabRows.push(`tabs_dropped: ${observation.tabsDropped}`);
  appendBounded(rows, tabRows.length > 0 ? tabRows : (observation?.tabs ? ['tabs: (none)'] : []), 'tab_lines_omitted', maxBytes);
  const text = rows.join('\n');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw Object.assign(new Error(`playwright model-facing result metadata exceeded its ${maxBytes}-byte bound.`), { code: 'SIDECAR_PROTOCOL_ERROR' });
  }
  return text;
}

export function modelAcceptsImages(model: unknown): boolean {
  const input = (model as { input?: unknown } | undefined)?.input;
  return Array.isArray(input) && input.includes('image');
}

function unavailableImageNotice(artifact: string): string {
  return [
    'image_delivery: unavailable',
    'reason: active_model_does_not_accept_image_input',
    `artifact: ${artifact}`,
    '',
    'Do not infer the image contents. Use available textual/accessibility evidence, switch models,',
    'or delegate the artifact with modelRequirements.inputKinds=["image"].',
  ].join('\n');
}

export async function buildToolResult(action: string, result: RuntimeResponse, includeImage: boolean) {
  const imageNotice = !includeImage && result.screenshot ? unavailableImageNotice(result.screenshot.displayImagePath) : undefined;
  const textBudget = imageNotice === undefined
    ? MAX_OBSERVATION_BYTES
    : MAX_OBSERVATION_BYTES - Buffer.byteLength(`${imageNotice}\n\n`, 'utf8');
  let text = renderPlaywrightText(action, result, textBudget);
  if (imageNotice !== undefined) text = `${imageNotice}\n\n${text}`;
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' }> = [
    { type: 'text', text },
  ];
  if (includeImage && result.screenshot) {
    content.push({ type: 'image', data: (await readFile(result.screenshot.displayImagePath)).toString('base64'), mimeType: 'image/png' });
  }
  const { observation, screenshot, ...details } = result;
  return {
    content,
    details: {
      ...details,
      observation: observation === undefined ? undefined : {
        ...observation,
        snapshot: undefined,
        snapshotBytes: observation.snapshot === undefined ? 0 : Buffer.byteLength(observation.snapshot),
      },
    },
    isError: false as const,
  };
}

export function buildToolError(error: unknown): Error {
  const e = error as { code?: unknown; message?: unknown; retryable?: unknown };
  const code = typeof e?.code === 'string' ? e.code : 'PLAYWRIGHT_ERROR';
  const message = typeof e?.message === 'string' ? e.message : String(error);
  const text = truncateUtf8(`playwright error [${code}]: ${message}`).text;
  return Object.assign(new Error(text, { cause: error }), {
    name: 'PlaywrightToolError',
    code,
    retryable: e?.retryable === true,
    details: { error: { code, message, retryable: e?.retryable === true } },
  });
}
