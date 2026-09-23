import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { BackendClient } from './backend/client';
import {
  type RunAnalyticsExportPayload,
} from './run-analytics/query';
import { SidebarViewProvider } from './sidebar/provider';
import { EMPTY_DIFF_SCHEME, EmptyDiffContentProvider } from './vscode/file-diff';
import { createVscodeHostRuntimePlatform } from './vscode/host-runtime-platform';
import {
  acquirePieHostOwnership,
  describePieHostRefusal,
  resolvePieHostCoordinatorPort,
  resolvePieHostHandoffTimeoutMs,
  type PieHostAcquisition,
  type PieHostOwnership,
} from './coordinator/host-coordinator';
import { appendPieLog } from './util/pie-log';
import { HostRuntime } from './runtime/host-runtime';
import { type HostRendererSurface, type HostRuntimeStatus } from './runtime/platform';
import { getDefaultRunAnalyticsExportPath } from './run-analytics/storage';
import type { SessionOperationSource } from './core/operation-types.js';
import { toErrorMessage } from './util/error-message';
import { getDiagPath, isStreamDiagEnabled, setStreamDiagEnabled } from './util/stream-telemetry';
import {
  getLivePipelineTraceHealth,
  getLivePipelineTracePath,
  setLivePipelineTraceEnabled,
} from './util/live-pipeline-trace-runtime';
import {
  getPieLogDir,
  getPieLogPath,
  getLogLevel,
  LOG_LEVELS,
  parseLogLevel,
  setLogLevel,
} from './util/pie-logger';

export const SIDEBAR_VIEW_TYPE = 'pie.sessionsView';

/**
 * VS Code adapter around the shared platform-neutral {@link HostRuntime}.
 *
 * Owns only VS Code-specific surfaces: the status bar, the sidebar webview
 * provider, and the `pie.*` commands. Application composition/lifecycle —
 * the CQRS spine, session service, browser server, analytics authority, and
 * backend start/restart/shutdown — lives in `host/runtime/host-runtime.ts`,
 * wired through the platform adapters in `host/vscode/host-runtime-platform.ts`.
 */
