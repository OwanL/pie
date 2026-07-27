import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { createDisplayPng, pngDimensions } from './image.mjs';
import { resolveLaunchExecutable } from './launch-resolve.mjs';
import { abortableSleep, abortError, estimateSequenceDuration, runTimedSequence } from './sequence.mjs';
import { focusWindowNative } from './win32-focus.mjs';

const MAX_ELEMENTS = 250;
const MAX_OBSERVATION_BYTES = 32 * 1024;
const MAX_SEQUENCE_BYTES = 1024 * 1024;
const TARGET_STABILITY_MS = 750;
const TARGET_DISCOVERY_TIMEOUT_MS = 10000;
// Cua list_windows can take ~0.75s on Electron-heavy desktops. The focus
// proof revalidates the exact PID/HWND, so its deadline must allow multiple
// discovery polls rather than expiring during the first proof.
const FOCUS_TIMEOUT_MS = 6500;
const FOCUS_PRIMARY_ATTEMPT_MS = 1500;
const FOCUS_CUA_CALL_TIMEOUT_MS = 1000;
const FOCUS_NATIVE_ATTEMPT_MS = 4000;
const GEOMETRY_TOLERANCE_PX = 1;
const ACTION_KINDS = new Set(['move', 'mouse_down', 'mouse_up', 'click', 'double_click', 'right_click', 'drag', 'scroll', 'key_down', 'key_up', 'press', 'hotkey', 'text', 'wait', 'focus', 'release_all']);

function targetCoordinates(point) { return point && typeof point === 'object' && point.x !== undefined && point.y !== undefined && (point.scope ?? 'target') === 'target'; }
function actionUsesTargetCoordinates(action) {
  if (targetCoordinates(action.target)) return true;
  return action.kind === 'drag' && (targetCoordinates(action.from) || targetCoordinates(action.to) || action.path?.some(targetCoordinates));
}
function actionNeedsDesktopBinding(action) {
  return !new Set(['wait', 'focus', 'release_all', 'key_up', 'mouse_up']).has(action.kind);
}
function validateSequenceShape(sequence) {
  if (!sequence || sequence.version !== 1 || !Array.isArray(sequence.actions) || sequence.actions.length > 10000) throw runtimeError('MALFORMED_SEQUENCE', 'Sequence must be version 1 with at most 10000 actions.');
  let previous = -1;
  for (let index = 0; index < sequence.actions.length; index += 1) {
    const step = sequence.actions[index];
    if (!step || !Number.isInteger(step.atMs) || step.atMs < previous || step.atMs > 600000 || !step.action || !ACTION_KINDS.has(step.action.kind)) throw runtimeError('MALFORMED_SEQUENCE', `Invalid sequence action at index ${index}.`);
    const duration = step.action.durationMs;
    if ((step.action.kind === 'wait' && (!Number.isInteger(duration) || duration < 0 || duration > 600000)) || ((step.action.kind === 'move' || step.action.kind === 'drag') && duration !== undefined && (!Number.isInteger(duration) || duration < 0 || duration > 600000))) throw runtimeError('MALFORMED_SEQUENCE', `Invalid sequence duration at index ${index}.`);
    previous = step.atMs;
  }
  if (estimateSequenceDuration(sequence) > 600000) throw runtimeError('MALFORMED_SEQUENCE', 'Sequence total duration must not exceed 600000ms.');
}

function runtimeError(code, message, retryable = false) { const error = new Error(message); error.code = code; error.retryable = retryable; return error; }
function parseToolResult(result, operation) {
  if (result?.isError) throw runtimeError(result.errorCode || 'CUA_ERROR', result.text || `${operation} failed.`);
  for (const candidate of [result?.structuredJson, result?.rawJson]) {
    if (typeof candidate === 'string' && candidate.trim()) { try { return JSON.parse(candidate); } catch {} }
  }
  return {};
}
function utf8Prefix(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  const bytes = Buffer.from(text); let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}
function uniquePath(directory, stem, extension) { return path.join(directory, `${Date.now()}-${randomUUID()}-${stem}.${extension}`); }
async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2)); await rename(temporary, filePath);
}
function emptyHeld() { return { keys: [], buttons: [] }; }
function uniqueHeld(held) {
  return { keys: [...new Set(held?.keys ?? [])], buttons: [...new Set(held?.buttons ?? [])] };
}
function hasHeld(held) { return held.keys.length > 0 || held.buttons.length > 0; }
function mergeHeld(...values) {
  return uniqueHeld({ keys: values.flatMap((value) => value?.keys ?? []), buttons: values.flatMap((value) => value?.buttons ?? []) });
}
function releaseFailure(held, message = 'Failed to release all held input.', cause) {
  const error = runtimeError('RELEASE_FAILED', message, true); error.held = uniqueHeld(held);
  if (cause?.sequencePath) error.sequencePath = cause.sequencePath;
  if (cause?.tracePath) error.tracePath = cause.tracePath;
  return error;
}
function frameOf(element) {
  const frame = element?.frame ?? {};
  return { x: Number(frame.x ?? 0), y: Number(frame.y ?? 0), width: Number(frame.w ?? frame.width ?? 0), height: Number(frame.h ?? frame.height ?? 0) };
}
function windowRecords(payload) { return Array.isArray(payload?._legacy_windows) ? payload._legacy_windows : Array.isArray(payload?.windows) ? payload.windows : []; }
function sameHandle(a, b) { try { return BigInt(a) === BigInt(b); } catch { return String(a) === String(b); } }
function positiveInteger(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : undefined; }
function validWindowRecord(window, pid) { return positiveInteger(window?.pid) === positiveInteger(pid) && positiveInteger(window?.window_id) !== undefined; }
function cancellationError(error) { return error?.code === 'CANCELLED' || error?.code === 'ABORT_ERR' || error?.name === 'AbortError'; }
function normalizedRegion(region) {
  const value = { x: Number(region?.left), y: Number(region?.top), width: Number(region?.width), height: Number(region?.height) };
  return Object.values(value).every(Number.isFinite) && value.width > 0 && value.height > 0 ? value : undefined;
}
function sameRegion(a, b, tolerance = GEOMETRY_TOLERANCE_PX) {
  return Boolean(a && b && ['x', 'y', 'width', 'height'].every((key) => Math.abs(Number(a[key]) - Number(b[key])) <= tolerance));
}
function pixelFallbackError(error) {
  if (cancellationError(error)) return false;
  const code = String(error?.code ?? '').toUpperCase();
  if (new Set(['UIA_TIMEOUT', 'UIA_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE', 'ACCESSIBILITY_UNAVAILABLE']).has(code)) return true;
  const message = String(error?.message ?? '');
  return /(?:uia|accessibility|provider|get_window_state)/i.test(message) && /(?:timed?\s*out|timeout|unavailable|not available)/i.test(message);
}

