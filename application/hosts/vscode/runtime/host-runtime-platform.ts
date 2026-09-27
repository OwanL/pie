import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { HostRuntimePlatform, HostRendererSurface } from '../../lib/platform-contracts/platform.js';
import { buildWorkspaceAnalyticsId } from '../../../../analytics/legacy/run-analytics/storage';
import { requestWindowAttention } from '../completion-attention.js';
import type { SessionHostPlatform } from '../../lib/platform-contracts/session-platform';
import { selectRuntimeSetting } from '../../lib/platform-contracts/session-platform';
import { createBrowserServer } from '../../browser/http/browser-server-factory.js';
import { showPieLogs } from '../logging/pie-logger-adapter.js';
import { readBrowserServerSettings } from '../../browser/settings';
import type { RuntimeGenerationIdentity } from '../../../../analytics/authority/analytics-handoff-discovery';
import type { FileDiffCoreLike, FileDiffViewerLike } from '../../../backend/file-changes/file-diff-service';
import { VscodeFileDiffViewer } from '../editor-integration/file-diff';
import {
  openFileWithFallback,
  readImagePreviewWithFallback,
  type FilePathResolverAdapter,
} from '../editor-integration/open-file';
import { runtimeOutputDirectory, runtimeRendererSelection } from './runtime-location';
import { appendPieLog } from '../../../../lib/structured-logging/pie-logger';
import { toErrorMessage } from '../../../../lib/structured-logging/error-message';
import { bootLog } from '../../../../lib/structured-logging/pie-logger';
import { resolveSettingsPath } from '../../../backend/settings/settings-path';

const NO_WORKSPACE_ANALYTICS_ID_KEY = 'pie.analytics.noWorkspaceId';

/** VS Code workspace analytics identity. The first call for a window without
 *  any workspace persists a generated no-workspace id; later calls reuse it. */
function getWorkspaceAnalyticsId(context: vscode.ExtensionContext): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  const workspaceFile = vscode.workspace.workspaceFile;

  if (workspaceFolders?.length || workspaceFile) {
    return buildWorkspaceAnalyticsId({
      workspaceFolders,
      workspaceFile,
      noWorkspaceId: 'workspace',
    });
  }

  const existingNoWorkspaceId = context.workspaceState.get<string>(NO_WORKSPACE_ANALYTICS_ID_KEY)?.trim();
  const noWorkspaceId = existingNoWorkspaceId || crypto.randomUUID();

  if (!existingNoWorkspaceId) {
    void context.workspaceState.update(NO_WORKSPACE_ANALYTICS_ID_KEY, noWorkspaceId).then(undefined, (err) =>
      appendPieLog('warn', 'globalState', 'update failed', {
        key: NO_WORKSPACE_ANALYTICS_ID_KEY,
        error: toErrorMessage(err),
      })
    );
  }

  return buildWorkspaceAnalyticsId({
    workspaceFolders,
    workspaceFile,
    noWorkspaceId,
  });
}

/** VS Code runtime generation identity from the loaded extension manifest. */
function getPieRuntimeIdentity(context: vscode.ExtensionContext): RuntimeGenerationIdentity | undefined {
  const packageJson = context.extension?.packageJSON as Record<string, unknown> | undefined;
  if (!packageJson) return undefined;
  const publisher = packageJson.publisher;
  const name = packageJson.name;
  const version = packageJson.version;
  if (typeof publisher !== 'string' || typeof name !== 'string' || typeof version !== 'string'
    || publisher.length === 0 || name.length === 0 || version.length === 0) {
    return undefined;
  }
  return { publisher, name, version };
}

function getLegacyWorkspaceAnalyticsIds(): string[] {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders?.length) {
    return [
      workspaceFolders
        .map((folder) => folder.uri.toString())
        .sort((left, right) => left.localeCompare(right))
        .join('|'),
    ];
  }

  return [vscode.workspace.name ?? 'no-workspace'];
}

/** VS Code adapter for the session service's platform-neutral host seam
 *  (`session-service/platform.ts`). Workspace-dependent reads stay lazy so the
 *  adapter always reflects the window's current state; the persisted storage
 *  keys and the `pie` → `piAssistant` setting fallback are identical to the
 *  previous direct `vscode.ExtensionContext` usage. */
