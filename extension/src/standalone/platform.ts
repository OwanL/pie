import * as crypto from 'node:crypto';
import * as path from 'node:path';
import type { Writable } from 'node:stream';

import type { HostToWebviewMessage } from '../shared/protocol';
import type { PieDataRootPaths } from '../../../shared/pie-data-root';
import type { RuntimeGenerationIdentity } from '../host/analytics-handoff-discovery';
import type { BrowserServer } from '../host/browser-server/browser-server';
import type { BrowserServerSettings } from '../host/browser-server/types';
import type { FileDiffCoreLike, FileDiffViewerLike } from '../host/core/file-diff-service';
import type {
  HostEditorCapabilities,
  HostNotifications,
  HostRendererSurface,
  HostRuntimePlatform,
} from '../host/runtime/platform';
import {
  BROWSER_SERVER_ALLOW_LAN_STORAGE_KEY,
  readBrowserServerSettings,
} from '../host/browser-server/settings';
import { StandaloneHostStorage } from './storage';
import type { StandaloneDependencyPaths } from './startup';

const UNSUPPORTED_EDITOR_MESSAGE = 'Opening files in VS Code is unavailable in standalone mode.';

/** Structural subset used by the facade so its routing remains easy to test
 * without constructing a second renderer hub or a real HTTP server. */
export interface StandaloneBrowserServerSurface {
  scheduleState(): void;
  scheduleSelectionState(): void;
  requestState(rendererId: string): void;
  postImperative(message: HostToWebviewMessage, rendererId: string): void;
  isRendererOwnerCurrent(rendererId: string, viewGeneration: number, rendererGeneration: number): boolean;
  getHub(): {
    requestState(target: string | 'all'): void;
    postImperative(message: HostToWebviewMessage, target?: string | 'all'): void;
  };
}

/**
 * Renderer surface for a browser-only host. Every renderer operation goes to
 * the BrowserServer's existing hub; this class deliberately does not create a
 * sidebar-compatible hub of its own.
 */
export class StandaloneBrowserRendererFacade implements HostRendererSurface {
  private readonly hostInstanceId = crypto.randomUUID();

  constructor(private readonly getBrowserServer: () => StandaloneBrowserServerSurface) {}

  postState(): void {
    this.getBrowserServer().getHub().requestState('all');
  }

  postSelectionState(): void {
    this.getBrowserServer().scheduleSelectionState();
  }

  postImperative(message: HostToWebviewMessage): void {
    this.getBrowserServer().getHub().postImperative(message);
  }

  postImperativeToRenderer(rendererId: string, message: HostToWebviewMessage): void {
    this.getBrowserServer().postImperative(message, rendererId);
  }

  requestState(rendererId?: string): void {
    if (rendererId === undefined) this.getBrowserServer().getHub().requestState('all');
    else this.getBrowserServer().requestState(rendererId);
  }

  scheduleState(): void {
    this.getBrowserServer().scheduleState();
  }

  /** There is no desktop sidebar to reveal in standalone mode. */
  reveal(): void {
    // The browser URL is printed by the entry point; no fake VS Code reveal.
  }

  getHostInstanceId(): string {
    return this.hostInstanceId;
  }

  /** Browser view generations are renderer-owned, not host-owned. */
  getViewGeneration(): number {
    return 0;
  }

  isRendererOwnerCurrent(rendererId: string, viewGeneration: number, rendererGeneration: number): boolean {
    return this.getBrowserServer().isRendererOwnerCurrent(rendererId, viewGeneration, rendererGeneration);
  }
}

export interface StandaloneHostRuntimePlatformOptions {
  workspaceCwd: string;
  extensionPath: string;
  runtimeOutputDirectory: string;
  dataPaths: PieDataRootPaths;
  dependencies: StandaloneDependencyPaths;
  runtimeIdentity?: RuntimeGenerationIdentity;
  storage?: StandaloneHostStorage;
  browserServerSettings?: Partial<BrowserServerSettings>;
  output?: { stdout?: Writable; stderr?: Writable };
  getBrowserServer: () => BrowserServer | undefined;
}

function writeLine(stream: Writable | undefined, message: string): void {
  if (!stream) return;
  stream.write(`${message}\n`);
}

