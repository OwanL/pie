'use strict';

const nodeFs = require('node:fs');
const nodeFsPromises = require('node:fs/promises');
const path = require('node:path');
const runtimeGenerations = require('./runtime-generations.cjs');

const LAST_LOADED_MARKER_KEY = 'pie.runtime.lastLoaded';
const UPDATED_PROGRESS_TITLE = 'Loading updated Pie build…';
const PENDING_STATUS_TEXT = 'Pie update ready';
const PENDING_STATUS_TOOLTIP = 'Pie update ready. Restart VS Code to load it.';
const WATCH_DEBOUNCE_MS = 150;

function defaultVscode() {
  return require('vscode');
}

function defaultRequireModule(modulePath) {
  return require(modulePath);
}

async function readExtensionIdentity(extensionDir, readFile) {
  const packagePath = path.join(extensionDir, 'package.json');
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  if (!packageJson || typeof packageJson !== 'object') throw new Error(`Invalid extension manifest at ${packagePath}.`);
  return {
    publisher: packageJson.publisher,
    name: packageJson.name,
    version: packageJson.version,
  };
}

function lastLoadedGeneration(globalState) {
  if (!globalState || typeof globalState.get !== 'function') return null;
  let marker;
  try {
    marker = globalState.get(LAST_LOADED_MARKER_KEY);
  } catch {
    return null;
  }
  if (typeof marker === 'string' && marker.length > 0) return marker;
  if (marker && typeof marker === 'object' && typeof marker.generation === 'string') return marker.generation;
  return null;
}

function delegateModule(moduleValue) {
  if (moduleValue && typeof moduleValue.activate !== 'function' && moduleValue.default && typeof moduleValue.default === 'object') {
    return moduleValue.default;
  }
  return moduleValue;
}

function delegateDeactivate(moduleValue, activatedValue) {
  if (activatedValue && typeof activatedValue.deactivate === 'function') {
    return activatedValue.deactivate.bind(activatedValue);
  }
  if (moduleValue && typeof moduleValue.deactivate === 'function') {
    return moduleValue.deactivate.bind(moduleValue);
  }
  if (moduleValue?.default && typeof moduleValue.default.deactivate === 'function') {
    return moduleValue.default.deactivate.bind(moduleValue.default);
  }
  return null;
}

function disposePendingStatus(state) {
  const item = state.pendingItem;
  state.pendingItem = null;
  if (!item) return;
  try {
    item.hide?.();
  } finally {
    item.dispose?.();
  }
}

function showPendingStatus(state, vscode) {
  if (state.disposed) return;
  if (!state.pendingItem) {
    const createStatusBarItem = vscode.window && vscode.window.createStatusBarItem;
    if (typeof createStatusBarItem !== 'function') return;
    try {
      const alignment = vscode.StatusBarAlignment?.Right ?? 2;
      state.pendingItem = createStatusBarItem.call(vscode.window, alignment, 100);
    } catch {
      return;
    }
  }
  const item = state.pendingItem;
  item.text = PENDING_STATUS_TEXT;
  item.tooltip = PENDING_STATUS_TOOLTIP;
  // Deliberately do not assign a command: an update is loaded only by the next
  // normal VS Code restart and must never interrupt a live session.
  item.command = undefined;
  item.show?.();
}

function stopWatcher(state) {
  state.disposed = true;
  if (state.debounceTimer !== null) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  if (state.watcher) {
    try {
      state.watcher.close();
    } catch {
      // A watcher that already closed is no longer a resource leak.
    }
    state.watcher = null;
  }
}

