/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolCall } from '../../../../shared/protocol';
import { isEmptyToolCallInput } from '../../../../shared/chat-message-parts';
import { extractExitCode, normalizeToolCallName } from '../../../../shared/tool-call-analysis';
import { ClickablePathButton } from '../../file-path';
import { ResizablePre } from '../../components/resizable-pre';
import { DEFAULT_CHAT_PREFS, type ChatPrefs } from '../../../../shared/protocol';
import {
  formatValueAsHighlightedYaml,
  highlightToolResultText,
  isTextOnlyToolResult,
  languageForToolInput,
  textFromToolResult,
} from '../highlight';

import { isCommandSummaryTool } from './summary-model';
import { TerminalOutput } from './terminal-output';
import { hasImageToolResult, ToolResultContentParts } from './tool-result-content';

interface ToolCallBodyProps {
  toolCall: ToolCall;
  prefs?: ChatPrefs;
  onOpenFile: (path: string) => void;
}

export function ToolCallBody({ toolCall, prefs = DEFAULT_CHAT_PREFS, onOpenFile }: ToolCallBodyProps) {
  const isShell = isCommandSummaryTool(toolCall.name);
  const isRunning = toolCall.status === 'running';
  const isProvisional = toolCall.status === 'drafting' || toolCall.status === 'ready';

  if (isProvisional) {
    return (
      <div class="tool-call-body" onClick={(e) => e.stopPropagation()}>
        <div class="tool-call-section">
          <div class="tool-call-section-label">Input</div>
          <pre class="tool-call-pre tool-call-provisional-input"><code>{toolCall.argumentsText || '(empty)'}</code></pre>
        </div>
      </div>
    );
  }

  if (isShell) {
    const text = textFromToolResult(toolCall.result) ?? '';
    const details = (toolCall.result as
      | {
          details?: {
            truncation?: { truncated?: boolean; totalLines?: number; outputLines?: number };
            fullOutputPath?: string;
          };
        }
      | null
      | undefined)?.details;
    const truncation = details?.truncation;
    const command =
      toolCall.input && typeof toolCall.input === 'object' && typeof (toolCall.input as { command?: unknown }).command === 'string'
        ? (toolCall.input as { command: string }).command
        : undefined;

    // The SDK's bash tool surfaces a non-zero exit only as text appended to the
    // result ("Command exited with code N") — it throws on non-zero exit, so
    // the tool-call status is already 'failed'. extractExitCode recovers the
    // numeric code (probing result fields, then the text) so the footer can
    // show the specific code. Gate on status === 'failed' (not just !isRunning):
    // a *completed* command whose own output coincidentally contains that phrase
    // must not trigger a false-positive badge. On success there is no signal, so
    // nothing is shown — consistent with the "alert on failure, not on success"
    // header philosophy.
    const exitCode = toolCall.status === 'failed' ? extractExitCode(toolCall.result, text) : null;
    const showExit = exitCode != null && exitCode !== 0;
    const fullLogPath = details?.fullOutputPath;
    const showTruncation = Boolean(truncation?.truncated);
    const showFooter = showTruncation || showExit;

    return (
      <div class="tool-call-body tool-call-body-terminal" onClick={(e) => e.stopPropagation()}>
        {command && (
          <div class="tool-call-terminal-command hljs-scope" title={command}>
            <span class="tool-call-terminal-prompt" aria-hidden="true">$</span>
            <code class="hljs language-bash" dangerouslySetInnerHTML={{ __html: highlightToolResultText(command, 'bash') }} />
          </div>
        )}
        <div class="tool-call-terminal" data-running={isRunning ? 'true' : undefined}>
          {text ? (
            <TerminalOutput text={text} running={isRunning} />
          ) : (
            <div class="tool-call-terminal-empty">{isRunning ? 'Executing…' : '(no output)'}</div>
          )}
        </div>
        {showFooter && (
          <div class="tool-call-terminal-footer">
            <div class="tool-call-terminal-footer-main">
              {showTruncation && (
                <span class="tool-call-truncated-text" title={fullLogPath}>
                  Output truncated — showing {truncation?.outputLines ?? '?'} of {truncation?.totalLines ?? '?'} lines
                </span>
              )}
              {showTruncation && fullLogPath && (
                <span class="tool-call-truncated-fulllog">
                  <span class="tool-call-truncated-fulllog-sep" aria-hidden="true">·</span>
                  <span class="tool-call-truncated-fulllog-label">Full log:</span>
                  <ClickablePathButton path={fullLogPath} displayText={fullLogPath} parentDepth={prefs.uiPathParentDepth} onOpenFile={onOpenFile} />
                </span>
              )}
            </div>
            {showExit && (
              <span class="tool-call-terminal-exit" title="Command exit code" data-exit-nonzero="true">exit {exitCode}</span>
            )}
          </div>
        )}
      </div>
    );
  }

  const resultText = textFromToolResult(toolCall.result);
  const resultIsTextOnly = isTextOnlyToolResult(toolCall.result);
  // A result carrying image-typed content parts must take the mixed-content
  // render path so image base64 is never serialized as YAML/text.
  const hasImage = hasImageToolResult(toolCall.result);
  // Infer a highlight language for file-content tools (read/grep/glob/find/cat)
  // from the tool's input path. edit/write results are short confirmations,
  // so they fall through to plain/JSON-detect highlighting.
  const normalizedName = normalizeToolCallName(toolCall.name);
  const isFileContentTool =
    normalizedName === 'read'
    || normalizedName === 'cat'
    || normalizedName === 'grep'
    || normalizedName === 'glob'
    || normalizedName === 'find';
  const resultLanguageHint = isFileContentTool
    ? languageForToolInput(toolCall.name, toolCall.input)
    : undefined;

  return (
    <div class="tool-call-body" onClick={(e) => e.stopPropagation()}>
      <div class="tool-call-section">
        <div class="tool-call-section-label">Input</div>
        {isEmptyToolCallInput(toolCall.input) ? (
          <div class="tool-call-empty">(no input)</div>
        ) : (
          <pre class="tool-call-pre hljs-scope">
            <code class="hljs language-yaml" dangerouslySetInnerHTML={{ __html: formatValueAsHighlightedYaml(toolCall.input) }} />
          </pre>
        )}
      </div>
      {toolCall.result !== undefined && (
        <div class="tool-call-section">
          <div class="tool-call-section-label">Result</div>
          {hasImage ? (
            <ToolResultContentParts result={toolCall.result} languageHint={resultLanguageHint} />
          ) : resultIsTextOnly && resultText !== undefined ? (
            <ResizablePre class="tool-call-pre tool-call-pre-resizable hljs-scope" minHeight={80}>
              <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(resultText, resultLanguageHint) }} />
            </ResizablePre>
          ) : (
            <ResizablePre class="tool-call-pre tool-call-pre-resizable hljs-scope" minHeight={80}>
              <code class="hljs language-yaml" dangerouslySetInnerHTML={{ __html: formatValueAsHighlightedYaml(toolCall.result) }} />
            </ResizablePre>
          )}
        </div>
      )}
    </div>
  );
}
