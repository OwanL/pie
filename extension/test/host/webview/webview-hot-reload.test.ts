import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';

import {
  activateInstalledOutput,
  findCompatibleInstalledExtensionDir,
  publishRendererGeneration,
  resolvePublishedRendererGeneration,
} from '../../../scripts/publication.mjs';
import { BrowserStaticAssets } from '../../../src/host/browser-server/static-assets';
import { isHotReloadAssetFileName } from '../../../src/host/webview/hot-reload';
import { resolvePublishedWebviewDir } from '../../../src/host/webview/published-generations';

const PACKAGE = { publisher: 'pie', name: 'pie', version: '0.3.0' } as const;

async function createRendererBuild(root: string, generation: string): Promise<string> {
  const panel = path.join(root, generation);
  await Promise.all([
    mkdir(path.join(panel, '.vite'), { recursive: true }),
    mkdir(path.join(panel, 'assets'), { recursive: true }),
  ]);
  const entry = `assets/panel-${generation}.js`;
  const css = `assets/panel-${generation}.css`;
  const lazy = `assets/lazy-${generation}.js`;
  await Promise.all([
    writeFile(path.join(panel, 'pie-build-id.txt'), `${generation}\n`),
    writeFile(path.join(panel, entry), `export const generation = '${generation}';\n`),
    writeFile(path.join(panel, css), `/* ${generation} */\n`),
    writeFile(path.join(panel, lazy), `export const lazy = '${generation}';\n`),
    writeFile(path.join(panel, '.vite', 'manifest.json'), JSON.stringify({
      'panel.tsx': { file: entry, css: [css], dynamicImports: ['lazy.ts'] as string[], isEntry: true },
      'lazy.ts': { file: lazy, isDynamicEntry: true },
    })),
  ]);
  return panel;
}

async function createInstalledExtension(
  root: string,
  folder = 'pie.pie-0.3.0',
  manifest: { publisher: string; name: string; version: string } = PACKAGE,
): Promise<string> {
  const extensionDir = path.join(root, folder);
  await mkdir(path.join(extensionDir, 'out', 'webview', 'panel'), { recursive: true });
  await Promise.all([
    writeFile(path.join(extensionDir, 'package.json'), `${JSON.stringify(manifest)}\n`),
    writeFile(path.join(extensionDir, 'out', 'extension.js'), 'host-v1'),
    writeFile(path.join(extensionDir, 'out', 'backend.js'), 'backend-v1'),
    writeFile(path.join(extensionDir, 'out', 'worker-entry.js'), 'worker-v1'),
  ]);
  return extensionDir;
}

async function startMockStreamingBackend(extensionDir: string): Promise<{
  child: ChildProcessWithoutNullStreams;
  request: (command: Record<string, unknown>) => Promise<Record<string, unknown>>;
}> {
  const workerPath = path.join(extensionDir, 'out', 'worker-entry.js');
  const backendPath = path.join(extensionDir, 'out', 'backend.js');
  await writeFile(workerPath, `
process.send?.({ type: 'ready', pid: process.pid, owner: 'session-a', generation: 7 });
setInterval(() => {}, 1000);
`);
  await writeFile(backendPath, `
const { fork } = require('node:child_process');
const readline = require('node:readline');
const worker = fork(${JSON.stringify(workerPath)}, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
let workerState;
const ready = new Promise((resolve) => worker.once('message', (message) => { workerState = message; resolve(); }));
const state = { composer: '', toolExecutions: 0, streamedChunks: 0 };
const stream = setInterval(() => { state.streamedChunks += 1; }, 2);
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  await ready;
  const command = JSON.parse(line);
  if (command.type === 'init') {
    state.composer = command.composer;
    if (state.toolExecutions === 0) state.toolExecutions += 1;
  }
  process.stdout.write(JSON.stringify({
    requestId: command.requestId,
    backendPid: process.pid,
    workerPid: workerState.pid,
    workerOwner: workerState.owner,
    workerGeneration: workerState.generation,
    ...state,
  }) + '\\n');
});
process.on('SIGTERM', () => { clearInterval(stream); worker.kill(); process.exit(0); });
`);
  const child = spawn(process.execPath, [backendPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout });
  let requestId = 0;
  return {
    child,
    request: async (command) => {
      requestId += 1;
      child.stdin.write(`${JSON.stringify({ ...command, requestId })}\n`);
      const [line] = await once(lines, 'line') as [string];
      const response = JSON.parse(line) as Record<string, unknown>;
      assert.equal(response.requestId, requestId);
      return response;
    },
  };
}

test('hot reload waits for a published generation selector', () => {
  assert.equal(isHotReloadAssetFileName('C:/pie/out/webview/panel/pie-generations'), false);
  assert.equal(isHotReloadAssetFileName('C:/pie/out/webview/panel/pie-generations/abc/assets/panel.js'), false);
  assert.equal(isHotReloadAssetFileName('C:/pie/out/webview/panel/pie-generations/selections/.pie-staging-x.json'), false);
  assert.equal(isHotReloadAssetFileName('C:/pie/out/webview/panel/pie-generations/selections/001-abc.json'), true);
  assert.equal(isHotReloadAssetFileName('C:/pie/out/webview/panel/.vite/manifest.json'), true);
  assert.equal(isHotReloadAssetFileName('panel.js.map'), false);
  assert.equal(isHotReloadAssetFileName(undefined), false);
});