function createSessionHostPlatform(context: vscode.ExtensionContext): SessionHostPlatform {
  return {
    storage: {
      get: (key) => context.globalState.get(key),
      update: (key, value) => context.globalState.update(key, value),
    },
    extensionPath: context.extensionPath,
    getRuntimeOutputDirectory: () => runtimeOutputDirectory(context),
    getWorkspaceCwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    getSetting: <T>(name: string, fallbackName?: string): T | undefined => {
      const config = vscode.workspace.getConfiguration('pie');
      if (fallbackName === undefined) return config.get<T>(name);
      // Exact legacy fallback: a `pie` value that is absent or empty after
      // trimming defers to the root `piAssistant.<fallbackName>` setting.
      return selectRuntimeSetting(
        config.get<string>(name),
        vscode.workspace.getConfiguration().get<string>(`piAssistant.${fallbackName}`),
      ) as unknown as T | undefined;
    },
    requestWindowAttention: () => requestWindowAttention(
      vscode.env.appName,
      vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name,
    ),
  };
}

/** VS Code adapter for the router's settings recovery action. */
async function openVscodeSettings(): Promise<void> {
  const settingsPath = resolveSettingsPath();
  if (settingsPath) {
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(settingsPath));
      await vscode.window.showTextDocument(doc);
      return;
    } catch (err) {
      bootLog('webview', 'openSettings.openFileFailed', { settingsPath, error: String(err) });
    }
  }
  await vscode.commands.executeCommand('workbench.action.openSettings', 'pie');
}

/** One resolver shared by open-file and image-preview actions, preserving the
 * same VS Code workspace search behavior and renderer-captured cwd fences. */
function createFilePathResolver(): FilePathResolverAdapter {
  return {
    exists: async (filePath) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        return true;
      } catch (error) {
        const code = typeof error === 'object' && error !== null
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === 'FileNotFound' || code === 'ENOENT') return false;
        throw error;
      }
    },
    findFiles: async (workingDirectory, basename) => {
      const escapedBasename = basename.replace(/[\\*?\x5b\]{}]/g, '\\$&');
      const include = new vscode.RelativePattern(
        vscode.Uri.file(workingDirectory),
        `**/${escapedBasename}`,
      );
      const matches = await vscode.workspace.findFiles(include);
      return matches.map((uri) => uri.fsPath);
    },
  };
}

/** VS Code adapters for the shared {@link HostRuntime} platform seam
 *  (`application/hosts/lib/platform-contracts/platform.ts`). Every member mirrors the exact behavior of
 *  the previous direct `vscode` usage in the extension-host composition;
 *  workspace-dependent reads stay lazy so the adapter always reflects the
 *  window's current state. */
