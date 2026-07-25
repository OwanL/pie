import { isDeepStrictEqual } from 'node:util';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readSessionIdentityFromBytes, sha256 } from './evidence.js';
import type { ReviewerRuntime, SessionReviewV2 } from './types.js';

interface ToolCall { id: string; name: string; arguments: unknown }
interface ToolResult { toolCallId: string; toolName: string; details?: unknown; content?: unknown; isError?: boolean; timestamp?: unknown }
interface TranscriptIndex {
  identity: ReturnType<typeof readSessionIdentityFromBytes>;
  cwd: string | undefined;
  calls: Map<string, ToolCall>;
  results: Map<string, ToolResult>;
}
function indexTranscript(sessionPath: string): TranscriptIndex {
  const raw = fs.readFileSync(sessionPath);
  const calls = new Map<string, ToolCall>();
  const results = new Map<string, ToolResult>();
  let cwd: string | undefined;
  for (const line of raw.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (entry.type === 'session' && typeof entry.cwd === 'string' && entry.cwd && cwd === undefined) cwd = entry.cwd;
    const message = entry.message as Record<string, unknown> | undefined;
    if (entry.type !== 'message' || !message) continue;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part.type === 'toolCall' && typeof part.id === 'string' && typeof part.name === 'string') calls.set(part.id, { id: part.id, name: part.name, arguments: part.arguments });
      }
    } else if (message.role === 'toolResult' && typeof message.toolCallId === 'string' && typeof message.toolName === 'string') {
      results.set(message.toolCallId, { toolCallId: message.toolCallId, toolName: message.toolName, details: message.details, content: message.content, isError: !!message.isError, timestamp: message.timestamp ?? entry.timestamp });
    }
  }
  return { identity: readSessionIdentityFromBytes(sessionPath, raw), cwd, calls, results };
}
function runtimeRecords(review: SessionReviewV2): ReviewerRuntime[] {
  return [
    ...review.proposals,
    review.consolidation,
    ...review.components,
    ...(review.adjudication ? [review.adjudication] : []),
  ];
}
function runtimeResult(result: ToolResult, toolCallId: string): Record<string, unknown> {
  const details = result.details as Record<string, unknown> | undefined;
  const candidates = Array.isArray(details?.results) ? details.results.filter((value): value is Record<string, unknown> => !!value && typeof value === 'object') : [];
  const exact = candidates.filter((candidate) => candidate.parentToolCallId === toolCallId);
  const matches = exact.length ? exact : candidates.length === 1 ? candidates : [];
  if (matches.length !== 1) throw new Error(`subagent tool call ${toolCallId} does not expose exactly one authoritative runtime result`);
  return matches[0]!;
}
function assertRuntime(record: ReviewerRuntime, index: TranscriptIndex): void {
  const call = index.calls.get(record.toolCallId);
  const result = index.results.get(record.toolCallId);
  if (!call || call.name !== 'subagent' || !result || result.toolName !== 'subagent') throw new Error(`reviewer ${record.reviewerId} is not bound to a completed prior subagent call`);
  const input = call.arguments as Record<string, unknown> | undefined;
  const actual = runtimeResult(result, record.toolCallId);
  const expected: Record<string, unknown> = {
    requestedBucket: record.requestedBucket,
    bucket: record.bucket,
    bucketDowngraded: record.bucketDowngraded,
    model: record.modelId,
    provider: record.provider,
    family: record.family,
    thinkingLevel: record.thinkingLevel,
    promptHash: record.promptHash,
  };
  const observed: Record<string, unknown> = {
    requestedBucket: actual.requestedBucket ?? input?.bucket,
    bucket: actual.bucket,
    bucketDowngraded: actual.bucketDowngraded,
    model: actual.model ?? actual.selectedModel,
    provider: actual.provider,
    family: actual.family,
    thinkingLevel: actual.thinkingLevel ?? null,
    promptHash: actual.promptHash,
  };
  if (!isDeepStrictEqual(observed, expected)) throw new Error(`reviewer ${record.reviewerId} runtime provenance does not match subagent result ${record.toolCallId}`);
}
function assertHumanCheck(review: SessionReviewV2, index: TranscriptIndex): void {
  if (!review.humanCheck) return;
  const call = index.calls.get(review.humanCheck.toolCallId);
  const result = index.results.get(review.humanCheck.toolCallId);
  if (!call || call.name !== 'ask_user' || !result || result.toolName !== 'ask_user') throw new Error('humanCheck is not bound to a completed prior ask_user call');
  if (!isDeepStrictEqual(call.arguments, review.humanCheck.input)) throw new Error('humanCheck input does not match the prior ask_user call');
  const details = result.details as Record<string, unknown> | undefined;
  const response = review.humanCheck.response;
  if (!details || details.source !== response.source || details.cancelled !== response.cancelled) throw new Error('humanCheck response does not match the prior ask_user result');
  if ('answer' in response && details.answer !== response.answer) throw new Error('humanCheck answer does not match the prior ask_user result');
  if (details.targetSessionId !== review.sessionId) throw new Error('humanCheck ask_user result targets a different session');
  if (result.timestamp !== undefined) {
    const actualTime = typeof result.timestamp === 'number' ? result.timestamp : Date.parse(String(result.timestamp));
    if (Date.parse(response.recordedAt) !== actualTime) throw new Error('humanCheck recordedAt does not match the ask_user result timestamp');
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as Array<Record<string, unknown>>)
    .filter((part) => part && typeof part['text'] === 'string')
    .map((part) => part['text'] as string)
    .join('\n');
}
function resolveWithinCwd(cwd: string | undefined, target: string): string {
  return path.isAbsolute(target) ? path.resolve(target) : path.resolve(cwd ?? process.cwd(), target);
}
/** Binds each non-skipped reviewer check's result/status/evidence to a real prior
 *  orchestrator tool call and its immutable output. Declined checks are skipped
 *  and carry no binding (validated structurally upstream). */