test('installed selection requires matching folder identity and manifest version', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-install-identity-'));
  try {
    const wrongVersion = await createInstalledExtension(root, 'pie.pie-0.2.0', { ...PACKAGE, version: '0.2.0' });
    await createInstalledExtension(root, 'pie.pie-0.3.0', { ...PACKAGE, version: '0.2.0' });
    assert.equal(await findCompatibleInstalledExtensionDir([root], PACKAGE), null);

    await rm(wrongVersion, { recursive: true, force: true });
    const matching = await createInstalledExtension(root);
    assert.equal(await findCompatibleInstalledExtensionDir([root], PACKAGE), matching);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mock streaming session survives repeated renderer publication without host activation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-publication-acceptance-'));
  let mockChild: ChildProcessWithoutNullStreams | undefined;
  try {
    const extensionDir = await createInstalledExtension(path.join(root, 'extensions'));
    const buildsDir = path.join(root, 'builds');
    const manifestPath = path.join(extensionDir, 'package.json');
    const manifestBefore = await stat(manifestPath);
    const hostFiles = ['extension.js', 'backend.js', 'worker-entry.js'];

    // This launches real mock backend and worker processes from the installed
    // host paths. It does not claim VS Code behavior, but publication can now
    // fail the gate by replacing/stopping those processes, losing backend-owned
    // composer state, or causing the mock tool to execute twice.
    const mock = await startMockStreamingBackend(extensionDir);
    mockChild = mock.child;
    const hostBefore = await Promise.all(hostFiles.map((name) => readFile(path.join(extensionDir, 'out', name), 'utf8')));
    const initial = await mock.request({ type: 'init', composer: 'unsent draft' });
    const backendPid = initial.backendPid;
    const workerPid = initial.workerPid;
    let previousStreamCount = Number(initial.streamedChunks);

    let previousGeneration: string | null = null;
    const publishedGenerations: string[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const generation = index.toString(16).padStart(20, '0');
      const sourceDir = await createRendererBuild(buildsDir, generation);
      const publication = await publishRendererGeneration({
        sourceDir,
        extensionDir,
        now: 1_800_000_000_000 + index,
        pid: 9000,
        // Hold the pre-selection seam briefly so the independently streaming
        // mock overlaps every publication deterministically.
        beforeSelect: () => new Promise((resolve) => setTimeout(resolve, 12)),
      });
      const selectedByPublisher = await resolvePublishedRendererGeneration(path.join(extensionDir, 'out', 'webview', 'panel'));
      const selectedByHost = await resolvePublishedWebviewDir(path.join(extensionDir, 'out', 'webview', 'panel'));

      assert.equal(selectedByPublisher.generation, generation);
      assert.equal(selectedByHost, publication.generationDir);
      assert.equal((await readFile(path.join(selectedByHost, 'pie-build-id.txt'), 'utf8')).trim(), generation);
      const manifest = JSON.parse(await readFile(path.join(selectedByHost, '.vite', 'manifest.json'), 'utf8')) as Record<string, { file: string; css?: string[] }>;
      for (const chunk of Object.values(manifest)) {
        await stat(path.join(selectedByHost, chunk.file));
        for (const css of chunk.css ?? []) await stat(path.join(selectedByHost, css));
      }

      // Exercise the generation-backed browser serving path, then reconnect
      // from a full backend snapshot. The prior process owners and one tool
      // execution remain authoritative while streaming advances.
      const reloadedRenderer = new BrowserStaticAssets(path.join(extensionDir, 'out', 'webview', 'panel'));
      await reloadedRenderer.load();
      const rendered = reloadedRenderer.renderHtml({ wsRoute: '/ws', port: 1997 });
      assert.match(rendered.html, new RegExp(`panel-${generation}\\.js`));
      assert.ok(reloadedRenderer.resolveRequest(`/assets/panel-${generation}.js`));
      const snapshot = await mock.request({ type: 'snapshot' });
      assert.equal(snapshot.backendPid, backendPid);
      assert.equal(snapshot.workerPid, workerPid);
      assert.equal(snapshot.workerOwner, 'session-a');
      assert.equal(snapshot.workerGeneration, 7);
      assert.equal(snapshot.composer, 'unsent draft');
      assert.equal(snapshot.toolExecutions, 1);
      assert.ok(Number(snapshot.streamedChunks) > previousStreamCount, 'streaming must advance during publication/reload');
      previousStreamCount = Number(snapshot.streamedChunks);
      if (previousGeneration) {
        await stat(path.join(extensionDir, 'out', 'webview', 'panel', 'pie-generations', previousGeneration, 'pie-build-id.txt'));
      }
      previousGeneration = generation;
      publishedGenerations.push(generation);
    }

    // Simulate post-publication damage to the newest generation. Selection
    // validation skips it and recovers the retained prior generation.
    const selectedLatest = await resolvePublishedRendererGeneration(path.join(extensionDir, 'out', 'webview', 'panel'));
    const latestManifestPath = path.join(selectedLatest.generationDir, '.vite', 'manifest.json');
    const latestManifest = JSON.parse(await readFile(latestManifestPath, 'utf8')) as Record<string, { file: string; isEntry?: boolean; dynamicImports?: string[] }>;
    const latestEntry = Object.values(latestManifest).find((chunk) => chunk.isEntry);
    assert.ok(latestEntry);
    latestEntry.dynamicImports = ['missing-lazy-chunk.ts'];
    await writeFile(latestManifestPath, JSON.stringify(latestManifest));
    const panelDir = path.join(extensionDir, 'out', 'webview', 'panel');
    const recovered = await resolvePublishedRendererGeneration(panelDir);
    assert.equal(recovered.generation, publishedGenerations.at(-2));
    assert.equal(await resolvePublishedWebviewDir(panelDir), recovered.generationDir);

    assert.deepEqual(
      await Promise.all(hostFiles.map((name) => readFile(path.join(extensionDir, 'out', name), 'utf8'))),
      hostBefore,
      'renderer publication must not replace active host/backend/worker bundles',
    );
    assert.equal(await readFile(manifestPath, 'utf8'), `${JSON.stringify(PACKAGE)}\n`);
    assert.equal((await stat(manifestPath)).mtimeMs, manifestBefore.mtimeMs, 'ordinary publication must not touch the installed manifest');
  } finally {
    if (mockChild && mockChild.exitCode === null) {
      mockChild.kill();
      await once(mockChild, 'exit');
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent renderer publishers serialize retention without deleting each other staging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-publication-concurrent-'));
  try {
    const extensionDir = await createInstalledExtension(path.join(root, 'extensions'));
    const sources = await Promise.all([
      createRendererBuild(path.join(root, 'builds'), '11111111111111111111'),
      createRendererBuild(path.join(root, 'builds'), '22222222222222222222'),
      createRendererBuild(path.join(root, 'builds'), '33333333333333333333'),
    ]);
    await Promise.all(sources.map((sourceDir, index) => publishRendererGeneration({
      sourceDir,
      extensionDir,
      now: 100 + index,
      pid: 7000 + index,
    })));

    const publicationRoot = path.join(extensionDir, 'out', 'webview', 'panel', 'pie-generations');
    const generationDirs = (await readdir(publicationRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'selections')
      .map((entry) => entry.name);
    assert.equal(generationDirs.length, 2);
    const selected = await resolvePublishedRendererGeneration(path.join(extensionDir, 'out', 'webview', 'panel'));
    assert.ok(selected.generation && generationDirs.includes(selected.generation));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed publish leaves the selected prior generation usable', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-publication-failure-'));
  try {
    const extensionDir = await createInstalledExtension(path.join(root, 'extensions'));
    const panelDir = path.join(extensionDir, 'out', 'webview', 'panel');
    const prior = 'aaaaaaaaaaaaaaaaaaaa';
    const failed = 'bbbbbbbbbbbbbbbbbbbb';
    await publishRendererGeneration({
      sourceDir: await createRendererBuild(path.join(root, 'builds'), prior),
      extensionDir,
      now: 1,
      pid: 1,
    });

    await assert.rejects(
      publishRendererGeneration({
        sourceDir: await createRendererBuild(path.join(root, 'builds'), failed),
        extensionDir,
        now: 2,
        pid: 1,
        beforeSelect: () => { throw new Error('injected publish failure'); },
      }),
      /injected publish failure/,
    );

    const selected = await resolvePublishedRendererGeneration(panelDir);
    assert.equal(selected.generation, prior);
    assert.equal((await readFile(path.join(selected.generationDir, 'pie-build-id.txt'), 'utf8')).trim(), prior);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit activation replaces host/backend output only through its separate path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pie-explicit-activation-'));
  try {
    const extensionDir = await createInstalledExtension(path.join(root, 'extensions'));
    const sourceOutDir = path.join(root, 'compiled-out');
    await mkdir(sourceOutDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(sourceOutDir, 'extension.js'), 'host-v2'),
      writeFile(path.join(sourceOutDir, 'backend.js'), 'backend-v2'),
      writeFile(path.join(sourceOutDir, 'worker-entry.js'), 'worker-v2'),
    ]);
    const verify = async (directory: string): Promise<void> => {
      await Promise.all(hostFiles(directory).map((file) => stat(file)));
    };
    await activateInstalledOutput({ sourceOutDir, extensionDir, verify });
    assert.equal(await readFile(path.join(extensionDir, 'out', 'extension.js'), 'utf8'), 'host-v2');
    assert.equal(await readFile(path.join(extensionDir, 'out', 'backend.js'), 'utf8'), 'backend-v2');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function hostFiles(directory: string): string[] {
  return ['extension.js', 'backend.js', 'worker-entry.js'].map((name) => path.join(directory, name));
}
