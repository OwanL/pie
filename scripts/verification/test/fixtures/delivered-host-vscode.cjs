'use strict';

// Test-only recorder for the actual compiled host's backend launch boundary.
// The main-script modes exercise relocated compiled standalone and VS Code
// entries; the existing development fake-vscode preloader supplies network
// denial for both. Backend SDK roots are recorded from owned child launches.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const originalSpawn = childProcess.spawn;

function send(message) {
  if (typeof process.send === 'function' && process.connected) process.send(message);
}

// Deactivation lifecycle proof is one awaited sequence: a metadata inspection
// failure after a fulfilled bootstrap deactivate must surface as the
// deactivation-error IPC through the caller's rejection handler instead of an
// unhandled rejection that strands the qualification until it times out.
function handleDeactivationMessage(message, { runtime, releaseRoot, runtimeDirectory, send, disconnect }) {
  if (message?.type !== 'deactivate' || !runtime) return undefined;
  const metadataRoot = path.join(releaseRoot, runtimeDirectory);
  send({ type: 'deactivating' });
  return (async () => {
    await runtime.deactivate();
    // fs.FSWatcher emits close asynchronously after bootstrap deactivate.
    await new Promise(resolve => setImmediate(resolve));
    send({ type: 'deactivated', selectionWatcherCount: runtime.selectionWatchers.size,
      leases: fs.readdirSync(path.join(metadataRoot, 'leases')),
      selections: fs.readdirSync(path.join(metadataRoot, 'selections')) });
  })().then(() => disconnect?.(), error => {
    send({ type: 'deactivation-error', error: String(error?.stack ?? error) });
    if (typeof process.send === 'function') process.exitCode = 1;
    disconnect?.();
  });
}

module.exports = { handleDeactivationMessage };

