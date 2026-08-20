import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('node build and package allowlist declare the stable worker entry artifact', async () => {
  const vite = await fs.readFile(path.join(extensionRoot, 'vite.config.ts'), 'utf8');
  const vscodeIgnore = await fs.readFile(path.join(extensionRoot, '.vscodeignore'), 'utf8');
  assert.match(vite, /['"]worker-entry['"]:\s*path\.join\(srcDir, ['"]backend['"], ['"]worker-entry\.ts['"]\)/);
  assert.match(vite, /['"]phase4-worker-command-extension['"]:\s*path\.join\(rootDir, ['"]test['"], ['"]fixtures['"], ['"]phase4-worker-command-extension\.ts['"]\)/);
  assert.match(vite, /entryFileNames:\s*['"]\[name\]\.js['"]/);
  // ws's optional native deps must stay runtime requires: Vite stubs
  // unresolvable optional peer deps with empty objects, which defeats ws's
  // try/catch fallback and crashes on masked frames >= 32 bytes.
  assert.match(vite, /id\s*===\s*['"]bufferutil['"]/);
  assert.match(vite, /id\s*===\s*['"]utf-8-validate['"]/);
  assert.match(vscodeIgnore, /!out\/\*\.js/);
});

test('packaged isolated backend drives public message.send extension commands through replacement and retirement', {
  skip: process.env.PIE_TEST_BUILT_WORKER !== '1',
  timeout: 120_000,
}, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-packaged-worker-'));
  const vsixPath = path.join(temp, 'pie-phase2.vsix');
  const unpacked = path.join(temp, 'unpacked');
  await fs.mkdir(unpacked);
  try {
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, 'npm_execpath is required to create the VSIX without a shell wrapper');
    await execFileAsync(process.execPath, [npmCli, 'run', 'package', '--', '--out', vsixPath], {
      cwd: extensionRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 90_000,
      windowsHide: true,
    });
    assert.equal((await fs.stat(vsixPath)).isFile(), true, 'the opt-in test creates a real VSIX');

    const tar = process.platform === 'win32'
      ? path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    await execFileAsync(tar, ['-xf', vsixPath, '-C', unpacked], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
      windowsHide: true,
    });
    const packagedExtension = path.join(unpacked, 'extension');
    const backendEntry = path.join(packagedExtension, 'out', 'backend.js');
    const workerEntry = path.join(packagedExtension, 'out', 'worker-entry.js');
    const commandExtension = path.join(packagedExtension, 'out', 'phase4-worker-command-extension.js');
    assert.equal((await fs.stat(backendEntry)).isFile(), true);
    assert.equal((await fs.stat(workerEntry)).isFile(), true);
    assert.equal((await fs.stat(commandExtension)).isFile(), true);

    const sdkPath = path.join(extensionRoot, 'node_modules', '@earendil-works', 'pi-coding-agent');
    const agentDir = path.join(temp, 'agent');
    const commandResultPath = path.join(temp, 'phase4-extension-command-result.json');
    const commandTracePath = path.join(temp, 'phase4-extension-command-trace.jsonl');
    await fs.mkdir(agentDir, { recursive: true });
    const settings = JSON.parse(await fs.readFile(path.resolve(extensionRoot, '..', 'settings.json'), 'utf8')) as Record<string, unknown>;
    settings.extensions = [commandExtension];
    await Promise.all([
      fs.writeFile(path.join(agentDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`),
      fs.copyFile(path.resolve(extensionRoot, '..', 'models.json'), path.join(agentDir, 'models.json')),
      fs.writeFile(path.join(agentDir, 'auth.json'), '{}\n'),
    ]);
    const child = spawn(process.execPath, [
      backendEntry,
      '--sdkPath', sdkPath,
      '--cwd', temp,
    ], {
      cwd: temp,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        PIE_PHASE2_PACKAGE_SMOKE: '1',
        PIE_PROVIDER_TRAFFIC_LOG: '0',
        PIE_PHASE4_EXTENSION_FIXTURE_RESULT: commandResultPath,
        PIE_PHASE4_EXTENSION_FIXTURE_TRACE: commandTracePath,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_AUTH_DIR: path.join(temp, 'auth'),
        PI_CODING_AGENT_SESSION_DIR: path.join(temp, 'sessions'),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    timer.unref?.();
    const result = await exit.finally(() => clearTimeout(timer));
    assert.equal(result.code, 0, `packaged coordinator failed (${result.signal ?? 'no signal'}):\n${stderr}`);
    assert.match(stdout, /backend\.ready/);
    assert.match(stderr, /phase4-package-smoke:promoted-command-retired/);

    const commandResult = JSON.parse(await fs.readFile(commandResultPath, 'utf8')) as {
      sourcePaths: string[];
      finalPath: string;
    };
    assert.equal(commandResult.sourcePaths.length, 3, 'new, switch, and fork each release one source');
    assert.notEqual(commandResult.finalPath, commandResult.sourcePaths.at(-1));
    const durableDestination = await fs.readFile(commandResult.finalPath, 'utf8');
    assert.match(durableDestination, /phase4-extension-durable/);

    const publicRecords = stdout.split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        event?: string;
        payload?: {
          session?: { path?: string };
          replacesSessionPath?: string;
          sessionPath?: string;
          busy?: boolean;
        };
      });
    const publicOpened = publicRecords
      .filter((record) => record.event === 'session.opened');
    const replacementOpened = publicOpened.filter((record) => record.payload?.replacesSessionPath);
    assert.deepEqual(
      replacementOpened.map((record) => [record.payload?.replacesSessionPath, record.payload?.session?.path]),
      [
        [commandResult.sourcePaths[0], commandResult.sourcePaths[1]],
        [commandResult.sourcePaths[1], commandResult.sourcePaths[2]],
        [commandResult.sourcePaths[2], commandResult.finalPath],
      ],
      'public session.opened is published once per coordinator-rekeyed replacement and in command order',
    );

    const busyByPath = new Map<string, boolean>();
    for (const record of publicRecords) {
      if (record.event !== 'busy.changed' || typeof record.payload?.sessionPath !== 'string'
          || typeof record.payload.busy !== 'boolean') continue;
      busyByPath.set(record.payload.sessionPath, record.payload.busy);
    }
    for (const sessionPath of [...commandResult.sourcePaths, commandResult.finalPath]) {
      const finalBusy = busyByPath.get(sessionPath);
      assert.notEqual(
        finalBusy,
        true,
        `public message.send lifecycle must not leave busy=true for ${sessionPath}`,
      );
    }
    const preflightFailurePaths = publicRecords
      .filter((record) => record.event === 'preflight.failed')
      .map((record) => record.payload?.sessionPath);
    assert.ok(
      preflightFailurePaths.includes(commandResult.sourcePaths[0]),
      'ordinary no-agent extension command must publish a terminal preflight failure',
    );
    for (const sourcePath of commandResult.sourcePaths.slice(1)) {
      assert.ok(
        preflightFailurePaths.includes(sourcePath),
        `replacement extension command must terminalize its source request: ${sourcePath}`,
      );
    }
    const lifecycle = (await fs.readFile(commandTracePath, 'utf8')).trim().split(/\r?\n/u)
      .map((line) => JSON.parse(line) as { kind: string; sessionPath?: string });
    const commandDestinationIndex = lifecycle.findIndex((entry) => (
      entry.kind === 'command_destination' && entry.sessionPath === commandResult.finalPath
    ));
    assert.ok(commandDestinationIndex >= 0);
    const commandWindow = lifecycle.slice(0, commandDestinationIndex + 1);
    assert.deepEqual(
      commandWindow.filter((entry) => entry.kind === 'session_start').map((entry) => entry.sessionPath),
      [...commandResult.sourcePaths, commandResult.finalPath],
      'each command replacement receives exactly one fresh extension binding',
    );
    assert.equal(commandWindow.filter((entry) => entry.kind === 'session_shutdown').length, 3,
      'each replaced source retains exactly one shutdown subscription');
    assert.equal(
      lifecycle.filter((entry) => entry.kind === 'session_shutdown').length,
      lifecycle.filter((entry) => entry.kind === 'session_start').length,
      'source-reuse, truncate, and final retirement preserve extension shutdown handlers',
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
