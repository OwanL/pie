/**
 * Render helpers for the subagent tool — extracted from index.ts.
 *
 * Provides `renderSubagentCall` (the tool's `renderCall`) and
 * `renderSubagentResult` (the tool's `renderResult`).
 */

import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { AgentScope } from "./agents.js";
import { formatSelectionInfo, formatToolCall, formatUsageStats, getDisplayItems, getFinalOutput } from "./formatting.js";
import { COLLAPSED_ITEM_COUNT, TASK_PREVIEW_LONG, TASK_PREVIEW_SHORT, type DisplayItem, type SingleResult, type SubagentDetails } from "./types.js";

type Theme = any;
type Ctx = any;
type RenderResult = any;

const CHAIN_PREVIEW_LIMIT = 3;
const PARALLEL_RESULT_PREVIEW_LIMIT = 5;
const TEXT_PREVIEW_LINES = 3;

export function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}...` : s;
}

function renderNoDetails(result: any): RenderResult {
	const text = result.content[0];
	return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
}

function isRunningResult(r: SingleResult): boolean {
	return r.exitCode === -1;
}

function isErrorResult(r: SingleResult): boolean {
	return !isRunningResult(r) && (r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted");
}

function resultIcon(theme: Theme, r: SingleResult): string {
	if (isRunningResult(r)) return theme.fg("warning", "⏳");
	return isErrorResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
}

function resultHeader(theme: Theme, r: SingleResult, icon: string): string {
	let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${theme.fg("muted", ` (${r.agentSource})`)}`;
	if (isErrorResult(r) && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
	return header;
}

function compactDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(0, Math.floor(ms / 1000))}s`;
	return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

function runningActivity(r: SingleResult): string {
	const phaseLabels: Record<string, string> = {
		queued: "queued locally",
		preparing: "preparing session",
		waiting_provider: "waiting for provider",
		streaming: "provider streaming",
		running_tool: "running tool",
		retry_wait: "waiting to retry provider",
	};
	if (!r.activityPhase) return "running...";
	const label = phaseLabels[r.activityPhase] || "running";
	const elapsed = r.activitySince ? compactDuration(Date.now() - r.activitySince) : undefined;
	const budget = r.inactivityBudgetMs ? compactDuration(r.inactivityBudgetMs) : undefined;
	const detail = r.activityDetail && r.activityDetail !== label ? ` · ${r.activityDetail}` : "";
	const timing = elapsed ? ` · ${elapsed}` : "";
	const limit = budget ? ` · stall limit ${budget}` : "";
	return `running... · ${label}${detail}${timing}${limit}`;
}

export function renderDisplayItems(items: DisplayItem[], theme: Theme, expanded: boolean, limit?: number): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, TEXT_PREVIEW_LINES).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}\n`;
		}
	}
	return text.trimEnd();
}

export function aggregateUsage(results: SingleResult[]) {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

function appendUsageAndSelection(text: string, r: SingleResult, theme: Theme, prefix = "\n"): string {
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `${prefix}${theme.fg("dim", usageStr)}`;
	const selInfo = formatSelectionInfo(r, theme.fg.bind(theme));
	if (selInfo) text += `${prefix}${selInfo}`;
	return text;
}

function appendToolCalls(container: Container, items: DisplayItem[], theme: Theme): void {
	for (const item of items) {
		if (item.type === "toolCall") {
			container.addChild(
				new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)), 0, 0),
			);
		}
	}
}

function appendFinalOutput(container: Container, finalOutput: string, mdTheme: any): void {
	if (!finalOutput) return;
	container.addChild(new Spacer(1));
	container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
}

function appendStepTrailers(container: Container, r: SingleResult, theme: Theme): void {
	const stepUsage = formatUsageStats(r.usage, r.model);
	if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
	const selInfo = formatSelectionInfo(r, theme.fg.bind(theme));
	if (selInfo) container.addChild(new Text(selInfo, 0, 0));
}