const KEY_ALIASES = {
  ctrl: 'LeftControl', control: 'LeftControl', shift: 'LeftShift', alt: 'LeftAlt', meta: 'LeftSuper',
  super: 'LeftSuper', win: 'LeftWin', cmd: 'LeftCmd', command: 'LeftCmd', enter: 'Enter',
};

export class ComputerBackend {
  constructor(options = {}) {
    this.driver = options.driver; this.nut = options.nut; this.sessions = new Map(); this.initialized = Boolean(this.driver && this.nut);
    this.now = options.now ?? (() => performance.now()); this.sleep = options.sleep ?? abortableSleep;
    this.nativeFocus = options.nativeFocus ?? focusWindowNative;
    this.focusCuaCallTimeoutMs = options.focusCuaCallTimeoutMs ?? FOCUS_CUA_CALL_TIMEOUT_MS;
    this.resolveLaunch = options.resolveLaunch ?? resolveLaunchExecutable;
    this.refEpoch = randomUUID(); this.nextTargetGeneration = 1;
  }

  async init() {
    if (this.initialized) return;
    if (process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED !== 'false' || process.env.CUA_DRIVER_RS_UPDATE_CHECK !== 'false') {
      throw runtimeError('TELEMETRY_NOT_DISABLED', 'Cua telemetry and update checks must be disabled before import.');
    }
    const [{ CuaDriver }, nut] = await Promise.all([import('@trycua/cua-driver'), import('@computer-use/nut-js')]);
    this.driver = await CuaDriver.create(undefined); this.nut = nut;
    this.nut.keyboard.config.autoDelayMs = 12; this.nut.mouse.config.autoDelayMs = 12; this.nut.mouse.config.mouseSpeed = 900;
    this.initialized = true;
  }

  async cua(name, args, signal) {
    await this.init();
    const result = await this.driver.callTool(name, JSON.stringify(args), signal ? { signal } : undefined);
    return parseToolResult(result, name);
  }