if (require.main === module) {
  // The spawn recorder is process-local; requiring this fixture as a module for
  // focused tests must not patch the importer's spawn.
  childProcess.spawn = function (command, args, ...rest) {
    if (Array.isArray(args)) {
      const index = args.findIndex(argument => argument === '--sdkPath');
      if (index >= 0 && typeof args[index + 1] === 'string') {
        const record = {
          type: 'backend-start',
          command: String(command),
          sdkPath: path.resolve(args[index + 1]),
        };
        const recordPath = process.env.PIE_DELIVERED_HOST_START_RECORD_FILE;
        if (recordPath) {
          try { fs.appendFileSync(recordPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 }); } catch {}
        }
        send(record);
      }
    }
    return originalSpawn.call(this, command, args, ...rest);
  };

  const releaseRoot = process.env.PIE_DELIVERED_HOST_ROOT;
  const profileRoot = process.env.PIE_DELIVERED_HOST_PROFILE_DIR;
  let runtime;
  // Authoritative delivered runtime metadata directory name, published by the
  // packaged runtime-generations module and resolved during bootstrap require.
  let runtimeDirectory;

  if (process.env.PIE_DELIVERED_HOST_ADAPTER === 'standalone') {
    let application;
    let shutdownStarted = false;
    process.on('message', message => {
      if (message?.type !== 'shutdown' || shutdownStarted || !application) return;
      shutdownStarted = true;
      void application.shutdown().then(() => {
        if (typeof process.send !== 'function' || !process.connected) return process.disconnect?.();
        process.send({ type: 'resolved shutdown' }, error => {
          if (error) process.exitCode = 1;
          process.disconnect?.();
        });
      }, error => {
        process.exitCode = 1;
        if (typeof process.send !== 'function' || !process.connected) return process.disconnect?.();
        process.send({ type: 'shutdown-error', error: String(error?.stack ?? error) }, () => process.disconnect?.());
      });
    });

    (async () => {
      if (!path.isAbsolute(releaseRoot || '') || !path.isAbsolute(profileRoot || '')) {
        throw new Error('Delivered fixture requires absolute package and profile roots.');
      }
      const output = path.join(releaseRoot, 'out');
      const entry = require(path.join(output, 'standalone.js'));
      const coordinatorPort = Number(process.env.PIE_HOST_COORDINATOR_PORT);
      if (!Number.isInteger(coordinatorPort) || coordinatorPort <= 0) throw new Error('Delivered standalone fixture requires its private coordinator port.');
      application = await entry.main(
        ['--cwd', process.env.PIE_VSCODE_DEVELOPMENT_WORKSPACE, '--no-lan'],
        {
          extensionPath: releaseRoot,
          runtimeOutputDirectory: output,
          dataRoot: path.join(profileRoot, 'data'),
          coordinatorPort,
          browserServerSettings: { port: 0, requirePreferredPort: false, allowLan: false },
          installSignalHandlers: false,
        },
      );
      if (!application) throw new Error('Compiled standalone main returned without starting the host.');
      send({ type: 'started', url: application.url });
    })().catch(error => {
      send({ type: 'fixture-error', error: String(error?.stack ?? error) });
      process.exitCode = 1;
      process.disconnect?.();
    });
  } else {
    let deactivationStarted = false;
    process.on('message', message => {
      if (message?.type !== 'deactivate' || deactivationStarted || !runtime) return;
      deactivationStarted = true;
      void handleDeactivationMessage(message, {
        runtime, releaseRoot, runtimeDirectory, send, disconnect: () => process.disconnect?.(),
      });
    });

    (async () => {
      if (!path.isAbsolute(releaseRoot || '') || !path.isAbsolute(profileRoot || '')) {
        throw new Error('Delivered fixture requires absolute package and profile roots.');
      }
      const fixture = globalThis.__PIE_VSCODE_DEVELOPMENT_FIXTURE__;
      if (!fixture?.vscode) throw new Error('The existing fake-vscode preloader was not loaded.');
      const output = path.join(releaseRoot, 'out');
      const extensionPath = releaseRoot;
      const manifest = JSON.parse(fs.readFileSync(path.join(releaseRoot, 'package.json'), 'utf8'));
      const bootstrapEntry = path.resolve(releaseRoot, manifest.main);
      if (bootstrapEntry !== path.join(releaseRoot, 'runtime', 'bootstrap.cjs')) throw new Error('Unexpected packaged main entry.');
      // Observe the real delegate boundary without substituting its activation.
      const Module = require('node:module');
      const originalLoad = Module._load;
      let selectedRuntime;
      Module._load = function (request, ...args) {
        const loaded = originalLoad.call(this, request, ...args);
        if (request === path.join(output, 'extension.js')) {
          const activate = loaded.activate;
          return { ...loaded, activate(context, selection) {
            selectedRuntime = selection;
            return activate(context, selection);
          } };
        }
        return loaded;
      };
      const { RUNTIME_DIRECTORY } = require(path.join(path.dirname(bootstrapEntry), 'runtime-generations.cjs'));
      runtimeDirectory = RUNTIME_DIRECTORY;
      const originalWatch = fs.watch;
      const selectionWatchers = new Set();
      fs.watch = function (directory, ...args) {
        const watcher = originalWatch.call(this, directory, ...args);
        if (path.resolve(String(directory)) === path.join(releaseRoot, RUNTIME_DIRECTORY, 'selections')) {
          selectionWatchers.add(watcher);
          watcher.once('close', () => selectionWatchers.delete(watcher));
        }
        return watcher;
      };
      runtime = require(bootstrapEntry);
      runtime.selectionWatchers = selectionWatchers;
      const vscode = fixture.vscode;
      const context = {
        extensionMode: 1,
        extensionPath,
        extensionUri: vscode.Uri.file(extensionPath),
        globalStorageUri: vscode.Uri.file(path.join(profileRoot, 'vscode', 'global-storage')),
        storageUri: vscode.Uri.file(path.join(profileRoot, 'vscode', 'storage')),
        globalState: fixture.makeMemento(),
        workspaceState: fixture.makeMemento(),
        extension: { packageJSON: manifest },
        subscriptions: [],
      };
      fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
      fs.mkdirSync(context.storageUri.fsPath, { recursive: true });
      const activation = runtime.activate(context);
      const activationPromise = !!activation && typeof activation.then === 'function';
      try {
        await activation;
      } finally {
        Module._load = originalLoad;
        fs.watch = originalWatch;
      }
      send({
        type: 'activated',
        bootstrapEntry,
        activationPromise,
        selectedRuntime,
        lastLoadedMarker: context.globalState.get('pie.runtime.lastLoaded') ?? null,
        selectionWatcherCount: selectionWatchers.size,
        output,
        extensionPath,
        globalStorage: context.globalStorageUri.fsPath,
        storage: context.storageUri.fsPath,
        progressCalls: fixture.progressCalls(),
      });
    })().catch(error => {
      send({ type: 'fixture-error', error: String(error?.stack ?? error) });
      process.exitCode = 1;
      process.disconnect?.();
    });
  }
}
