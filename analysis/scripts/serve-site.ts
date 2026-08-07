#!/usr/bin/env node
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCliOptions, formatUsage } from './cli.ts';
import { prepareSourceAnalytics } from './prepare.ts';
import { listenOnLocalhost } from './serve-site-listen.ts';
import { resolveSiteRequestPath } from './serve-site-paths.ts';
import {
  buildSiteDataBundle,
  readSiteDataBundle,
  validateSiteDataBundle,
  writeSiteData,
} from './site-data.ts';
import {
  DEFAULT_OUTCOMES_ROOT,
  DEFAULT_SITE_DATA_DIR,
  loadSourceAnalytics,
} from './source.ts';
import { listStorageDirCandidates } from './source-auto.ts';
import { toErrorMessage } from '../../shared/error-message.js';

const SITE_ROOT = fileURLToPath(new URL('../site', import.meta.url));
const DEFAULT_PORT = 4173;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function canServeExistingSiteData(outputDir: string): Promise<boolean> {
  try {
    const bundle = await readSiteDataBundle(outputDir);
    validateSiteDataBundle(bundle);
    return true;
  } catch {
    return false;
  }
}

async function isUsableStorageDir(storageDir: string): Promise<boolean> {
  const parentDir = path.dirname(storageDir);
  const normalizedTarget = path.resolve(storageDir);
  const candidates = await listStorageDirCandidates(parentDir);
  return candidates.some((candidate) => path.resolve(candidate.storageDir) === normalizedTarget);
}

interface ResolvedSourceSelection {
  selection: { exportPath?: string; storageDir?: string; outcomesRoot?: string };
  message?: string;
}

async function resolveServeSourceSelection(options: ReturnType<typeof parseCliOptions>): Promise<ResolvedSourceSelection | null> {
  if (options.exportPath) {
    return { selection: { exportPath: options.exportPath } };
  }

  if (options.storageDir) {
    if (!(await isUsableStorageDir(options.storageDir))) {
      throw new Error(`No run-analytics artifacts found in --storage-dir ${options.storageDir}.`);
    }
    return { selection: { storageDir: options.storageDir } };
  }

  // Default: aggregate every run store under the outcomes root so the dashboard
  // reports across all workspaces (including migrated data from old repo
  // paths). Use --storage-dir / --export to narrow to a single source.
  const candidates = await listStorageDirCandidates(DEFAULT_OUTCOMES_ROOT);
  if (candidates.length === 0) {
    return null;
  }

  return {
    selection: {},
    message: `[pie-analysis] Aggregating ${candidates.length} run store(s) under ${DEFAULT_OUTCOMES_ROOT}`,
  };
}

async function refreshSiteDataForServe(options: ReturnType<typeof parseCliOptions>): Promise<void> {
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_SITE_DATA_DIR);
  const canonicalOutputDir = path.resolve(DEFAULT_SITE_DATA_DIR);
  if (outputDir !== canonicalOutputDir) {
    throw new Error(`Serve expects site data at ${canonicalOutputDir}; received --output-dir ${outputDir}.`);
  }

  const resolvedSelection = await resolveServeSourceSelection(options);
  if (!resolvedSelection) {
    if (await canServeExistingSiteData(outputDir)) {
      console.warn(`[pie-analysis] No local analytics source detected under ${DEFAULT_OUTCOMES_ROOT}; serving existing generated site data.`);
      return;
    }

    throw new Error(
      `No local analytics source detected under ${DEFAULT_OUTCOMES_ROOT}. Run pie first, or pass --storage-dir / --export.`,
    );
  }

  if (resolvedSelection.message) {
    console.log(resolvedSelection.message);
  }

  const loaded = await loadSourceAnalytics(resolvedSelection.selection);
  const prepared = prepareSourceAnalytics(loaded.source);
  const bundle = buildSiteDataBundle(prepared);

  validateSiteDataBundle(bundle);
  await writeSiteData(outputDir, bundle);

  console.log(`Site data refreshed from ${loaded.sourceKind} source: ${loaded.sourcePath}`);
  console.log(`Workspace key: ${loaded.source.workspaceKey} · exported: ${loaded.source.exportedAt}`);
  console.log(`Runs loaded: ${prepared.runs.length}`);
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(formatUsage('npm run serve --', 'Serve the built analytics dashboard over localhost.'));
    return;
  }

  await refreshSiteDataForServe(options);

  const port = options.port ?? DEFAULT_PORT;
  const server = http.createServer(async (request, response) => {
    try {
      const filePath = resolveSiteRequestPath(SITE_ROOT, request.url ?? '/');
      const data = await fs.readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
      response.end(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Not found';
      const statusCode = message === 'Invalid path.' ? 400 : 404;
      response.writeHead(statusCode, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      });
      response.end(statusCode === 400 ? 'Bad request' : 'Not found');
    }
  });

  await listenOnLocalhost(server, port);
  console.log(`pie analytics dashboard available at http://127.0.0.1:${port}`);
  console.log('Press Ctrl+C to stop the local server.');
}

main().catch((error) => {
  console.error('serve failed:', toErrorMessage(error));
  process.exitCode = 1;
});
