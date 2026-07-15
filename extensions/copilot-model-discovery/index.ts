import { execFile } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

import { reconcileCatalogText } from './src/catalog-sync.js';
import { COPILOT_HEADERS, parseCopilotModelsResponse } from './src/copilot-models.js';

const PROVIDER = 'github-copilot';
const DISCOVERY_TIMEOUT_MS = 5_000;
const initializedRegistries = new WeakSet<object>();
const execFileAsync = promisify(execFile);

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
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

async function syncCopilotCatalog(ctx: ExtensionContext): Promise<void> {
  const registry = ctx.modelRegistry;
  if (initializedRegistries.has(registry)) return;
  initializedRegistries.add(registry);

  const currentModels = registry.getAll().filter((model) => model.provider === PROVIDER);
  if (currentModels.length === 0) return;

  const root = getAgentDir();
  const catalogPath = path.join(root, 'models.yaml');
  let originalCatalog: string | undefined;
  try {
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
    // pi-ai filters Copilot models through this credential-scoped list. Keep it
    // aligned even when the access token was still fresh and OAuth refresh did
    // not run, otherwise newly cataloged models remain hidden until expiry.
    const credential = registry.authStorage.get(PROVIDER);
    const availableModelIds = remoteModels.map((model) => model.id);
    let availabilityChanged = false;
    if (credential?.type === 'oauth') {
      const previousIds = 'availableModelIds' in credential && Array.isArray(credential.availableModelIds)
        ? credential.availableModelIds
        : [];
      availabilityChanged = previousIds.length !== availableModelIds.length
        || previousIds.some((id, index) => id !== availableModelIds[index]);
      if (availabilityChanged) {
        registry.authStorage.set(PROVIDER, { ...credential, availableModelIds });
      }
    }
    originalCatalog = await readFile(catalogPath, 'utf8');
    const reconciliation = reconcileCatalogText(originalCatalog, remoteModels);
    if (!reconciliation.changed) {
      if (availabilityChanged) registry.refresh();
      return;
    }

    await atomicWrite(catalogPath, reconciliation.text);
    try {
      await syncGeneratedCatalog(root);
    } catch (error) {
      // Keep source and generated catalog transactional if validation/codegen fails.
      await atomicWrite(catalogPath, originalCatalog);
      await syncGeneratedCatalog(root).catch(() => undefined);
      throw error;
    }

    registry.refresh();
    const summary = [
      reconciliation.added.length > 0 ? `added ${reconciliation.added.join(', ')}` : '',
      reconciliation.removed.length > 0 ? `removed ${reconciliation.removed.join(', ')}` : '',
      reconciliation.transferred.length > 0 ? `transferred ${reconciliation.transferred.join(', ')}` : '',
      reconciliation.skippedConflicts.length > 0 ? `skipped conflicts ${reconciliation.skippedConflicts.join(', ')}` : '',
    ].filter(Boolean).join('; ');
    console.info(`[copilot-model-discovery] Catalog synchronized: ${summary}`);
  } catch (error) {
    // Network/auth failures leave models.yaml and all generated files untouched.
    console.warn('[copilot-model-discovery] Catalog unchanged:', error instanceof Error ? error.message : error);
  }
}

export default function registerCopilotModelDiscovery(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => syncCopilotCatalog(ctx));
}