export function createVscodeHostRuntimePlatform(
  context: vscode.ExtensionContext,
  renderer: HostRendererSurface,
): HostRuntimePlatform {
  const sessionPlatform = createSessionHostPlatform(context);
  return {
    ...sessionPlatform,
    createBrowserServer: (options) => createBrowserServer({
      ...options,
      assetDir: path.join(context.extensionPath, 'out', 'webview', 'panel'),
      rendererSelection: runtimeRendererSelection(context),
      iconPath: path.join(context.extensionPath, 'media', 'icon.svg'),
      titleSuffix: vscode.workspace.name ?? undefined,
    }),
    renderer,
    notifications: {
      showWarningMessage: (message) => { void vscode.window.showWarningMessage(message); },
      showInformationMessage: (message) => { void vscode.window.showInformationMessage(message); },
      showErrorMessage: (message) => { void vscode.window.showErrorMessage(message); },
      // A modal VS Code warning dialog. The reducer owns the question text +
      // confirm button label; the adapter is a thin executor.
      showModalConfirm: (message, confirmChoice) =>
        vscode.window.showWarningMessage(message, { modal: true }, confirmChoice),
      isWindowFocused: () => vscode.window.state.focused,
    },
    editor: {
      openFilePicker: async (options) => {
        const uris = await vscode.window.showOpenDialog({
          canSelectMany: true,
          canSelectFiles: true,
          canSelectFolders: true,
          openLabel: options.openLabel,
          title: options.title,
        });
        return uris?.map((uri) => uri.fsPath);
      },
      openSettings: openVscodeSettings,
      openFileInEditor: async (filePath, options) => {
        await openFileWithFallback({ path: filePath, ...options }, {
          ...createFilePathResolver(),
          chooseFile: async (files, workingDirectory, basename) => {
            const items = files.map((fullPath) => ({
              label: path.relative(workingDirectory, fullPath) || path.basename(fullPath),
              description: fullPath,
              fullPath,
            }));
            const selected = await vscode.window.showQuickPick(items, {
              placeHolder: `Select which ${basename} to open`,
            });
            return selected?.fullPath;
          },
          open: async (candidate) => {
            await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(candidate));
          },
          showError: (message) => { void vscode.window.showErrorMessage(message); },
        });
      },
      previewImageFile: async (filePath, options) => readImagePreviewWithFallback(
        { path: filePath, ...options },
        {
          ...createFilePathResolver(),
          readFile: async (candidate, maxBytes) => {
            const handle = await fs.open(candidate, 'r');
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.size > maxBytes) throw new Error('Preview file exceeds its size bound.');
              const buffer = Buffer.alloc(maxBytes + 1);
              let bytesRead = 0;
              while (bytesRead < buffer.length) {
                const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
                if (result.bytesRead === 0) break;
                bytesRead += result.bytesRead;
                if (bytesRead > maxBytes) throw new Error('Preview file exceeds its size bound.');
              }
              return buffer.subarray(0, bytesRead);
            } finally {
              await handle.close();
            }
          },
        },
      ),
    },
    getWorkspaceAnalyticsId: () => getWorkspaceAnalyticsId(context),
    getLegacyWorkspaceAnalyticsIds: () => getLegacyWorkspaceAnalyticsIds(),
    getRuntimeIdentity: () => getPieRuntimeIdentity(context),
    showLogs: () => showPieLogs(true),
    legacyUsageDataRootPath: context.globalStorageUri.fsPath,
    getBrowserServerSettings: () => {
      const config = vscode.workspace.getConfiguration('pie.browserServer');
      // LAN exposure and the automatic-start switch are machine-wide
      // authority: ignore resource/workspace values even if an older config
      // contains one, matching the global-only write below and the
      // application-scoped manifest entries.
      const globalAllowLan = config.inspect<boolean>('allowLan')?.globalValue;
      const globalEnabled = config.inspect<boolean>('enabled')?.globalValue;
      return readBrowserServerSettings({
        get: <T>(key: string, fallback: T) => key === 'allowLan'
          ? (globalAllowLan ?? fallback) as T
          : key === 'enabled'
            ? (globalEnabled ?? fallback) as T
            : config.get<T>(key, fallback),
      });
    },
    setBrowserServerLanEnabled: async (enabled) => {
      await vscode.workspace.getConfiguration('pie.browserServer')
        .update('allowLan', enabled, vscode.ConfigurationTarget.Global);
    },
    setBrowserServerEnabled: async (enabled) => {
      await vscode.workspace.getConfiguration('pie.browserServer')
        .update('enabled', enabled, vscode.ConfigurationTarget.Global);
    },
    supportsBrowserServerToggle: true,
    getWorkspaceFolderPath: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    getExperimentAssignment: () => {
      const configured = vscode.workspace
        .getConfiguration('pie')
        .get<string>('experimentAssignment', '')
        .trim();
      return configured.length > 0 ? configured : null;
    },
    reloadWindow: () => {
      void Promise.resolve(vscode.commands.executeCommand('workbench.action.reloadWindow'))
        .then(() => undefined, (error: unknown) => {
          appendPieLog('error', 'controlled-restart', 'VS Code window reload command failed', {
            error: toErrorMessage(error),
          });
        });
    },
    createFileDiffViewer: (service: FileDiffCoreLike): FileDiffViewerLike =>
      new VscodeFileDiffViewer(service),
  };
}