function createBootstrap(overrides = {}) {
  const runtime = overrides.runtimeGenerations || runtimeGenerations;
  const readFile = overrides.readFile || ((filePath, encoding) => nodeFsPromises.readFile(filePath, encoding));
  const watch = overrides.watch || ((directory, listener) => nodeFs.watch(directory, listener));
  const requireModule = overrides.requireModule || defaultRequireModule;
  const getVscode = overrides.getVscode || (() => overrides.vscode || defaultVscode());
  const identityProvider = overrides.identityProvider;
  let active = null;
  let activationInFlight = null;

  async function identityFor(extensionDir) {
    if (identityProvider) return identityProvider(extensionDir);
    return readExtensionIdentity(extensionDir, readFile);
  }

  async function inspectForPendingUpdate(state, vscode) {
    if (state.disposed || active !== state) return;
    try {
      const selected = await runtime.resolveRuntimeGeneration({
        extensionDir: state.extensionDir,
        identity: state.identity,
      });
      if (state.disposed || active !== state) return;
      if (selected.generation !== null && selected.generation !== state.runtime.generation) {
        showPendingStatus(state, vscode);
      } else {
        disposePendingStatus(state);
      }
    } catch (error) {
      // A transient torn marker is not an activation failure. The next marker
      // event retries resolution while the already-running host remains put.
      console.warn(`[pie-runtime] update check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function schedulePendingCheck(state, vscode) {
    if (state.disposed) return;
    if (state.debounceTimer !== null) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      void inspectForPendingUpdate(state, vscode);
    }, WATCH_DEBOUNCE_MS);
  }

  function startWatcher(state, vscode) {
    const selectionsDir = path.join(state.extensionDir, 'pie-runtime', 'selections');
    try {
      const watcher = watch(selectionsDir, () => schedulePendingCheck(state, vscode));
      state.watcher = watcher;
      watcher.on?.('error', (error) => {
        console.warn(`[pie-runtime] selection watcher failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      // Watching is only a convenience notification. Runtime selection remains
      // immutable and startup will still load the newest complete generation.
      console.warn(`[pie-runtime] could not watch runtime selections: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function runDelegate(context, vscode, acquired, identity, previousGeneration) {
    const runtimeEntry = path.join(acquired.outDir, 'extension.js');
    let loadedModule;
    let activatedValue;
    try {
      // This is intentionally the first require of extension.js. The lease was
      // created by acquireRuntimeGeneration before this point.
      loadedModule = requireModule(runtimeEntry);
      const delegate = delegateModule(loadedModule);
      if (!delegate || typeof delegate.activate !== 'function') {
        throw new Error(`Pie runtime entry does not export activate: ${runtimeEntry}`);
      }
      activatedValue = await delegate.activate(context, {
        runtimeOutDir: acquired.outDir,
        generation: acquired.generation,
        publishedAt: acquired.publishedAt,
      });

      if (acquired.generation !== null && context.globalState && typeof context.globalState.update === 'function') {
        try {
          await context.globalState.update(LAST_LOADED_MARKER_KEY, {
            generation: acquired.generation,
            publishedAt: acquired.publishedAt,
          });
        } catch (error) {
          // The marker only improves update UX. A host that started
          // successfully must remain active and keep its runtime lease even if
          // VS Code cannot persist global state.
          console.warn(`[pie-runtime] could not record loaded generation: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      const state = {
        context,
        vscode,
        extensionDir: context.extensionPath,
        identity,
        runtime: acquired,
        delegateDeactivate: delegateDeactivate(loadedModule, activatedValue),
        pendingItem: null,
        watcher: null,
        debounceTimer: null,
        disposed: false,
        previousGeneration,
        activationResult: activatedValue,
      };
      active = state;
      startWatcher(state, vscode);
      // A publication can finish while delegate activation is running, before
      // the watcher is attached. Check once after attachment without changing
      // the already-loaded runtime.
      void inspectForPendingUpdate(state, vscode);
      return activatedValue;
    } catch (error) {
      // There is deliberately no fallback activation here. A candidate may
      // have executed arbitrary host startup code before it failed; trying a
      // second candidate would create a mixed or duplicated host.
      let cleanupError;
      let cleanupProven = false;
      const cleanup = delegateDeactivate(loadedModule, activatedValue);
      if (cleanup) {
        try {
          await cleanup();
          cleanupProven = true;
        } catch (errorDuringCleanup) {
          cleanupError = errorDuringCleanup;
        }
      }

      // If no module cleanup hook exists, or its hook failed, the lease is the
      // only evidence keeping a possibly-started runtime reachable. Retain it
      // rather than turning a partial activation into an untracked runtime.
      let releaseError;
      if (cleanupProven) {
        try {
          await acquired.release();
        } catch (errorDuringRelease) {
          releaseError = errorDuringRelease;
        }
      }
      if (cleanupError && releaseError) {
        throw new AggregateError([error, cleanupError, releaseError], 'Pie runtime activation cleanup failed.');
      }
      if (cleanupError) throw new AggregateError([error, cleanupError], 'Pie runtime activation cleanup failed.');
      if (releaseError) throw new AggregateError([error, releaseError], 'Pie runtime activation lease release failed.');
      throw error;
    }
  }

  async function activateOnce(context) {
    const vscode = getVscode();
    const extensionDir = context.extensionPath;
    const identity = await identityFor(extensionDir);
    const previousGeneration = lastLoadedGeneration(context.globalState);
    const acquired = await runtime.acquireRuntimeGeneration({ extensionDir, identity });
    const isUpdated = acquired.generation !== null && acquired.generation !== previousGeneration;

    let delegateRunStarted = false;
    const run = () => {
      delegateRunStarted = true;
      return runDelegate(context, vscode, acquired, identity, previousGeneration);
    };
    try {
      if (isUpdated && vscode.window && typeof vscode.window.withProgress === 'function') {
        return await vscode.window.withProgress.call(
          vscode.window,
          {
            location: vscode.ProgressLocation?.Window ?? 10,
            title: UPDATED_PROGRESS_TITLE,
            cancellable: false,
          },
          async (progress) => {
            progress?.report?.({ message: UPDATED_PROGRESS_TITLE });
            return run();
          },
        );
      }
      return await run();
    } catch (error) {
      // runDelegate owns release or lease retention after a failed
      // require/activation. This catch only covers progress plumbing that
      // failed before the delegate ran.
      if (!delegateRunStarted) {
        await acquired.release().catch(() => undefined);
      }
      throw error;
    }
  }

  async function activate(context) {
    if (active) return active.activationResult;
    if (!activationInFlight) {
      activationInFlight = activateOnce(context).finally(() => {
        activationInFlight = null;
      });
    }
    return activationInFlight;
  }

  async function deactivate() {
    if (activationInFlight) {
      try {
        await activationInFlight;
      } catch {
        // Failed activation already attempted to release its lease.
      }
    }
    const state = active;
    if (!state) return;
    active = null;
    stopWatcher(state);
    disposePendingStatus(state);

    let delegateError;
    try {
      await state.delegateDeactivate?.();
    } catch (error) {
      delegateError = error;
    }

    // A failed delegated shutdown may leave a worker or backend using the
    // generation. Retain its lease; releasing it would allow cleanup to erase
    // files still needed by that partially-shutdown runtime.
    if (delegateError) throw delegateError;

    // Keep this after the delegated deactivate. A worker can still be using
    // runtime files until that promise has actually settled.
    await state.runtime.release();
  }

  return { activate, deactivate };
}

const defaultBootstrap = createBootstrap();

module.exports = {
  activate: (...args) => defaultBootstrap.activate(...args),
  deactivate: (...args) => defaultBootstrap.deactivate(...args),
  createBootstrap,
  LAST_LOADED_MARKER_KEY,
  UPDATED_PROGRESS_TITLE,
  PENDING_STATUS_TEXT,
  PENDING_STATUS_TOOLTIP,
};