function assertReviewerChecks(review: SessionReviewV2, index: TranscriptIndex): void {
  for (const check of review.reviewerChecks) {
    if (check.status === 'declined: mutating') continue;
    const toolCallId = check.toolCallId;
    if (!toolCallId) throw new Error(`reviewer check ${check.checkId} is missing its toolCallId binding`);
    const call = index.calls.get(toolCallId);
    const result = index.results.get(toolCallId);
    if (!call || !result) throw new Error(`reviewer check ${check.checkId} is not bound to a completed prior tool call`);
    const output = toolResultText(result.content);
    if (check.kind === 'static_inspection') {
      // static_inspection: executed read-only via a read or grep tool call.
      if (call.name !== 'read' && call.name !== 'grep') throw new Error(`reviewer check ${check.checkId} must bind to a prior read or grep tool call`);
      const args = call.arguments as Record<string, unknown> | undefined;
      const targetResolved = resolveWithinCwd(index.cwd, check.target);
      if (call.name === 'read') {
        const target = args && typeof args.path === 'string' ? args.path : '';
        if (resolveWithinCwd(index.cwd, target) !== targetResolved) throw new Error(`reviewer check ${check.checkId} target does not match the prior read call`);
      } else {
        const pattern = args && typeof args.pattern === 'string' ? args.pattern : '';
        if (pattern !== check.query) throw new Error(`reviewer check ${check.checkId} query does not match the prior grep pattern`);
        const searchPath = args && typeof args.path === 'string' ? args.path : '';
        const glob = args && typeof args.glob === 'string' ? args.glob : '';
        const searchResolved = searchPath ? resolveWithinCwd(index.cwd, searchPath) : '';
        const referenced = !searchPath || searchResolved === targetResolved || targetResolved.startsWith(searchResolved + path.sep) || glob.includes(path.basename(check.target));
        if (!referenced) throw new Error(`reviewer check ${check.checkId} target is not referenced by the prior grep call`);
      }
    } else {
      // command | automated_check: executed via a prior bash tool call.
      if (call.name !== 'bash' || result.toolName !== 'bash') throw new Error(`reviewer check ${check.checkId} must bind to a prior bash tool call`);
      const args = call.arguments as Record<string, unknown> | undefined;
      if (!args || typeof args.command !== 'string' || args.command !== check.command) throw new Error(`reviewer check ${check.checkId} command does not match the prior bash call`);
      if (result.isError && check.status !== 'fail') throw new Error(`reviewer check ${check.checkId} must be 'fail' for a failed command`);
    }
    if (sha256(output) !== check.outputSha256) throw new Error(`reviewer check ${check.checkId} output hash does not match the prior tool result`);
    if (!output.startsWith(check.result)) throw new Error(`reviewer check ${check.checkId} result is not a prefix of the prior tool output`);
  }
}

/** Binds caller-supplied provenance to durable calls in this orchestrator session. */
export function validateRuntimeProvenance(review: SessionReviewV2, orchestratorPath: string): void {
  const index = indexTranscript(orchestratorPath);
  if (index.identity.sessionId !== review.provenance.orchestratorSessionId) throw new Error('provenance.orchestratorSessionId does not match the current reviewer session');
  // hostVersion is caller-supplied; trust only the host editor version pushed
  // by the host (PIE_EDITOR_VERSION). When unset (e.g. a standalone CLI run)
  // the reviewer cannot know it and must report null.
  const editorVersion = process.env.PIE_EDITOR_VERSION?.trim() || undefined;
  if ((editorVersion ?? null) !== review.provenance.hostVersion) throw new Error('provenance.hostVersion does not match the host editor version');
  const runtimes = runtimeRecords(review);
  if (new Set(runtimes.map((record) => record.toolCallId)).size !== runtimes.length) throw new Error('each pipeline role must use a distinct prior subagent call');
  runtimes.forEach((record) => assertRuntime(record, index));
  assertHumanCheck(review, index);
  assertReviewerChecks(review, index);
}
