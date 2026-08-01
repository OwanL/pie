import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { withCatalogLock } from './src/catalog-lock.js';
import { CopilotCatalogRefreshCoordinator } from './src/catalog-refresh.js';
import { FileCatalogRefreshTiming } from './src/catalog-ttl.js';
import { reconcileCatalogText, type CatalogReconciliation } from './src/catalog-sync.js';
import { COPILOT_HEADERS, parseCopilotModelsResponse } from './src/copilot-models.js';

const PROVIDER = 'github-copilot';
const DISCOVERY_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

// A bounded, cross-process TTL gate avoids a network fetch, reconciliation, and
// codegen on every session startup. The marker is shared across VS Code windows
// through the agent directory; a missing or corrupt file is treated as stale.
const timing = new FileCatalogRefreshTiming(
  path.join(getAgentDir(), '.copilot-catalog-sync.json'),
);

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function syncGeneratedCatalog(root: string): Promise<void> {
  await execFileAsync(process.execPath, [path.join(root, 'scripts', 'sync-models.mjs')], {
    cwd: root,
    windowsHide: true,
  });
}

async function commitCatalog(
  root: string,
  catalogPath: string,
  remoteModels: Parameters<typeof reconcileCatalogText>[1],
): Promise<CatalogReconciliation> {
  return withCatalogLock(`${catalogPath}.copilot-sync.lock`, async () => {
    // Read only after acquiring the cross-process lock. Another VS Code window
    // may have committed a newer catalog while this process fetched /models.
    const originalCatalog = await readFile(catalogPath, 'utf8');
    const reconciliation = reconcileCatalogText(originalCatalog, remoteModels);
    if (!reconciliation.changed) return reconciliation;

    await atomicWrite(catalogPath, reconciliation.text);
    try {
      await syncGeneratedCatalog(root);
    } catch (error) {
      // Source and generated surfaces are one transaction while the lock is
      // held, so no other process can observe and overwrite a partial commit.
      await atomicWrite(catalogPath, originalCatalog);
      await syncGeneratedCatalog(root).catch(() => undefined);
      throw error;
    }
    return reconciliation;
  });
}

async function syncCopilotCatalog(registry: ExtensionContext['modelRegistry']): Promise<void> {
  const currentModels = registry.getAll().filter((model) => model.provider === PROVIDER);
  if (currentModels.length === 0) return;

  const root = getAgentDir();
  const catalogPath = path.join(root, 'models.yaml');
  // ModelRegistry refreshes and persists the OAuth credential when needed.
  const apiKey = await registry.getApiKeyForProvider(PROVIDER);
  if (!apiKey) return;

  const baseUrl = currentModels[0].baseUrl.replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...COPILOT_HEADERS,
      'X-GitHub-Api-Version': '2026-06-01',
    },
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Copilot catalog sync returned HTTP ${response.status}`);

  const remoteModels = parseCopilotModelsResponse(await response.json());
  if (remoteModels.length === 0) {
    throw new Error('Copilot catalog returned no selectable models; preserving the existing catalog');
  }

  // pi-ai filters Copilot models through this credential-scoped list. Keep it
  // aligned even when the access token was still fresh and OAuth refresh did
  // not run, otherwise newly cataloged models remain hidden until expiry.
  const credential = registry.authStorage.get(PROVIDER);
  const availableModelIds = remoteModels.map((model) => model.id);
  if (credential?.type === 'oauth') {
    const previousIds = 'availableModelIds' in credential && Array.isArray(credential.availableModelIds)
      ? credential.availableModelIds
      : [];
    const availabilityChanged = previousIds.length !== availableModelIds.length
      || previousIds.some((id, index) => id !== availableModelIds[index]);
    if (availabilityChanged) {
      registry.authStorage.set(PROVIDER, { ...credential, availableModelIds });
    }
  }

  const reconciliation = await commitCatalog(root, catalogPath, remoteModels);
  if (!reconciliation.changed) {
    await timing.markRefreshed();
    console.info(`[copilot-model-discovery] Catalog current: ${remoteModels.length} selectable models`);
    return;
  }

  const summary = [
    reconciliation.added.length > 0 ? `added ${reconciliation.added.join(', ')}` : '',
    reconciliation.removed.length > 0 ? `removed ${reconciliation.removed.join(', ')}` : '',
  ].filter(Boolean).join('; ');
  // Cache only after the authoritative source and generated catalog commit.
  // The coordinator refreshes each participating live registry after this
  // function returns; future sessions load the committed catalog on creation.
  await timing.markRefreshed();
  console.info(`[copilot-model-discovery] Catalog synchronized: ${summary}`);
}

// `markRefreshed` is invoked inside `syncCopilotCatalog` after a successful
// commit, so a failed or not-yet-configured refresh is not cached.
const coordinator = new CopilotCatalogRefreshCoordinator<ExtensionContext['modelRegistry']>(syncCopilotCatalog);

export default function registerCopilotModelDiscovery(pi: ExtensionAPI): void {
  pi.on('session_start', async (_event, ctx) => {
    try {
      // Skip the network/catalog work entirely when a recent refresh already
      // verified the catalog. Each session's ModelRegistry loads the current
      // models.json at creation, so no live-registry reload is needed here.
      if (await timing.isFresh()) return;
      await coordinator.refresh(ctx.modelRegistry);
    } catch (error) {
      // A failure is not cached: the next session startup retries discovery.
      console.warn('[copilot-model-discovery] Catalog unchanged:', error instanceof Error ? error.message : error);
    }
  });

  // Explicit, user-initiated refresh that bypasses the TTL gate.
  pi.registerCommand('copilot-sync-models', {
    description: 'Force-refresh the GitHub Copilot model catalog now, bypassing the TTL cache',
    handler: async (_args, ctx) => {
      try {
        await coordinator.refresh(ctx.modelRegistry);
        ctx.ui.notify('Copilot catalog refreshed', 'info');
      } catch (error) {
        ctx.ui.notify(
          `Copilot catalog refresh failed: ${error instanceof Error ? error.message : error}`,
          'error',
        );
      }
    },
  });
}