function renderSingleExpanded(r: SingleResult, theme: Theme, mdTheme: any): Container {
	const icon = resultIcon(theme, r);
	const isError = isErrorResult(r);
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	const container = new Container();
	let header = resultHeader(theme, r, icon);
	if (r.task) header += ` ${theme.fg("dim", "·")} ${theme.fg("dim", r.task)}`;
	container.addChild(new Text(header, 0, 0));
	if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));

	if (displayItems.length === 0 && !finalOutput) {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	} else {
		appendToolCalls(container, displayItems, theme);
		appendFinalOutput(container, finalOutput, mdTheme);
	}

	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) {
		container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
	}
	const selInfoExp = formatSelectionInfo(r, theme.fg.bind(theme));
	if (selInfoExp) container.addChild(new Text(selInfoExp, 0, 0));
	return container;
}

function renderSingleCollapsed(r: SingleResult, theme: Theme): Text {
	const icon = resultIcon(theme, r);
	const isError = isErrorResult(r);
	const isRunning = isRunningResult(r);
	const displayItems = getDisplayItems(r.messages);

	let text = resultHeader(theme, r, icon);
	if (isRunning && r.task) {
		text += ` ${theme.fg("dim", "·")} ${theme.fg("dim", r.task)}`;
	}
	if (isRunning) {
		text += `\n${theme.fg("warning", runningActivity(r))}`;
	} else if (isError && r.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
	} else if (displayItems.length === 0) {
		text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		text += `\n${renderDisplayItems(displayItems, theme, false, COLLAPSED_ITEM_COUNT)}`;
		if (displayItems.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	return new Text(appendUsageAndSelection(text, r, theme), 0, 0);
}

function renderSingleResult(r: SingleResult, expanded: boolean, theme: Theme, mdTheme: any): RenderResult {
	if (expanded) return renderSingleExpanded(r, theme, mdTheme);
	return renderSingleCollapsed(r, theme);
}

function chainStepHeader(theme: Theme, r: SingleResult, rIcon: string): string {
	const step = r.step ? `${r.step}. ` : "";
	return `${theme.fg("muted", step) + theme.fg("accent", r.agent)} ${rIcon}`;
}

function parallelStepHeader(theme: Theme, r: SingleResult, rIcon: string): string {
	return `${theme.fg("accent", r.agent)} ${rIcon}`;
}

function chainIcon(theme: Theme, results: SingleResult[]): string {
	const running = results.filter((r) => r.exitCode === -1).length;
	if (running > 0) return theme.fg("warning", "⏳");
	const successCount = results.filter((r) => r.exitCode === 0).length;
	return successCount === results.length ? theme.fg("success", "✓") : theme.fg("error", "✗");
}

function chainExpandedHeader(theme: Theme, results: SingleResult[]): string {
	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const icon = chainIcon(theme, results);
	const status = running > 0 ? `${successCount}/${results.length} steps, ${running} running` : `${successCount}/${results.length} steps`;
	return (
		icon +
		" " +
		theme.fg("toolTitle", theme.bold("chain ")) +
		theme.fg("accent", status)
	);
}

function chainCollapsedHeader(theme: Theme, results: SingleResult[]): string {
	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const icon = chainIcon(theme, results);
	const status = running > 0 ? `${successCount}/${results.length} steps, ${running} running` : `${successCount}/${results.length} steps`;
	return icon + " " + theme.fg("toolTitle", theme.bold("chain ")) + theme.fg("accent", status);
}

function renderChainStepExpanded(container: Container, r: SingleResult, theme: Theme, mdTheme: any): void {
	const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	const header = chainStepHeader(theme, r, rIcon) + (r.task ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", r.task)}` : "");
	container.addChild(new Text(header, 0, 0));
	appendToolCalls(container, displayItems, theme);
	appendFinalOutput(container, finalOutput, mdTheme);
	appendStepTrailers(container, r, theme);
}

function renderChainStepCollapsed(text: string, r: SingleResult, theme: Theme): string {
	const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : r.exitCode === -1 ? theme.fg("warning", "⏳") : theme.fg("error", "✗");
	const displayItems = getDisplayItems(r.messages);
	text += `\n\n${chainStepHeader(theme, r, rIcon)}`;
	const selInfoChainCol = formatSelectionInfo(r, theme.fg.bind(theme));
	if (selInfoChainCol) text += `\n${selInfoChainCol}`;
	if (displayItems.length === 0) text += `\n${theme.fg("muted", r.exitCode === -1 ? `(${runningActivity(r)})` : "(no output)")}`;
	else text += `\n${renderDisplayItems(displayItems, theme, false, PARALLEL_RESULT_PREVIEW_LIMIT)}`;
	return text;
}

function appendChainTotal(text: string, results: SingleResult[], theme: Theme, prefix: string): string {
	const usageStr = formatUsageStats(aggregateUsage(results));
	if (usageStr) text += `${prefix}${theme.fg("dim", `Total: ${usageStr}`)}`;
	return text;
}

function appendChainTotalForContainer(container: Container, results: SingleResult[], theme: Theme): void {
	const usageStr = formatUsageStats(aggregateUsage(results));
	if (!usageStr) return;
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
}

function renderChainExpanded(results: SingleResult[], theme: Theme, mdTheme: any): Container {
	const container = new Container();
	container.addChild(new Text(chainExpandedHeader(theme, results), 0, 0));
	for (const r of results) renderChainStepExpanded(container, r, theme, mdTheme);
	appendChainTotalForContainer(container, results, theme);
	return container;
}

function renderChainCollapsed(results: SingleResult[], theme: Theme, expanded: boolean = false): Text {
	const isRunning = results.some((r) => r.exitCode === -1);
	let text = chainCollapsedHeader(theme, results);
	for (const r of results) text = renderChainStepCollapsed(text, r, theme);
	if (!isRunning) {
		text = appendChainTotal(text, results, theme, "\n\n");
	}
	if (!expanded && !isRunning) {
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	return new Text(text, 0, 0);
}

function renderChainResult(results: SingleResult[], expanded: boolean, theme: Theme, mdTheme: any): RenderResult {
	if (expanded) return renderChainExpanded(results, theme, mdTheme);
	return renderChainCollapsed(results, theme);
}

function parallelIconAndStatus(theme: Theme, results: SingleResult[]): { icon: string; status: string; isRunning: boolean } {
	const running = results.filter((r) => r.exitCode === -1).length;
	const successCount = results.filter((r) => r.exitCode === 0).length;
	const failCount = results.filter((r) => r.exitCode > 0).length;
	const isRunning = running > 0;
	const icon = isRunning
		? theme.fg("warning", "⏳")
		: failCount > 0
			? theme.fg("warning", "◐")
			: theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${results.length} done, ${running} running`
		: `${successCount}/${results.length} tasks`;
	return { icon, status, isRunning };
}

function parallelHeader(theme: Theme, results: SingleResult[]): string {
	const { icon, status } = parallelIconAndStatus(theme, results);
	return `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
}

function renderParallelStepExpanded(container: Container, r: SingleResult, theme: Theme, mdTheme: any): void {
	const rIcon = parallelStepIcon(theme, r);
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);

	const header = parallelStepHeader(theme, r, rIcon) + (r.task ? ` ${theme.fg("dim", "·")} ${theme.fg("dim", r.task)}` : "");
	container.addChild(new Text(header, 0, 0));
	appendToolCalls(container, displayItems, theme);
	appendFinalOutput(container, finalOutput, mdTheme);
	appendStepTrailers(container, r, theme);
}

function parallelStepIcon(theme: Theme, r: SingleResult): string {
	if (r.exitCode === -1) return theme.fg("warning", "⏳");
	if (r.exitCode === 0) return theme.fg("success", "✓");
	return theme.fg("error", "✗");
}

function renderParallelStepCollapsed(text: string, r: SingleResult, theme: Theme): string {
	const rIcon = parallelStepIcon(theme, r);
	const displayItems = getDisplayItems(r.messages);
	text += `\n\n${parallelStepHeader(theme, r, rIcon)}`;
	const selInfoParCol = formatSelectionInfo(r, theme.fg.bind(theme));
	if (selInfoParCol) text += `\n${selInfoParCol}`;
	if (displayItems.length === 0)
		text += `\n${theme.fg("muted", r.exitCode === -1 ? `(${runningActivity(r)})` : "(no output)")}`;
	else text += `\n${renderDisplayItems(displayItems, theme, false, PARALLEL_RESULT_PREVIEW_LIMIT)}`;
	return text;
}

function renderParallelExpanded(results: SingleResult[], theme: Theme, mdTheme: any): Container {
	const container = new Container();
	container.addChild(new Text(parallelHeader(theme, results), 0, 0));
	for (const r of results) renderParallelStepExpanded(container, r, theme, mdTheme);
	appendChainTotalForContainer(container, results, theme);
	return container;
}

function renderParallelCollapsed(results: SingleResult[], theme: Theme, expanded: boolean): Text {
	const { isRunning } = parallelIconAndStatus(theme, results);
	let text = parallelHeader(theme, results);
	for (const r of results) text = renderParallelStepCollapsed(text, r, theme);
	if (!isRunning) text = appendChainTotal(text, results, theme, "\n\n");
	if (!expanded && !isRunning) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

function renderParallelResult(results: SingleResult[], expanded: boolean, theme: Theme, mdTheme: any): RenderResult {
	const { isRunning } = parallelIconAndStatus(theme, results);
	if (expanded && !isRunning) return renderParallelExpanded(results, theme, mdTheme);
	return renderParallelCollapsed(results, theme, expanded);
}

export function renderSubagentCall(args: any, theme: Theme, _context: Ctx): RenderResult {
	const scope: AgentScope = args.agentScope ?? "user";
	if (args.chain && args.chain.length > 0) return renderChainCall(args, scope, theme);
	if (args.tasks && args.tasks.length > 0) return renderParallelCall(args, scope, theme);
	return renderSingleCall(args, scope, theme);
}

function renderChainCall(args: any, scope: AgentScope, theme: Theme): Text {
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `chain (${args.chain.length} steps)`) +
		theme.fg("muted", ` [${scope}]`);
	for (let i = 0; i < Math.min(args.chain.length, CHAIN_PREVIEW_LIMIT); i++) {
		const step = args.chain[i];
		const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
		const preview = truncate(cleanTask, TASK_PREVIEW_SHORT);
		text +=
			"\n  " +
			theme.fg("muted", `${i + 1}.`) +
			" " +
			theme.fg("accent", step.agent) +
			theme.fg("dim", ` ${preview}`);
	}
	if (args.chain.length > CHAIN_PREVIEW_LIMIT) text += `\n  ${theme.fg("muted", `... +${args.chain.length - CHAIN_PREVIEW_LIMIT} more`)}`;
	return new Text(text, 0, 0);
}

function renderParallelCall(args: any, scope: AgentScope, theme: Theme): Text {
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
		theme.fg("muted", ` [${scope}]`);
	for (const t of args.tasks.slice(0, CHAIN_PREVIEW_LIMIT)) {
		const preview = truncate(t.task, TASK_PREVIEW_SHORT);
		text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
	}
	if (args.tasks.length > CHAIN_PREVIEW_LIMIT) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - CHAIN_PREVIEW_LIMIT} more`)}`;
	return new Text(text, 0, 0);
}

function renderSingleCall(args: any, scope: AgentScope, theme: Theme): Text {
	const agentName = args.agent || "...";
	const preview = args.task ? truncate(args.task, TASK_PREVIEW_LONG) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", agentName) +
		theme.fg("muted", ` [${scope}]`);
	text += ` ${theme.fg("dim", "·")} ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

export function renderSubagentResult(
	result: any,
	{ expanded, isPartial }: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
	_context: Ctx,
): RenderResult {
	const details = result.details as SubagentDetails | undefined;
	if (!details || details.results.length === 0) return renderNoDetails(result);

	const mdTheme = getMarkdownTheme();

	if (details.mode === "single" && details.results.length === 1) {
		if (isPartial) return renderSingleCollapsed(details.results[0], theme);
		return renderSingleResult(details.results[0], expanded, theme, mdTheme);
	}
	if (details.mode === "chain") {
		if (isPartial) return renderChainCollapsed(details.results, theme);
		return renderChainResult(details.results, expanded, theme, mdTheme);
	}
	if (details.mode === "parallel") {
		if (isPartial) return renderParallelCollapsed(details.results, theme, expanded);
		return renderParallelResult(details.results, expanded, theme, mdTheme);
	}
	return renderNoDetails(result);
}
