import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { test as base, expect } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';

import { BrowserServer } from '../../../application/hosts/browser/http/browser-server.js';
import type { BrowserServerOptions } from '../../../application/hosts/browser/types.js';
import { EMPTY_VIEW_STATE } from '../../../application/frontend/lib/hooks/use-host-sync.js';
import type { SessionSummary, ViewState } from '../../../application/lib/protocol/index.js';

interface IsolatedHost {
  url: string;
}

type Fixtures = {
  isolatedHost: IsolatedHost;
  context: BrowserContext;
  viewState: Partial<ViewState>;
};

const assetDir = path.resolve(__dirname, '../../../application/hosts/vscode/out/webview/panel');

async function startIsolatedHost(viewStateOverrides: Partial<ViewState>): Promise<{ host: IsolatedHost; dispose: () => Promise<void> }> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'pie-ui-smoke-'));
  const settingsDir = path.join(tempRoot, 'settings');
  const dataDir = path.join(tempRoot, 'data');
  let server: BrowserServer | undefined;

  try {
    await Promise.all([
      mkdir(settingsDir, { recursive: true }),
      mkdir(dataDir, { recursive: true }),
    ]);
    // The disposable host has no SDK/backend and reads no ambient Pie config.
    // Keep explicit empty settings/data roots available for this isolated run;
    // neither real credentials nor user data are copied into them.
    await writeFile(path.join(settingsDir, 'settings.json'), '{}\n', 'utf8');
    await writeFile(path.join(settingsDir, 'models.json'), '{}\n', 'utf8');

    const session: SessionSummary = {
      path: path.join(dataDir, 'ui-smoke-session.jsonl'),
      name: 'Disposable UI smoke session',
      cwd: tempRoot,
      modifiedAt: new Date().toISOString(),
      messageCount: 0,
    };
    const viewState: ViewState = {
      ...EMPTY_VIEW_STATE,
      backendReady: true,
      sessions: [session],
      openTabPaths: [session.path],
      activeSession: session,
      transcriptLoaded: true,
      workspaceCwd: tempRoot,
      ...viewStateOverrides,
    };
    const activeServer: { current?: BrowserServer } = {};
    const options: BrowserServerOptions = {
      getSettings: () => ({ enabled: true, port: 0, allowLan: false, requirePreferredPort: true }),
      getViewState: () => viewState,
      getRunningSessionCount: () => 0,
      routeMessage: async (message, context) => {
        // Mirror the host's renderer handshake while deliberately ignoring
        // commands: smoke coverage needs a usable shell, not a real backend.
        if (message.type === 'ready' || message.type === 'refreshState' || message.type === 'requestSnapshot') {
          activeServer.current?.requestState(context.rendererId);
        }
      },
      assetDir,
    };
    server = new BrowserServer(options);
    activeServer.current = server;
    const outcome = await server.start();
    if (outcome.kind !== 'started') {
      throw new Error(`Isolated browser test host failed to start: ${outcome.kind === 'failed' ? outcome.reason : outcome.kind}`);
    }

    return {
      host: { url: outcome.url },
      dispose: async () => {
        await server?.stop();
        server?.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await server?.stop();
    server?.dispose();
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}

export const test = base.extend<Fixtures>({
  viewState: [{}, { option: true }],
  isolatedHost: async ({ viewState }, use) => {
    const fixture = await startIsolatedHost(viewState);
    try {
      await use(fixture.host);
    } finally {
      await fixture.dispose();
    }
  },
  context: async ({ browser, contextOptions, isolatedHost }, use) => {
    const context = await browser.newContext({ ...contextOptions, baseURL: isolatedHost.url });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
});

export { expect };