  async boundedCua(name, args, signal, timeoutMs) {
    const controller = new AbortController(); let timedOut = false;
    const relayAbort = () => controller.abort();
    signal?.addEventListener('abort', relayAbort, { once: true });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true; controller.abort();
        reject(runtimeError('FOCUS_PHASE_TIMEOUT', `${name} exceeded its bounded focus phase.`, true));
      }, Math.max(1, timeoutMs));
    });
    try { return await Promise.race([this.cua(name, args, controller.signal), timeout]); }
    catch (error) {
      if (signal?.aborted) throw abortError();
      if (timedOut || error?.code === 'FOCUS_PHASE_TIMEOUT') throw runtimeError('FOCUS_PHASE_TIMEOUT', `${name} exceeded its bounded focus phase.`, true);
      throw error;
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', relayAbort);
    }
  }

  async listWindows(signal, pid) {
    const windows = windowRecords(await this.cua('list_windows', {}, signal));
    return pid ? windows.filter((window) => Number(window.pid) === Number(pid)) : windows;
  }

  async exactWindowRecord(target, signal) {
    if (target.kind !== 'window') return undefined;
    if (!positiveInteger(target.pid) || !positiveInteger(target.windowId)) throw runtimeError('STALE_TARGET', 'The stored target lacks an exact positive PID/HWND; open it again.', true);
    let windows;
    try { windows = await this.listWindows(signal, target.pid); }
    catch (error) {
      if (cancellationError(error)) throw error;
      throw runtimeError('STALE_TARGET', 'Could not prove that the exact target PID/HWND still exists; open it again.', true);
    }
    const record = windows.find((window) => Number(window.pid) === target.pid && sameHandle(window.window_id, target.windowId));
    if (record) return record;
    const rebound = await this.rebindVanishedWindow(target, windows, signal);
    if (rebound) return rebound;
    throw runtimeError('STALE_TARGET', 'The exact target PID/HWND no longer exists; open it again.', true);
  }

  async rebindVanishedWindow(target, windows, signal) {
    const expectedProcess = String(target.process ?? '').trim().toLowerCase();
    const replacements = windows.filter((window) => {
      const process = String(window.app_name ?? '').trim().toLowerCase();
      return !sameHandle(window.window_id, target.windowId)
        && validWindowRecord(window, target.pid)
        && (!expectedProcess || process === expectedProcess);
    });
    if (replacements.length !== 1) return undefined;
    const replacement = replacements[0];
    const windowId = positiveInteger(replacement.window_id);
    if (!windowId) return undefined;
    target.windowId = windowId;
    target.title = String(replacement.title ?? target.title ?? '');
    target.process = String(replacement.app_name ?? target.process ?? '');
    target.generation = this.nextTargetGeneration++;
    target.revision = 0;
    target.refs = new Map();
    delete target.screenshotWidth; delete target.screenshotHeight; delete target.fullImageWidth; delete target.fullImageHeight; delete target.logicalBounds;
    try { target.logicalBounds = await this.logicalWindowBounds(target.windowId); }
    catch (error) {
      if (signal?.aborted) throw abortError();
      if (cancellationError(error)) throw error;
    }
    return replacement;
  }

  async activeWindowIs(target) {
    let active;
    try { active = await this.nut.getActiveWindow(); } catch {}
    return Boolean(active && sameHandle(active.windowHandle, target.windowId));
  }

  async requireForeground(target, signal) {
    if (target.kind !== 'window') return undefined;
    const record = await this.exactWindowRecord(target, signal);
    if (!await this.activeWindowIs(target)) throw runtimeError('TARGET_NOT_FOREGROUND', 'The exact target HWND is not foreground; focus it and retry.', true);
    return record;
  }

  async deliver(target, signal, operation) {
    if (signal?.aborted) throw abortError();
    if (target.kind === 'window') {
      try { await this.requireForeground(target, signal); }
      catch (error) {
        if (error?.code !== 'TARGET_NOT_FOREGROUND') throw error;
        await this.focusTarget(target, signal);
      }
      const current = await this.exactNutWindowRegion(target.windowId);
      if (!sameRegion(current, target.logicalBounds)) throw runtimeError('STALE_GEOMETRY', 'Window geometry changed since the latest open or observation; observe again before input.', true);
      if (!await this.activeWindowIs(target)) await this.focusTarget(target, signal);
      if (!await this.activeWindowIs(target)) throw runtimeError('TARGET_NOT_FOREGROUND', 'The exact target HWND lost foreground immediately before input.', true);
    } else {
      if (!target.desktopForegroundWindowId) throw runtimeError('OBSERVATION_REQUIRED', 'Observe the desktop before physical input so its foreground window can be bound.', true);
      let active;
      try { active = await this.nut.getActiveWindow(); } catch {}
      if (!active || !sameHandle(active.windowHandle, target.desktopForegroundWindowId)) {
        throw runtimeError('DESKTOP_FOREGROUND_CHANGED', 'The desktop foreground changed since the latest observation; observe again before input.', true);
      }
    }
    if (signal?.aborted) throw abortError();
    return await operation();
  }

  async currentForegroundWindowId(signal) {
    if (signal?.aborted) throw abortError();
    let active;
    try { active = await this.nut.getActiveWindow(); } catch {}
    if (signal?.aborted) throw abortError();
    return positiveInteger(active?.windowHandle);
  }

  async describeDesktopForeground(observedWindowId, signal) {
    const windowId = observedWindowId ?? await this.currentForegroundWindowId(signal);
    if (!windowId) return undefined;
    let record;
    try { record = (await this.listWindows(signal)).find((window) => sameHandle(window.window_id, windowId)); }
    catch (error) { if (cancellationError(error)) throw error; }
    if (signal?.aborted) throw abortError();
    return {
      windowId,
      ...(positiveInteger(record?.pid) ? { pid: positiveInteger(record.pid) } : {}),
      ...(record?.title ? { title: String(record.title) } : {}),
      ...(record?.app_name ? { process: String(record.app_name) } : {}),
    };
  }

  async exactNutWindowRegion(windowId) {
    await this.init();
    let windows;
    try { windows = await this.nut.getWindows(); }
    catch { throw runtimeError('STALE_GEOMETRY', 'Could not rediscover the exact NutJS HWND region; observe again.', true); }
    const matches = Array.isArray(windows) ? windows.filter((window) => sameHandle(window.windowHandle, windowId)) : [];
    if (matches.length !== 1 || typeof matches[0].getRegion !== 'function') throw runtimeError('STALE_GEOMETRY', 'Could not rediscover one unique exact NutJS HWND region; observe again.', true);
    let region;
    try { region = normalizedRegion(await matches[0].getRegion()); }
    catch {}
    if (!region) throw runtimeError('STALE_GEOMETRY', 'Could not prove a valid exact NutJS HWND region; observe again.', true);
    return region;
  }

  async logicalWindowBounds(windowId) {
    return await this.exactNutWindowRegion(windowId);
  }

  async open(params, signal) {
    await this.init();
    const { sessionId, selector, artifactDir } = params;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      const remaining = await this.releaseSession(existing);
      if (hasHeld(remaining)) { const error = releaseFailure(remaining, 'Cannot reopen the session while held input remains.'); error.cleanupDone = true; throw error; }
      await this.cua('end_session', { session: sessionId }, signal);
      this.sessions.delete(sessionId);
    }
    await mkdir(artifactDir, { recursive: true });
    let target;
    if (selector.kind === 'desktop') {
      await this.cua('start_session', { session: sessionId, capture_scope: 'desktop' }, signal);
      target = { id: `desktop:${sessionId}`, kind: 'desktop', title: 'Desktop', logicalBounds: { x: 0, y: 0, width: await this.nut.screen.width(), height: await this.nut.screen.height() } };
    } else {
      let windows = await this.listWindows(signal);
      let launchedPid;
      if (selector.kind === 'path') {
        const resolvedPath = await this.resolveLaunch(selector.path);
        const launched = await this.cua('launch_app', { path: resolvedPath, additional_arguments: selector.args ?? [] }, signal);
        launchedPid = positiveInteger(launched.pid);
        if (!launchedPid) throw runtimeError('LAUNCH_UNCORRELATED', 'Launched application did not return a valid process id; refusing to target another window.', true);
        windows = [await this.waitForStableLaunchedWindow(signal, launchedPid)];
      } else if (selector.kind === 'process' && selector.launch && !windows.some((w) => String(w.app_name ?? '').toLowerCase().includes(selector.process.toLowerCase()))) {
        const launched = await this.cua('launch_app', { name: selector.process, additional_arguments: selector.args ?? [] }, signal);
        launchedPid = positiveInteger(launched.pid);
        if (!launchedPid) throw runtimeError('LAUNCH_UNCORRELATED', 'Launched application did not return a valid process id; refusing to target another window.', true);
        windows = [await this.waitForStableLaunchedWindow(signal, launchedPid)];
      }
      let selected;
      const uniquePartialMatch = (matches) => {
        if (matches.length > 1) throw runtimeError('AMBIGUOUS_TARGET', 'Multiple windows matched the open selector; use foreground or an exact window_id.', true);
        return matches[0];
      };
      if (selector.kind === 'foreground') {
        const active = await this.nut.getActiveWindow();
        selected = windows.find((window) => sameHandle(window.window_id, active.windowHandle));
      }
      else if (selector.kind === 'pid') selected = uniquePartialMatch(windows.filter((w) => Number(w.pid) === selector.pid));
      else if (selector.kind === 'title') selected = uniquePartialMatch(windows.filter((w) => String(w.title ?? '').toLowerCase().includes(selector.title.toLowerCase())));
      else if (selector.kind === 'window_id') selected = windows.find((w) => sameHandle(w.window_id, selector.windowId) && (!selector.pid || Number(w.pid) === selector.pid));
      else if (selector.kind === 'process') selected = launchedPid
        ? windows.find((w) => Number(w.pid) === launchedPid)
        : uniquePartialMatch(windows.filter((w) => String(w.app_name ?? '').toLowerCase().includes(selector.process.toLowerCase())));
      else if (selector.kind === 'path') selected = windows.find((w) => Number(w.pid) === launchedPid);
      if (!selected) throw runtimeError('TARGET_NOT_FOUND', 'No window matched the open selector.', true);
      const selectedPid = positiveInteger(selected.pid); const selectedWindowId = positiveInteger(selected.window_id);
      if (!selectedPid || !selectedWindowId) {
        throw runtimeError('TARGET_UNCORRELATED', 'Matched window lacks an exact positive PID/HWND; refusing to register an unsafe target.', true);
      }
      const logicalBounds = await this.logicalWindowBounds(selected.window_id);
      await this.cua('start_session', { session: sessionId, capture_scope: 'window' }, signal);
      target = {
        id: `window:${selectedPid}:${selectedWindowId}`, kind: 'window', pid: selectedPid, windowId: selectedWindowId,
        title: String(selected.title ?? ''), process: String(selected.app_name ?? ''), logicalBounds,
      };
    }
    const state = { id: sessionId, artifactDir, targets: new Map([[target.id, { ...target, generation: this.nextTargetGeneration++, revision: 0, refs: new Map() }]]), activeTargetId: target.id, heldKeys: new Set(), heldButtons: new Set(), potentialKeys: new Set(), potentialButtons: new Set() };
    this.sessions.set(sessionId, state);
    const base = { sessionId, targetId: target.id, target: this.publicTarget(target), capabilities: { screenshot: true, accessibilityTree: true, semanticReferences: true, deterministicSequence: true, heldInput: true }, held: emptyHeld() };
    if (params.screenshot === true || params.tree === true || params.state === true) {
      const observation = await this.observe({ sessionId, targetId: target.id, screenshot: params.screenshot ?? false, tree: params.tree ?? false, state: params.state ?? false }, signal);
      return { ...base, ...observation };
    }
    return base;
  }

  async waitForStableLaunchedWindow(signal, pid) {
    const started = this.now(); let signature; let stableSince = started; let lastRecords = []; let lastValid = [];
    while (this.now() - started <= TARGET_DISCOVERY_TIMEOUT_MS) {
      const records = await this.listWindows(signal, pid);
      const valid = records.filter((window) => validWindowRecord(window, pid));
      const nextSignature = valid.map((window) => `${Number(window.pid)}:${positiveInteger(window.window_id)}`).sort().join('|') || (records.length ? 'invalid' : 'none');
      if (nextSignature !== signature) { signature = nextSignature; stableSince = this.now(); }
      lastRecords = records; lastValid = valid;
      if (this.now() - stableSince >= TARGET_STABILITY_MS) {
        if (valid.length === 1) return valid[0];
        if (valid.length > 1) throw runtimeError('AMBIGUOUS_TARGET', 'Multiple launched windows persisted; refusing to select one arbitrarily.', true);
        if (records.length) throw runtimeError('TARGET_UNCORRELATED', 'Launched windows lack an exact positive PID/HWND; refusing to register an unsafe target.', true);
      }
      await this.sleep(100, signal);
    }
    if (lastValid.length > 1) throw runtimeError('AMBIGUOUS_TARGET', 'Multiple launched windows persisted; refusing to select one arbitrarily.', true);
    if (lastRecords.length) throw runtimeError('TARGET_UNCORRELATED', 'Launched windows did not yield one stable exact positive PID/HWND.', true);
    throw runtimeError('TARGET_NOT_FOUND', 'No canonical window appeared for the launched process.', true);
  }
  session(id) { const value = this.sessions.get(id); if (!value) throw runtimeError('STALE_SESSION', `Computer session ${id} is not open.`, true); return value; }
  target(session, id) { const value = session.targets.get(id ?? session.activeTargetId); if (!value) throw runtimeError('STALE_TARGET', 'The target is stale; call computer open again.', true); return value; }
  publicTarget(target) {
    const { logicalBounds, screenshotWidth, screenshotHeight, fullImageWidth, fullImageHeight, ...base } = target;
    const result = { id: base.id, kind: base.kind, ...(base.pid ? { pid: base.pid } : {}), ...(base.windowId ? { windowId: base.windowId } : {}), title: base.title, process: base.process };
    if (logicalBounds) result.geometry = { bounds: logicalBounds, ...(screenshotWidth && screenshotHeight ? { screenshot: { width: screenshotWidth, height: screenshotHeight } } : {}), coordinateSpace: 'screenshot-relative' };
    return result;
  }
  held(session) { return uniqueHeld({ keys: [...session.heldKeys, ...session.potentialKeys], buttons: [...session.heldButtons, ...session.potentialButtons] }); }
  async cursor() {
    const point = await this.nut.mouse.getPosition(); const width = await this.nut.screen.width(); const height = await this.nut.screen.height();
    return { x: Math.max(0, Math.min(Math.max(0, width - 1), Math.round(point.x))), y: Math.max(0, Math.min(Math.max(0, height - 1), Math.round(point.y))) };
  }
  validateRevision(target, revision, actions) {
    const desktopBindingRequired = target.kind === 'desktop' && actions.some(actionNeedsDesktopBinding);
    if (!desktopBindingRequired && !actions.some(actionUsesTargetCoordinates)) return;
    if (!Number.isInteger(revision) || revision < 1) {
      throw runtimeError('INVALID_ARGUMENTS', desktopBindingRequired
        ? 'revision is required for desktop input so the observed foreground can be verified.'
        : 'revision is required for target-relative screenshot coordinates.');
    }
    if (revision !== target.revision) throw runtimeError('STALE_GEOMETRY', 'Screenshot geometry or foreground binding is stale; observe again.');
  }

  async observe(params, signal) {
    const session = this.session(params.sessionId); const target = this.target(session, params.targetId);
    const includeScreenshot = params.screenshot !== false; const includeTree = params.tree !== false; const includeState = params.state !== false;
    const fullImagePath = includeScreenshot ? uniquePath(session.artifactDir, 'full', 'png') : undefined;
    let payload; let pendingDesktopForeground;
    if (target.kind === 'desktop') {
      const captureImagePath = fullImagePath ? `${fullImagePath}.${randomUUID()}.tmp` : undefined;
      const foregroundBefore = await this.currentForegroundWindowId(signal);
      if (!foregroundBefore) throw runtimeError('OBSERVE_UNAVAILABLE', 'Could not bind the desktop foreground before observation.', true);
      try {
        payload = await this.cua('get_desktop_state', { session: session.id, ...(captureImagePath ? { screenshot_out_file: captureImagePath } : {}) }, signal);
        const foregroundAfter = await this.currentForegroundWindowId(signal);
        if (!foregroundAfter || !sameHandle(foregroundAfter, foregroundBefore)) {
          throw runtimeError('DESKTOP_FOREGROUND_CHANGED', 'Desktop foreground changed during observation; observe again.', true);
        }
        pendingDesktopForeground = await this.describeDesktopForeground(foregroundAfter, signal);
        target.logicalBounds = { x: 0, y: 0, width: await this.nut.screen.width(), height: await this.nut.screen.height() };
        if (captureImagePath && fullImagePath) await rename(captureImagePath, fullImagePath);
      } catch (error) {
        if (captureImagePath) await unlink(captureImagePath).catch(() => {});
        if (fullImagePath) await unlink(fullImagePath).catch(() => {});
        if (signal?.aborted && !cancellationError(error)) throw abortError();
        throw error;
      }
    } else {
      try {
        payload = await this.cua('get_window_state', { session: session.id, pid: target.pid, window_id: target.windowId, max_elements: MAX_ELEMENTS, include_screenshot: false }, signal);
      } catch (error) {
        if (cancellationError(error) || !pixelFallbackError(error)) throw error;
        if (!fullImagePath) await this.exactWindowRecord(target, signal);
        return await this.observePixelFallback(session, target, fullImagePath, includeTree, includeState, error, signal);
      }
      if (fullImagePath) {
        try { await this.captureVisibleWindowRegion(session, target, fullImagePath, signal); }
        catch (error) {
          await unlink(fullImagePath).catch(() => {});
          if (error?.code === 'TARGET_NOT_FOREGROUND' || error?.code === 'STALE_TARGET' || error?.code === 'STALE_GEOMETRY' || error?.code === 'TARGET_NOT_VISIBLE' || cancellationError(error)) throw error;
          throw runtimeError('OBSERVE_UNAVAILABLE', `Foreground visible-region capture failed: ${error.message}`, true);
        }
      } else target.logicalBounds = await this.logicalWindowBounds(target.windowId);
    }
    let dimensions = { width: Number(payload.screenshot_width ?? 0), height: Number(payload.screenshot_height ?? 0) };
    try {
      if (fullImagePath && target.kind === 'window') dimensions = await pngDimensions(fullImagePath);
      else if (fullImagePath && (!dimensions.width || !dimensions.height)) dimensions = await pngDimensions(fullImagePath);
    } catch (error) {
      if (fullImagePath) await unlink(fullImagePath).catch(() => {});
      throw error;
    }
    if (fullImagePath) {
      target.screenshotWidth = dimensions.width || target.logicalBounds.width; target.screenshotHeight = dimensions.height || target.logicalBounds.height;
    } else {
      delete target.screenshotWidth; delete target.screenshotHeight; delete target.fullImageWidth; delete target.fullImageHeight;
    }
    target.revision += 1; target.refs = new Map();
    const normalized = [];
    const rawElements = Array.isArray(payload.elements) ? payload.elements.slice(0, MAX_ELEMENTS) : [];
    let byteCount = 2; let truncated = rawElements.length < Number(payload.element_count ?? rawElements.length);
    for (let index = 0; index < rawElements.length; index += 1) {
      const raw = rawElements[index]; const ref = `e:${this.refEpoch}:${target.generation}:${target.revision}:${index}`;
      const element = { ref, role: String(raw.role ?? 'element'), label: String(raw.label ?? ''), frame: frameOf(raw) };
      const bytes = Buffer.byteLength(JSON.stringify(element)) + 1;
      if (byteCount + bytes > MAX_OBSERVATION_BYTES) { truncated = true; break; }
      byteCount += bytes; normalized.push(element); target.refs.set(ref, { token: raw.element_token, index: raw.element_index, frame: element.frame });
    }
    const treeResult = includeTree ? utf8Prefix(String(payload.tree_markdown ?? ''), Math.max(0, MAX_OBSERVATION_BYTES - byteCount)) : { text: '', truncated: false };
    truncated ||= treeResult.truncated;
    let displayImagePath;
    if (fullImagePath) { displayImagePath = uniquePath(session.artifactDir, 'display', 'png'); const display = await createDisplayPng(fullImagePath, displayImagePath, 1600); target.screenshotWidth = display.width; target.screenshotHeight = display.height; target.fullImageWidth = display.sourceWidth; target.fullImageHeight = display.sourceHeight; }
    if (target.kind === 'desktop') {
      target.desktopForegroundWindowId = pendingDesktopForeground.windowId;
      target.desktopForeground = pendingDesktopForeground;
    }
    const observedState = includeState ? await this.windowObservationState(target, signal) : undefined;
    return {
      sessionId: session.id, targetId: target.id, target: this.publicTarget(target), revision: target.revision,
      accessibilityAvailable: true,
      ...(includeTree ? { elements: normalized, tree: treeResult.text } : {}), truncated,
      ...(fullImagePath ? { fullImagePath, displayImagePath, imageWidth: target.screenshotWidth, imageHeight: target.screenshotHeight, fullImageWidth: target.fullImageWidth, fullImageHeight: target.fullImageHeight } : {}),
      ...(includeState ? { state: observedState } : {}), held: this.held(session), cursor: await this.cursor(),
    };
  }

  async windowObservationState(target, signal) {
    if (target.kind === 'desktop') return { desktop: true, foreground: target.desktopForeground };
    const record = (await this.listWindows(signal, target.pid)).find((window) => sameHandle(window.window_id, target.windowId));
    const active = await this.nut.getActiveWindow().catch(() => undefined);
    return record ? { foreground: Boolean(active && sameHandle(record.window_id, active.windowHandle)), minimized: Boolean(record.minimized), onScreen: Boolean(record.is_on_screen) } : { available: false };
  }

  async captureVisibleWindowRegion(session, target, fullImagePath, signal) {
    const record = await this.requireForeground(target, signal);
    if (record.minimized !== false || record.is_on_screen !== true) throw runtimeError('TARGET_NOT_VISIBLE', 'The exact target must be non-minimized and on-screen before visible-region capture.', true);
    const before = await this.exactNutWindowRegion(target.windowId);
    const screenWidth = await this.nut.screen.width(); const screenHeight = await this.nut.screen.height();
    if (before.x < 0 || before.y < 0 || before.x + before.width > screenWidth || before.y + before.height > screenHeight) {
      throw runtimeError('TARGET_NOT_VISIBLE', 'Foreground visible-region capture supports only windows entirely on the NutJS main display.', true);
    }
    target.logicalBounds = before;
    if (signal?.aborted) throw abortError();
    const region = new this.nut.Region(Math.round(before.x), Math.round(before.y), Math.max(1, Math.round(before.width)), Math.max(1, Math.round(before.height)));
    let capturedPath;
    try {
      capturedPath = await this.nut.screen.captureRegion(path.basename(fullImagePath), region, this.nut.FileType.PNG, session.artifactDir);
      if (signal?.aborted) throw abortError();
      await this.requireForeground(target, signal);
      const after = await this.exactNutWindowRegion(target.windowId);
      if (!sameRegion(after, before)) throw runtimeError('STALE_GEOMETRY', 'Window geometry changed during visible-region capture; observe again.', true);
      if (capturedPath && path.resolve(capturedPath) !== path.resolve(fullImagePath)) await rename(capturedPath, fullImagePath);
    } catch (error) {
      await unlink(fullImagePath).catch(() => {});
      if (capturedPath) await unlink(capturedPath).catch(() => {});
      throw error;
    }
  }

  async observePixelFallback(session, target, fullImagePath, includeTree, includeState, cause, signal) {
    let captureError;
    if (fullImagePath) {
      try { await this.captureVisibleWindowRegion(session, target, fullImagePath, signal); }
      catch (error) {
        await unlink(fullImagePath).catch(() => {});
        if (error?.code === 'TARGET_NOT_FOREGROUND' || error?.code === 'STALE_TARGET' || error?.code === 'STALE_GEOMETRY' || error?.code === 'TARGET_NOT_VISIBLE' || cancellationError(error)) throw error;
        captureError = error;
      }
    } else target.logicalBounds = await this.logicalWindowBounds(target.windowId);
    if (captureError) throw runtimeError('OBSERVE_UNAVAILABLE', `Window accessibility state unavailable (${cause?.code ?? 'CUA_ERROR'}) and foreground visible-region screenshot fallback failed: ${captureError.message}`, true);
    let dimensions = { width: 0, height: 0 };
    if (fullImagePath) dimensions = await pngDimensions(fullImagePath);
    if (fullImagePath) {
      target.screenshotWidth = dimensions.width || Math.round(target.logicalBounds.width);
      target.screenshotHeight = dimensions.height || Math.round(target.logicalBounds.height);
    } else {
      delete target.screenshotWidth; delete target.screenshotHeight; delete target.fullImageWidth; delete target.fullImageHeight;
    }
    target.revision += 1; target.refs = new Map();
    const reason = utf8Prefix(fullImagePath
      ? `Accessibility unavailable (${cause?.code ?? cause?.message ?? 'window state failed'}); foreground visible-region image captured.`
      : `Accessibility unavailable (${cause?.code ?? cause?.message ?? 'window state failed'}); no image captured.`, 512).text;
    let displayImagePath;
    if (fullImagePath) { displayImagePath = uniquePath(session.artifactDir, 'display', 'png'); const display = await createDisplayPng(fullImagePath, displayImagePath, 1600); target.screenshotWidth = display.width; target.screenshotHeight = display.height; target.fullImageWidth = display.sourceWidth; target.fullImageHeight = display.sourceHeight; }
    const observedState = includeState ? await this.windowObservationState(target, signal).catch(() => ({ available: false })) : undefined;
    return {
      sessionId: session.id, targetId: target.id, target: this.publicTarget(target), revision: target.revision,
      accessibilityAvailable: false, degraded: { reason, fallback: fullImagePath ? 'pixel' : 'none' },
      ...(includeTree ? { elements: [], tree: '' } : {}), truncated: false,
      ...(fullImagePath ? { fullImagePath, displayImagePath, imageWidth: target.screenshotWidth, imageHeight: target.screenshotHeight, fullImageWidth: target.fullImageWidth, fullImageHeight: target.fullImageHeight } : {}),
      ...(includeState ? { state: observedState } : {}), held: this.held(session), cursor: await this.cursor(),
    };
  }

  resolvePoint(target, value) {
    if (value.ref !== undefined) {
      const match = /^e:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(\d+):(\d+):(\d+)$/i.exec(value.ref);
      if (!match || match[1] !== this.refEpoch || Number(match[2]) !== target.generation || Number(match[3]) !== target.revision || !target.refs.has(value.ref)) throw runtimeError('STALE_REFERENCE', `Semantic reference ${value.ref} is stale; observe again.`);
      const f = target.refs.get(value.ref).frame; return { x: f.x + f.width / 2, y: f.y + f.height / 2 };
    }
    if ((value.scope ?? 'target') === 'desktop') return { x: value.x, y: value.y };
    if (!target.logicalBounds || !target.screenshotWidth || !target.screenshotHeight) throw runtimeError('OBSERVATION_REQUIRED', 'Observe the target before using screenshot-relative coordinates.', true);
    if (value.x >= target.screenshotWidth || value.y >= target.screenshotHeight) throw runtimeError('COORDINATE_OUT_OF_BOUNDS', 'Screenshot-relative coordinate is outside the latest observation.');
    return { x: target.logicalBounds.x + value.x * target.logicalBounds.width / target.screenshotWidth, y: target.logicalBounds.y + value.y * target.logicalBounds.height / target.screenshotHeight };
  }

  keyName(value) {
    const alias = KEY_ALIASES[value.toLowerCase()]; if (alias) return alias;
    const name = Object.keys(this.nut.Key).find((candidate) => Number.isNaN(Number(candidate)) && candidate.toLowerCase() === value.toLowerCase());
    if (!name) throw runtimeError('INVALID_KEY', `Unsupported NutJS key ${value}.`); return name;
  }
  buttonName(value) { return value === 'middle' ? this.nut.Button.MIDDLE : value === 'right' ? this.nut.Button.RIGHT : this.nut.Button.LEFT; }
  async moveTo(target, point, durationMs, signal) {
    if (!durationMs) { await this.deliver(target, signal, () => this.nut.mouse.setPosition(point)); return; }
    const from = await this.nut.mouse.getPosition(); const steps = Math.max(1, Math.min(120, Math.ceil(durationMs / 16))); const started = performance.now();
    for (let i = 1; i <= steps; i += 1) {
      if (signal?.aborted) throw abortError();
      const due = started + durationMs * i / steps; const remaining = due - performance.now();
      if (remaining > 0) await abortableSleep(remaining, signal);
      const next = { x: from.x + (point.x - from.x) * i / steps, y: from.y + (point.y - from.y) * i / steps };
      await this.deliver(target, signal, () => this.nut.mouse.setPosition(next));
    }
  }

  async waitForExactForeground(target, deadline, signal) {
    while (this.now() <= deadline) {
      if (await this.activeWindowIs(target)) return true;
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(50, remaining), signal);
    }
    return false;
  }

  async focusTarget(target, signal) {
    if (target.kind !== 'window') return;
    const started = this.now();
    const deadline = started + FOCUS_TIMEOUT_MS;
    await this.exactWindowRecord(target, signal);
    try {
      await this.boundedCua('bring_to_front', { pid: target.pid, window_id: target.windowId }, signal, Math.min(this.focusCuaCallTimeoutMs, Math.max(1, deadline - this.now())));
      if (await this.waitForExactForeground(target, Math.min(deadline, started + FOCUS_PRIMARY_ATTEMPT_MS), signal)) return;
    } catch (error) {
      if (cancellationError(error)) throw error;
    }

    if (this.now() <= deadline) {
      await this.exactWindowRecord(target, signal);
      try {
        await this.nativeFocus({ pid: target.pid, windowId: target.windowId, signal, timeoutMs: Math.max(250, Math.min(3000, deadline - this.now())) });
      } catch (error) { if (cancellationError(error)) throw error; }
      if (await this.waitForExactForeground(target, Math.min(deadline, started + FOCUS_NATIVE_ATTEMPT_MS), signal)) return;
    }

    if (this.now() <= deadline) {
      await this.exactWindowRecord(target, signal);
      let matches = [];
      try {
        const windows = await this.nut.getWindows();
        matches = Array.isArray(windows) ? windows.filter((window) => sameHandle(window.windowHandle, target.windowId)) : [];
      } catch {}
      if (matches.length === 1 && typeof matches[0].focus === 'function') {
        try {
          if (typeof matches[0].restore === 'function') await matches[0].restore();
          await matches[0].focus();
        } catch (error) { if (cancellationError(error)) throw error; }
        if (await this.waitForExactForeground(target, deadline, signal)) return;
      }
    }
    throw runtimeError('TARGET_NOT_FOREGROUND', 'Could not make the exact target HWND foreground after Cua, bounded Win32, and NutJS focus attempts.', true);
  }

  async executeAction(session, target, action, signal) {
    if (signal?.aborted) throw abortError();
    switch (action.kind) {
      case 'move': await this.moveTo(target, this.resolvePoint(target, action.target), action.durationMs, signal); return;
      case 'mouse_down': {
        if (session.heldButtons.has(action.button)) return; session.potentialButtons.add(action.button);
        await this.deliver(target, signal, () => this.nut.mouse.pressButton(this.buttonName(action.button))); session.potentialButtons.delete(action.button); session.heldButtons.add(action.button); return;
      }
      case 'mouse_up': {
        if (!session.heldButtons.has(action.button) && !session.potentialButtons.has(action.button)) return;
        await this.nut.mouse.releaseButton(this.buttonName(action.button)); session.heldButtons.delete(action.button); session.potentialButtons.delete(action.button); return;
      }
      case 'click': case 'double_click': case 'right_click': {
        await this.deliver(target, signal, () => this.nut.mouse.setPosition(this.resolvePoint(target, action.target))); const button = action.kind === 'right_click' ? 'right' : (action.button ?? 'left');
        if (action.kind === 'double_click') await this.deliver(target, signal, () => this.nut.mouse.doubleClick(this.buttonName(button)));
        else await this.deliver(target, signal, () => this.nut.mouse.click(this.buttonName(button))); return;
      }
      case 'drag': {
        const points = (action.path ?? [action.from, action.to]).map((p) => this.resolvePoint(target, p)); const button = action.button ?? 'left';
        const alreadyHeld = this.held(session).buttons.includes(button);
        await this.deliver(target, signal, () => this.nut.mouse.setPosition(points[0]));
        if (!alreadyHeld) session.potentialButtons.add(button);
        let actionError;
        try {
          if (!alreadyHeld) {
            await this.deliver(target, signal, () => this.nut.mouse.pressButton(this.buttonName(button)));
            session.potentialButtons.delete(button); session.heldButtons.add(button);
          }
          const segment = (action.durationMs ?? 0) / Math.max(1, points.length - 1);
          for (const point of points.slice(1)) await this.moveTo(target, point, segment, signal);
        } catch (error) { actionError = error; }
        if (!alreadyHeld) {
          const remaining = await this.releaseTracked(session, { keys: [], buttons: [button] });
          if (hasHeld(remaining)) throw releaseFailure(remaining, 'Drag failed to release its mouse button.', actionError);
        }
        if (actionError) throw actionError;
        return;
      }
      case 'scroll':
        if (action.target) await this.deliver(target, signal, () => this.nut.mouse.setPosition(this.resolvePoint(target, action.target)));
        if (action.deltaY > 0) await this.deliver(target, signal, () => this.nut.mouse.scrollDown(Math.abs(action.deltaY))); else if (action.deltaY < 0) await this.deliver(target, signal, () => this.nut.mouse.scrollUp(Math.abs(action.deltaY)));
        if (action.deltaX > 0) await this.deliver(target, signal, () => this.nut.mouse.scrollRight(Math.abs(action.deltaX))); else if (action.deltaX < 0) await this.deliver(target, signal, () => this.nut.mouse.scrollLeft(Math.abs(action.deltaX))); return;
      case 'key_down': {
        const name = this.keyName(action.key); if (session.heldKeys.has(name)) return; session.potentialKeys.add(name);
        await this.deliver(target, signal, () => this.nut.keyboard.pressKey(this.nut.Key[name])); session.potentialKeys.delete(name); session.heldKeys.add(name); return;
      }
      case 'key_up': {
        const name = this.keyName(action.key); if (!session.heldKeys.has(name) && !session.potentialKeys.has(name)) return;
        await this.nut.keyboard.releaseKey(this.nut.Key[name]); session.heldKeys.delete(name); session.potentialKeys.delete(name); return;
      }
      case 'press': {
        const name = this.keyName(action.key); if (this.held(session).keys.includes(name)) return;
        session.potentialKeys.add(name); let actionError;
        try {
          await this.deliver(target, signal, () => this.nut.keyboard.pressKey(this.nut.Key[name]));
          session.potentialKeys.delete(name); session.heldKeys.add(name);
        } catch (error) { actionError = error; }
        const remaining = await this.releaseTracked(session, { keys: [name], buttons: [] });
        if (hasHeld(remaining)) throw releaseFailure(remaining, `Key press failed to release ${name}.`, actionError);
        if (actionError) throw actionError;
        return;
      }
      case 'hotkey': {
        const names = [...new Set(action.keys.map((key) => this.keyName(key)))];
        const initiallyHeld = new Set(this.held(session).keys); const namesToPress = names.filter((name) => !initiallyHeld.has(name));
        for (const name of namesToPress) session.potentialKeys.add(name);
        let actionError;
        try {
          for (const name of namesToPress) {
            await this.deliver(target, signal, () => this.nut.keyboard.pressKey(this.nut.Key[name]));
            session.potentialKeys.delete(name); session.heldKeys.add(name);
          }
        } catch (error) { actionError = error; }
        const remaining = await this.releaseTracked(session, { keys: namesToPress, buttons: [] });
        if (hasHeld(remaining)) throw releaseFailure(remaining, 'Hotkey failed to release all of its keys.', actionError);
        if (actionError) throw actionError;
        return;
      }
      case 'text': await this.deliver(target, signal, () => this.nut.keyboard.type(action.text)); return;
      case 'wait': await abortableSleep(action.durationMs, signal); return;
      case 'focus': await this.focusTarget(target, signal); return;
      case 'release_all': {
        const remaining = await this.releaseSession(session);
        if (hasHeld(remaining)) { const error = releaseFailure(remaining); error.cleanupDone = true; throw error; }
        return;
      }
      default: throw runtimeError('INVALID_ACTION', `Unsupported action ${action.kind}.`);
    }
  }

  async act(params, signal) {
    const session = this.session(params.sessionId); const target = this.target(session, params.targetId);
    this.validateRevision(target, params.revision, [params.input]);
    try { await this.executeAction(session, target, params.input, signal); return { sessionId: session.id, targetId: target.id, held: this.held(session) }; }
    catch (error) {
      if (error.cleanupDone) throw error;
      const remaining = await this.releaseSession(session);
      if (hasHeld(remaining)) { const failure = releaseFailure(remaining, `Action cleanup failed after: ${error.message ?? String(error)}`, error); failure.cleanupDone = true; throw failure; }
      error.held = remaining; error.cleanupDone = true; throw error;
    }
  }

  async runSequence(params, signal) {
    const session = this.session(params.sessionId); const target = this.target(session, params.targetId);
    let sequence = params.sequence;
    if (!sequence) {
      const raw = await readFile(params.sequencePath); if (raw.length > MAX_SEQUENCE_BYTES) throw runtimeError('OVERSIZED_SEQUENCE', 'Sequence artifact exceeds 1 MiB.');
      try { sequence = JSON.parse(raw.toString('utf8')); } catch { throw runtimeError('MALFORMED_SEQUENCE', 'Sequence artifact is not valid JSON.'); }
    }
    validateSequenceShape(sequence); this.validateRevision(target, params.revision, sequence.actions.map((step) => step.action));
    const sequencePath = uniquePath(session.artifactDir, 'sequence-v1', 'json'); const tracePath = uniquePath(session.artifactDir, 'trace', 'json');
    await atomicJson(sequencePath, sequence);
    const initiallyHeld = this.held(session); const initialKeys = new Set(initiallyHeld.keys); const initialButtons = new Set(initiallyHeld.buttons); let trace = []; let base;
    try {
      trace = await runTimedSequence(sequence, (action) => this.executeAction(session, target, action, signal), { signal });
      if (!params.preserveHeld) {
        const newlyHeld = {
          keys: this.held(session).keys.filter((key) => !initialKeys.has(key)),
          buttons: this.held(session).buttons.filter((button) => !initialButtons.has(button)),
        };
        const remaining = await this.releaseTracked(session, newlyHeld);
        if (hasHeld(remaining)) { const error = releaseFailure(remaining, 'Sequence cleanup failed to release newly held input.'); error.cleanupDone = true; throw error; }
      }
      await atomicJson(tracePath, { version: 1, startedAt: new Date().toISOString(), actions: trace });
      base = { sessionId: session.id, targetId: target.id, sequencePath, tracePath, held: this.held(session) };
    } catch (error) {
      trace = error.sequenceTrace ?? trace; await atomicJson(tracePath, { version: 1, failed: true, actions: trace }).catch(() => {});
      error.sequencePath = sequencePath; error.tracePath = tracePath;
      if (error.cleanupDone) throw error;
      const remaining = await this.releaseSession(session);
      if (hasHeld(remaining)) { const failure = releaseFailure(remaining, `Sequence cleanup failed after: ${error.message ?? String(error)}`, error); failure.cleanupDone = true; throw failure; }
      error.held = remaining; error.cleanupDone = true; throw error;
    }
    if (params.screenshot === true || params.tree === true || params.state === true) {
      try {
        const observation = await this.observe({ sessionId: session.id, targetId: target.id, screenshot: params.screenshot ?? false, tree: params.tree ?? false, state: params.state ?? false }, signal);
        return { ...base, ...observation };
      } catch (error) {
        // The sequence and its trace completed successfully; keep that evidence
        // truthful when only the optional trailing observation fails.
        error.sequencePath = sequencePath; error.tracePath = tracePath;
        throw error;
      }
    }
    return base;
  }

  async releaseValues(held) {
    const attempted = uniqueHeld(held); const remaining = emptyHeld();
    try { await this.init(); } catch { return attempted; }
    for (const key of [...attempted.keys].reverse()) {
      try { const name = this.keyName(key); await this.nut.keyboard.releaseKey(this.nut.Key[name]); }
      catch { remaining.keys.unshift(key); }
    }
    for (const button of [...attempted.buttons].reverse()) {
      try { await this.nut.mouse.releaseButton(this.buttonName(button)); }
      catch { remaining.buttons.unshift(button); }
    }
    return remaining;
  }
  async releaseTracked(session, held) {
    const attempted = uniqueHeld(held); const remaining = await this.releaseValues(attempted);
    const failedKeys = new Set(remaining.keys); const failedButtons = new Set(remaining.buttons);
    for (const key of attempted.keys) if (!failedKeys.has(key)) { session.heldKeys.delete(key); session.potentialKeys.delete(key); }
    for (const button of attempted.buttons) if (!failedButtons.has(button)) { session.heldButtons.delete(button); session.potentialButtons.delete(button); }
    return remaining;
  }
  async releaseSession(session, additional = emptyHeld()) {
    additional ??= emptyHeld();
    for (const key of additional.keys ?? []) session.potentialKeys.add(key);
    for (const button of additional.buttons ?? []) session.potentialButtons.add(button);
    await this.releaseTracked(session, this.held(session));
    return this.held(session);
  }
  async releaseForRequest(params) {
    const session = params?.sessionId ? this.sessions.get(params.sessionId) : undefined;
    return session ? await this.releaseSession(session) : emptyHeld();
  }
  async emergencyRelease(params) {
    const requestedBySession = new Map();
    for (const item of params.heldBySession ?? []) requestedBySession.set(item.sessionId, mergeHeld(requestedBySession.get(item.sessionId) ?? emptyHeld(), item.held));
    const remaining = await this.releaseValues(mergeHeld(...requestedBySession.values()));
    const failedKeys = new Set(remaining.keys); const failedButtons = new Set(remaining.buttons);
    const heldBySession = [...requestedBySession].map(([sessionId, held]) => ({ sessionId, held: {
      keys: held.keys.filter((key) => failedKeys.has(key)), buttons: held.buttons.filter((button) => failedButtons.has(button)),
    } }));
    return { held: remaining, heldBySession };
  }
  async releaseAll(params) {
    const session = this.sessions.get(params.sessionId);
    const held = session ? await this.releaseSession(session, params.held) : await this.releaseValues(params.held);
    return { sessionId: params.sessionId, held, heldBySession: [{ sessionId: params.sessionId, held }] };
  }

  async close(params, signal) {
    const session = this.sessions.get(params.sessionId); if (!session) return { sessionId: params.sessionId, held: emptyHeld() };
    const remaining = await this.releaseSession(session);
    if (hasHeld(remaining)) { const error = releaseFailure(remaining, 'Cannot close the session while held input remains.'); error.cleanupDone = true; throw error; }
    const target = this.target(session, params.targetId);
    let closedApplication = false;
    if (params.closeApplication && target.kind === 'window') { await this.exactWindowRecord(target, signal); await this.cua('kill_app', { pid: target.pid }, signal); closedApplication = true; }
    await this.cua('end_session', { session: session.id }, signal); this.sessions.delete(session.id);
    return { sessionId: session.id, targetId: target.id, held: emptyHeld(), closedApplication };
  }

  async handle(method, params, signal) {
    try {
      if (method === 'ping') return { state: { healthy: true } };
      if (method === 'emergency_release') return await this.emergencyRelease(params);
      if (method === 'release_all') return await this.releaseAll(params);
      if (method === 'open') return await this.open(params, signal);
      if (method === 'observe') return await this.observe(params, signal);
      if (method === 'act') return await this.act(params, signal);
      if (method === 'run_sequence') return await this.runSequence(params, signal);
      if (method === 'close') return await this.close(params, signal);
      throw runtimeError('UNKNOWN_METHOD', `Unknown computer sidecar method ${method}.`);
    } catch (error) {
      const session = params?.sessionId ? this.sessions.get(params.sessionId) : undefined;
      if (session && !error.cleanupDone) {
        const remaining = await this.releaseSession(session);
        if (hasHeld(remaining)) { const failure = releaseFailure(remaining, `Request cleanup failed after: ${error.message ?? String(error)}`, error); failure.cleanupDone = true; throw failure; }
        error.held = remaining; error.cleanupDone = true;
      } else if (session && !error.held) error.held = this.held(session);
      throw error;
    }
  }

  async shutdown() {
    const heldBySession = [];
    for (const session of this.sessions.values()) {
      const held = await this.releaseSession(session);
      if (hasHeld(held)) heldBySession.push({ sessionId: session.id, held });
    }
    if (heldBySession.length) {
      const held = mergeHeld(...heldBySession.map((item) => item.held)); const error = releaseFailure(held, 'Cannot shut down while held input remains.');
      error.heldBySession = heldBySession; error.cleanupDone = true; throw error;
    }
    this.sessions.clear();
    if (this.driver) { await this.driver.shutdown(); try { this.driver.uniffiDestroy?.(); } catch {} }
  }
}