function normalizeWorkspacePath(workspaceCwd: string): string {
  const normalized = path.resolve(workspaceCwd).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Browser-only file viewer. Unsupported desktop editor actions reject so the
 * existing effect/result and notice path reports the limitation; no success
 * message claims that VS Code opened anything. */
class StandaloneFileDiffViewer implements FileDiffViewerLike {
  async openFileDiff(): Promise<void> {
    throw new Error('Opening file diffs in VS Code is unavailable in standalone mode.');
  }

  async openFileInEditor(): Promise<void> {
    throw new Error(UNSUPPORTED_EDITOR_MESSAGE);
  }
}

export function createStandaloneHostRuntimePlatform(
  options: StandaloneHostRuntimePlatformOptions,
): HostRuntimePlatform {
  const renderer = new StandaloneBrowserRendererFacade(() => {
    const server = options.getBrowserServer();
    if (!server) throw new Error('Standalone browser server is not constructed.');
    return server;
  });
  const stdout = options.output?.stdout;
  const stderr = options.output?.stderr;
  const postNotice = (message: string, kind: 'info' | 'warning' | 'error'): void => {
    writeLine(kind === 'error' ? stderr : stdout, `[pie ${kind}] ${message}`);
    try {
      renderer.postImperative({ type: 'rendererNotice', message, kind });
    } catch {
      // Startup diagnostics can happen before a browser server is constructed.
    }
  };
  const browserSettings = options.browserServerSettings;
  const storage = options.storage ?? new StandaloneHostStorage({
    stateDir: options.dataPaths.stateDir,
    workspaceCwd: options.workspaceCwd,
  });

  const notifications: HostNotifications = {
    showWarningMessage: (message) => postNotice(message, 'warning'),
    showInformationMessage: (message) => postNotice(message, 'info'),
    showErrorMessage: (message) => postNotice(message, 'error'),
    showModalConfirm: async (message) => {
      postNotice(`${message} Desktop confirmation is unavailable in standalone mode.`, 'warning');
      return undefined;
    },
    // Browser focus is tracked by the browser renderer, not by this Node
    // process. Treat standalone as unfocused so completion attention remains
    // visible through the browser renderer.
    isWindowFocused: () => false,
  };

  const editor: HostEditorCapabilities = {
    openFilePicker: async () => {
      postNotice('File picking is unavailable in standalone mode.', 'warning');
      return undefined;
    },
    openSettings: async () => {
      postNotice('Opening VS Code settings is unavailable in standalone mode.', 'warning');
    },
    openFileInEditor: async () => {
      throw new Error(UNSUPPORTED_EDITOR_MESSAGE);
    },
  };

  return {
    storage,
    extensionPath: options.extensionPath,
    getRuntimeOutputDirectory: () => options.runtimeOutputDirectory,
    getWorkspaceCwd: () => options.workspaceCwd,
    getSetting: <T>(name: string, fallbackName?: string): T | undefined => {
      const values: Record<string, string | boolean | undefined> = {
        nodePath: options.dependencies.nodePath,
        sdkPath: options.dependencies.sdkPath,
        agentDir: options.dependencies.agentDir,
        allowInTreeAuth: process.env.PIE_ALLOW_IN_TREE_AUTH === '1',
      };
      const value = values[name] ?? (fallbackName === undefined ? undefined : values[fallbackName]);
      return value as T | undefined;
    },
    requestWindowAttention: () => {
      postNotice('pie needs your attention.', 'info');
    },
    renderer,
    notifications,
    editor,
    getWorkspaceAnalyticsId: () => JSON.stringify({ folders: [`file:${normalizeWorkspacePath(options.workspaceCwd)}`] }),
    getLegacyWorkspaceAnalyticsIds: () => [normalizeWorkspacePath(options.workspaceCwd)],
    getRuntimeIdentity: () => options.runtimeIdentity,
    legacyUsageDataRootPath: options.dataPaths.rootDir,
    getBrowserServerSettings: () => readBrowserServerSettings({
      get: <T>(key: string, fallback: T): T => {
        if (key === 'allowLan') {
          const persisted = storage.get<unknown>(BROWSER_SERVER_ALLOW_LAN_STORAGE_KEY);
          if (typeof persisted === 'boolean') return persisted as T;
        }
        const override = browserSettings?.[key as keyof BrowserServerSettings];
        return (override === undefined ? fallback : override) as T;
      },
    }),
    setBrowserServerLanEnabled: async (enabled) => {
      await storage.update(BROWSER_SERVER_ALLOW_LAN_STORAGE_KEY, enabled);
    },
    // Standalone fails closed: every renderer surface is served by this very
    // listener, so stopping it would orphan the only UI. The webview never
    // renders the switch (`serverToggleAvailable` is false); a direct command
    // is rejected instead of stopping the sole UI.
    setBrowserServerEnabled: async () => {
      throw new Error('Standalone mode serves its only UI through the browser server; the listener cannot be stopped.');
    },
    getWorkspaceFolderPath: () => options.workspaceCwd,
    getRendererSelection: () => ({
      fallbackDir: path.join(options.runtimeOutputDirectory, 'webview', 'panel'),
      notBefore: 0,
    }),
    getWorkspaceName: () => path.basename(options.workspaceCwd),
    getExperimentAssignment: () => process.env.PIE_EXPERIMENT_ASSIGNMENT?.trim() || null,
    reloadWindow: () => {
      throw new Error('Controlled analytics restart is unavailable in standalone mode.');
    },
    createFileDiffViewer: (_service: FileDiffCoreLike) => new StandaloneFileDiffViewer(),
  };
}

export function standaloneUnsupportedEditorMessage(): string {
  return UNSUPPORTED_EDITOR_MESSAGE;
}