export class PieExtension implements vscode.Disposable {
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly sidebarProvider: SidebarViewProvider;
  private readonly backend: BackendClient;
  private readonly runtime: HostRuntime;
  private shutdownPromise: Promise<void> | null = null;
  /** Machine-wide host ownership, held from before runtime/backend startup
   *  until shutdown actually finishes (released after the runtime teardown). */
  private hostOwnership: PieHostOwnership | null = null;
  /** True when startup was refused by the host coordinator; the runtime was
   *  never started and shutdown must not touch (or release) anything. */
  private ownershipRefused = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    backend: BackendClient,
  ) {
    this.backend = backend;
    // The sidebar provider is constructed first so its stable host instance
    // identity exists before the runtime's browser server binds the shared
    // incarnation — the same construction order as the previous single
    // composition. Its callbacks reference `this.runtime` lazily, after the
    // assignment below completes.
    this.sidebarProvider = new SidebarViewProvider(
      context,
      () => this.runtime.buildViewState(),
      (message) => {
        void this.runtime.handleWebviewMessage(message);
      },
      () => this.runtime.getRunningSessionCount(),
      {
        // Renderer-scoped handshake snapshots for browser sockets: the
        // router answers a browser `ready`/`refreshState` in THAT renderer.
        onForeignRequestState: (rendererId) => this.runtime.browserServer.requestState(rendererId),
        // Renderer-scoped imperatives (browser server plan §4.4): lazy-detail
        // responses answer the INITIATING browser renderer.
        onForeignPostImperative: (rendererId, message) => this.runtime.browserServer.postImperative(message, rendererId),
        onRendererInvalidated: (rendererId, rendererGeneration) =>
          this.runtime.service.unsubscribeRendererDetails(rendererId, rendererGeneration),
      },
    );
    const platform = createVscodeHostRuntimePlatform(
      context,
      createSidebarRendererSurface(this.sidebarProvider),
    );
    this.runtime = new HostRuntime(platform, backend, {
      onStatusChange: (state) => this.updateStatusBar(state),
    });

    this.statusBar.command = 'pie.openChat';
    this.statusBar.show();
  }

  async start(): Promise<void> {
    const acquisition = await this.acquireHostOwnership();
    if (acquisition.status !== 'acquired') {
      // Visible refusal notification; pie starts nothing in this window.
      this.ownershipRefused = true;
      const message = describePieHostRefusal(acquisition, resolvePieHostCoordinatorPort());
      if (acquisition.status === 'refused-host-active') {
        void vscode.window.showWarningMessage(`pie did not start: ${message}`);
      } else {
        void vscode.window.showErrorMessage(`pie did not start: ${message}`);
      }
      return;
    }
    this.hostOwnership = acquisition.ownership;
    this.updateStatusBar('Starting');
    try {
      await this.runtime.start();
    } catch (error) {
      // A failed startup must not hold the machine-wide lock.
      await this.hostOwnership.release().catch(() => undefined);
      this.hostOwnership = null;
      throw error;
    }
  }

  /** Single-active-host policy for VS Code (host coordinator contract):
   *  fast refusal when another VS Code window owns pie; a visibly bounded
   *  graceful handoff when a standalone host owns it; fail closed on timeout
   *  or on an unresponsive (foreign) port occupant. */
  private async acquireHostOwnership(): Promise<PieHostAcquisition> {
    const port = resolvePieHostCoordinatorPort();
    // Fast path: no visible progress on the common "nothing else is running"
    // boot. `handoffTimeoutMs: 0` refuses immediately on any active host.
    const quick = await acquirePieHostOwnership({ kind: 'vscode', port, handoffTimeoutMs: 0 });
    if (quick.status !== 'refused-host-active' || quick.active.kind === 'vscode') {
      return quick;
    }
    // A standalone host is active: visibly wait a bounded time for its
    // graceful shutdown and release, then acquire only on a fresh bind.
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        cancellable: false,
        title: 'pie: taking over from the standalone pie host',
      },
      (progress) => acquirePieHostOwnership({
        kind: 'vscode',
        port,
        handoffTimeoutMs: resolvePieHostHandoffTimeoutMs(),
        onHandoffStart: (active) => progress.report({
          message: `requested the standalone host (pid ${active.pid}) to stop; waiting for release…`,
        }),
      }),
    );
  }

  async restart(source?: SessionOperationSource): Promise<void> {
    await this.runtime.restart(source);
  }

  register(): void {
    this.context.subscriptions.push(
      this.backend,
      this.runtime.service,
      this.statusBar,
      vscode.workspace.registerTextDocumentContentProvider(EMPTY_DIFF_SCHEME, new EmptyDiffContentProvider()),
      vscode.window.registerWebviewViewProvider(SIDEBAR_VIEW_TYPE, this.sidebarProvider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand('pie.openChat', () => {
        this.sidebarProvider.reveal();
      }),
      vscode.commands.registerCommand('pie.openInBrowser', () => this.openBrowserUrl()),
      vscode.commands.registerCommand('pie.copyBrowserUrl', () => this.copyBrowserUrl()),
      vscode.commands.registerCommand('pie.restartBrowserServer', () => this.restartBrowserServer()),
      vscode.commands.registerCommand('pie.dumpDebugState', async () => {
        const dumpPath = await this.dumpDebugState();
        const open = 'Open File';
        const reveal = 'Reveal in Folder';
        const choice = await vscode.window.showInformationMessage(
          `pie debug state written: ${dumpPath}`,
          open,
          reveal,
        );
        if (choice === open) {
          try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(dumpPath));
            await vscode.window.showTextDocument(doc, { preview: true });
          } catch (err) {
            void vscode.window.showErrorMessage(`Failed to open debug state: ${toErrorMessage(err)}`);
          }
        } else if (choice === reveal) {
          await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dumpPath));
        }
        return dumpPath;
      }),
      vscode.commands.registerCommand('pie.toggleStreamDiag', () => {
        const next = setStreamDiagEnabled(!isStreamDiagEnabled());
        setLivePipelineTraceEnabled(next);
        void this.runtime.backend.request('diagnostics.livePipeline.setEnabled', { enabled: next }, { timeoutMs: 5_000 }).catch(() => undefined);
        const health = getLivePipelineTraceHealth();
        void vscode.window.showInformationMessage(
          `pie stream diagnostics: ${next ? 'ON' : 'OFF'} — aggregate: ${getDiagPath()} — pipeline: ${getLivePipelineTracePath()} — health e/s/d/u ${health.emitted}/${health.sampled}/${health.dropped}/${health.unflushed}`,
        );
      }),
      vscode.commands.registerCommand('pie.setLogLevel', async () => {
        const current = getLogLevel();
        const items = LOG_LEVELS.map((level) => ({
          label: level,
          description: level === current ? '$(check) current' : undefined,
          picked: level === current,
          level,
        }));
        const pick = await vscode.window.showQuickPick(items, {
          placeHolder: `Select pie log verbosity (current: ${current})`,
          title: 'pie: Set Log Level',
        });
        if (!pick) {
          return;
        }
        setLogLevel(pick.level);
        // Persist the choice so it survives reloads.
        await vscode.workspace
          .getConfiguration('pie')
          .update('logLevel', pick.level, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(
          `pie log level: ${pick.level} — persistent log: ${getPieLogPath()}`,
        );
      }),
      vscode.commands.registerCommand('pie.openLogFile', async () => {
        const logPath = getPieLogPath();
        const rotated = `${logPath}.1`;
        let target = logPath;
        try {
          await fs.access(logPath);
        } catch {
          // Active log missing (nothing written yet) — fall back to the
          // rotated backup so the command still shows something useful.
          try {
            await fs.access(rotated);
            target = rotated;
          } catch {
            void vscode.window.showWarningMessage(
              `pie log file does not exist yet. Path: ${logPath}`,
            );
            return;
          }
        }
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to open pie log: ${toErrorMessage(err)}`,
          );
        }
      }),
      vscode.commands.registerCommand('pie.revealLogFolder', async () => {
        const dir = getPieLogDir();
        try {
          await fs.mkdir(dir, { recursive: true });
        } catch {
          // mkdir failures are non-fatal; reveal may still succeed.
        }
        const uri = vscode.Uri.file(dir);
        try {
          await vscode.commands.executeCommand('revealFileInOS', uri);
        } catch (err) {
          void vscode.window.showErrorMessage(
            `Failed to reveal pie log folder: ${toErrorMessage(err)} (${dir})`,
          );
        }
      }),
      vscode.commands.registerCommand('pie.newSession', async () => {
        this.runtime.service.createNewSession();
        this.sidebarProvider.reveal();
      }),
      vscode.commands.registerCommand('pie.restartBackend', async (source?: SessionOperationSource) => {
        await this.restart(source);
      }),
      vscode.commands.registerCommand('pie.exportRunAnalytics', async (
        target?: vscode.Uri | string,
      ) => {
        return await this.exportRunAnalytics(target);
      }),
      vscode.commands.registerCommand('pie.attachFiles', async (
        resource?: vscode.Uri,
        resources?: vscode.Uri[],
      ) => {
        const uris = [
          ...(Array.isArray(resources) ? resources : []),
          ...(resource ? [resource] : []),
        ];
        await this.attachFiles(uris, 'picker');
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('pie.experimentAssignment')) {
          this.runtime.notifyExperimentAssignmentChanged();
        }
        if (event.affectsConfiguration('pie.logLevel')) {
          const configured = vscode.workspace
            .getConfiguration('pie')
            .get<string>('logLevel', 'info');
          setLogLevel(parseLogLevel(configured, 'info'));
        }
      }),
    );
  }

  private async attachFiles(
    uris: vscode.Uri[],
    source: 'picker' | 'drop' = 'picker',
  ): Promise<void> {
    const targets = this.runtime.service.normalizeAttachUris(uris);
    if (targets.length === 0) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: true,
        openLabel: 'Attach to pie',
        title: 'Attach file path(s) to pie',
      });
      if (!picked || picked.length === 0) return;
      await this.attachFiles(picked, 'picker');
      return;
    }

    this.sidebarProvider.reveal();
    await this.runtime.service.addFilesystemPaths(
      undefined,
      targets.map((uri) => uri.fsPath),
      source,
    );
  }

  private async exportRunAnalytics(
    target?: vscode.Uri | string,
  ): Promise<RunAnalyticsExportPayload | undefined> {
    const shouldNotify = !target;
    const resolvedTarget = typeof target === 'string'
      ? vscode.Uri.file(target)
      : target ?? await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(getDefaultRunAnalyticsExportPath(
          process.env.PI_CODING_AGENT_DIR,
          this.context.globalStorageUri.fsPath,
          vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
        )),
        filters: {
          JSON: ['json'],
        },
        saveLabel: 'Export Run Analytics',
        title: 'Export pie run analytics',
      });

    if (!resolvedTarget) {
      return undefined;
    }

    try {
      const payload = await this.runtime.statsService.exportRunAnalytics(resolvedTarget.fsPath);
      if (shouldNotify) {
        void vscode.window.showInformationMessage(
          `pie: Exported run analytics to ${resolvedTarget.fsPath}`,
        );
      }
      return payload;
    } catch (error) {
      const message = toErrorMessage(error);
      if (shouldNotify) {
        void vscode.window.showErrorMessage(`pie: Failed to export run analytics: ${message}`);
      }
      throw error;
    }
  }

  private async dumpDebugState(): Promise<string> {
    const dumpPath = path.join(this.context.globalStorageUri.fsPath, 'pie-debug-state.json');
    const payload = {
      capturedAt: new Date().toISOString(),
      sidebar: this.sidebarProvider.getDebugState(),
      viewState: this.runtime.buildViewState(),
    };

    await fs.mkdir(path.dirname(dumpPath), { recursive: true });
    await fs.writeFile(dumpPath, JSON.stringify(payload, null, 2), 'utf8');
    return dumpPath;
  }

  private updateStatusBar(state: HostRuntimeStatus): void {
    const archState = this.runtime.getArchState();
    const runningCount = archState.sessions.runningSessionPaths.length;
    const activeToolCount = this.countActiveToolCalls(archState);
    const notice = archState.settings.notice;

    let text: string;
    if (state === 'Thinking') {
      const sessionPart = runningCount > 1 ? `${runningCount} Running` : 'Running';
      text = activeToolCount > 0
        ? `pie: ${sessionPart} \u00b7 ${activeToolCount} tool${activeToolCount === 1 ? '' : 's'}`
        : `pie: ${sessionPart}`;
    } else if (state === 'Error') {
      text = 'pie: Error';
    } else if (state === 'Starting') {
      text = 'pie: Starting';
    } else {
      text = 'pie: Idle';
    }

    this.statusBar.text = text;

    // Build a tooltip that surfaces the load breakdown when running, then
    // falls through to the backend notice (if any) or the default prompt.
    const tooltipLines: string[] = [];
    if (state === 'Thinking') {
      tooltipLines.push(
        `${runningCount} running session${runningCount === 1 ? '' : 's'} \u00b7 ${activeToolCount} active tool call${activeToolCount === 1 ? '' : 's'}`,
      );
    }
    tooltipLines.push(notice ?? 'Open pie chat');
    this.statusBar.tooltip = tooltipLines.join('\n');
  }

  /** Count tool calls with status 'running' across every loaded transcript.
   *  Gives a rough system-load signal for the status bar: each running tool
   *  call (including an in-flight subagent invocation, which is itself a
   *  running tool call on the parent session) is one unit of concurrent work.
   *  Only loaded sessions are scanned, so the count is a lower bound when
   *  background sessions aren't pinned/open — acceptable for a load glance. */
  private countActiveToolCalls(archState: ReturnType<HostRuntime['getArchState']>): number {
    const { bySession } = archState.transcript;
    let count = 0;
    for (const messages of Object.values(bySession)) {
      if (!messages) continue;
      for (const message of messages) {
        // `toolCalls` is the canonical flat array kept in sync with the
        // structured `parts` by `upsertAssistantToolCall`; prefer it and only
        // fall back to `parts` for messages that never got the array populated.
        if (message.toolCalls && message.toolCalls.length > 0) {
          for (const tc of message.toolCalls) {
            if (tc.status === 'running') count++;
          }
        } else if (message.parts) {
          for (const part of message.parts) {
            if (part.kind === 'toolCall' && part.toolCall.status === 'running') count++;
          }
        }
      }
    }
    return count;
  }

  // ─── Browser server commands (§12.3) ────────────────────────────────────

  /** `pie: Open in Browser` — open the ACTUAL URL of this host's server. */
  private async openBrowserUrl(): Promise<void> {
    const state = this.runtime.browserServer.getState();
    if (!state.running || state.url === null) {
      void vscode.window.showWarningMessage('The pie browser server is not running. Enable `pie.browserServer.enabled` and restart the extension window.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(state.url));
  }

  /** `pie: Copy Browser URL` — copy the ACTUAL served URL. */
  private async copyBrowserUrl(): Promise<void> {
    const state = this.runtime.browserServer.getState();
    if (!state.running || state.url === null) {
      void vscode.window.showWarningMessage('The pie browser server is not running. Enable `pie.browserServer.enabled` and restart the extension window.');
      return;
    }
    await vscode.env.clipboard.writeText(state.url);
    const lanDetails = state.lanUrls.length > 0 ? `\nLAN URLs:\n${state.lanUrls.join('\n')}` : '';
    void vscode.window.showInformationMessage(`pie localhost browser URL copied: ${state.url}${lanDetails}`);
  }

  /** `pie: Restart Browser Server` — stop + re-read settings + rebind. */
  private async restartBrowserServer(): Promise<void> {
    const before = this.runtime.browserServer.getState();
    await this.runtime.browserServer.stop();
    const outcome = await this.runtime.browserServer.start();
    if (outcome.kind === 'started') {
      void vscode.window.showInformationMessage(
        `pie browser server restarted${before.url === outcome.url ? '' : ` — ${outcome.url}`}`,
      );
      return;
    }
    if (outcome.kind === 'disabled') {
      void vscode.window.showWarningMessage('pie browser server is disabled (`pie.browserServer.enabled`).');
      return;
    }
    void vscode.window.showErrorMessage(`pie browser server failed to start: ${outcome.reason}`);
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    this.shutdownPromise = (async () => {
      if (this.ownershipRefused) {
        // Ownership was never acquired; the runtime was never started.
        return;
      }
      // The runtime owns the ordered backend/analytics/service teardown. The
      // VS Code shell surfaces are released after that order completes,
      // matching the previous single-composition shutdown sequence.
      await this.runtime.shutdown();
      this.sidebarProvider.dispose();
      this.statusBar.dispose();
      // Machine-wide ownership is released last: only after shutdown has
      // actually finished does the coordinator port become available to a
      // waiting VS Code window.
      if (this.hostOwnership) {
        try {
          await this.hostOwnership.release();
        } catch (error) {
          appendPieLog('warn', 'host-coordinator', 'host ownership release failed', {
            error: toErrorMessage(error),
          });
        }
        this.hostOwnership = null;
      }
    })();

    await this.shutdownPromise;
  }

  dispose(): void {
    void this.shutdown();
  }
}

/** Sidebar-backed {@link HostRendererSurface}: every member delegates to the
 *  sidebar provider's existing public surface, so renderer hub identity,
 *  delivery fences, and browser-scoped routing behave exactly as before. */
function createSidebarRendererSurface(provider: SidebarViewProvider): HostRendererSurface {
  return {
    postState: () => provider.postState(),
    postImperative: (message) => provider.postImperative(message),
    postImperativeToRenderer: (rendererId, message) => provider.postImperativeToRenderer(rendererId, message),
    scheduleState: () => provider.scheduleState(),
    reveal: () => provider.reveal(),
    getHostInstanceId: () => provider.getHostInstanceId(),
    getViewGeneration: () => provider.getViewGeneration(),
    isRendererOwnerCurrent: (rendererId, viewGeneration, rendererGeneration) =>
      provider.isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration),
  };
}