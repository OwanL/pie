// Playwright sidecar backend. This is the only module (with its imports) that
// loads Playwright or starts Chromium; the parent process never does. Keep
// wire constants in sync with src/types.ts.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';

import { chromium } from 'playwright';

import { createDisplayPng } from './image.mjs';
import { captureBoundedSnapshot, extractRefs } from './snapshots.mjs';

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 45_000;
const DEFAULT_RUN_CODE_TIMEOUT_MS = 60_000;
const DEFAULT_EVENT_LIMIT = 25;
const QUEUE_CAP = 200;
const MAX_EVENT_CATEGORY_OUTPUT_BYTES = 96 * 1024;
const MAX_TAB_SUMMARIES = 100;
const MAX_DIALOG_RECORDS = 20;
const MAX_CLOSED_SESSION_IDS = 100;
const MAX_OBSERVATION_DEPTH = 50;

const MAX_IMAGE_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_DOWNLOAD_ARTIFACT_BYTES = 128 * 1024 * 1024;
const MAX_STORAGE_STATE_BYTES = 8 * 1024 * 1024;
const MAX_RUN_CODE_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_SESSION_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_RUN_CODE_INLINE_BYTES = 8 * 1024;
const MAX_RUN_CODE_HELPER_ARTIFACTS = 100;

const STATE_CHANGING_KINDS = new Set([
  'navigate', 'back', 'forward', 'reload',
  'click', 'double_click', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'hover', 'focus', 'upload',
  'wait', 'tab_open', 'tab_select', 'tab_close',
]);
const NAVIGATION_KINDS = new Set(['navigate', 'back', 'forward', 'reload']);

function coded(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}
function bound(value, maxChars) {
  const text = String(value ?? '');
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
function firstLine(value) {
  return bound(String(value ?? '').split('\n').find((line) => line.trim().length > 0) ?? '', 500);
}
function sanitizeName(value) {
  const cleaned = String(value).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return cleaned || 'artifact';
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export class PlaywrightBackend {
  constructor(options = {}) {
    this.sessions = new Map();
    this.closingSessions = new Set();
    this.closeGraceMs = options.closeGraceMs ?? 5000;
    this.limits = {
      imageBytes: options.maxImageArtifactBytes ?? MAX_IMAGE_ARTIFACT_BYTES,
      downloadBytes: options.maxDownloadArtifactBytes ?? MAX_DOWNLOAD_ARTIFACT_BYTES,
      storageStateBytes: options.maxStorageStateBytes ?? MAX_STORAGE_STATE_BYTES,
      runCodeBytes: options.maxRunCodeResultBytes ?? MAX_RUN_CODE_RESULT_BYTES,
      sessionTotalBytes: options.maxSessionArtifactBytes ?? MAX_SESSION_ARTIFACT_BYTES,
    };
  }

  async handle(method, params, signal) {
    switch (method) {
      case 'open': return await this.open(params, signal);
      case 'observe': return await this.observeCommand(params, signal);
      case 'act': return await this.act(params, signal);
      case 'run_code': return await this.runCode(params, signal);
      case 'close': return await this.close(params);
      case 'ping': return {};
      // Internal test diagnostic (never part of the public tool surface): lets
      // lifecycle tests prove that no Chromium descendant survives.
      case 'debug_pids': return {
        sidecarPid: process.pid,
        browserPids: [...this.sessions.values()].flatMap((session) => {
          const handle = session.browserServer?.process();
          return handle?.pid ? [handle.pid] : [];
        }),
      };
      default: throw coded('MALFORMED_REQUEST', `Unsupported method: ${String(method)}.`);
    }
  }

  async shutdown() {
    for (const session of [...this.sessions.values()]) await this.closeSession(session).catch(() => {});
  }

  // ---------------------------------------------------------------- session

  makeSession(id, params) {
    return {
      id,
      artifactDir: params.artifactDir,
      browser: undefined,
      browserServer: undefined,
      crashed: false,
      primaryContext: undefined,
      contexts: new Set(),
      pageIds: new WeakMap(),
      pages: new Map(),
      pageState: new Map(),
      activePageId: undefined,
      nextPageNumber: 1,
      seq: 0,
      delivered: { console: 0, pageErrors: 0, failedRequests: 0, downloads: 0 },
      queues: { console: [], pageErrors: [], failedRequests: [], downloads: [] },
      dropped: { console: 0, pageErrors: 0, failedRequests: 0, downloads: 0 },
      artifactBytes: 0,
      artifactReservedBytes: 0,
      snapshotCounter: 0,
      counters: { screenshot: 0, download: 0, runCode: 0 },
      actionTimeoutMs: params.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS,
      navigationTimeoutMs: params.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    };
  }

  mustSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw coded(
        'SESSION_NOT_FOUND',
        `playwright session "${bound(sessionId, 128)}" is not live in this runtime. After a runtime restart every prior session/page/ref id is invalid; call playwright open to start over.`,
      );
    }
    if (session.crashed) {
      throw coded('BROWSER_CRASHED', `The browser for playwright session "${session.id}" crashed or disconnected; close this session and open a new one.`);
    }
    return session;
  }

  resolvePage(session, pageId) {
    if (pageId !== undefined) {
      const page = session.pages.get(pageId);
      if (!page || page.isClosed()) throw coded('PAGE_NOT_FOUND', `Page "${bound(pageId, 128)}" does not exist or is closed in playwright session "${session.id}". Known pages: ${[...session.pages.keys()].join(', ') || '(none)'}.`, true);
      return page;
    }
    const active = session.activePageId === undefined ? undefined : session.pages.get(session.activePageId);
    if (!active || active.isClosed()) {
      throw coded('PAGE_NOT_FOUND', `playwright session "${session.id}" has no open page. Use act tab_open to create one.`, true);
    }
    return active;
  }

  registerContext(session, context) {
    if (session.contexts.has(context)) return;
    session.contexts.add(context);
    context.on('page', (page) => this.registerPage(session, page));
  }

  registerPage(session, page) {
    if (session.pageIds.has(page)) return session.pageIds.get(page);
    const id = `p${session.nextPageNumber}`;
    session.nextPageNumber += 1;
    session.pageIds.set(page, id);
    session.pages.set(id, page);
    session.pageState.set(id, { revision: 0, refValid: false, refs: new Set() });
    page.on('close', () => {
      session.pages.delete(id);
      session.pageState.delete(id);
      if (session.activePageId === id) session.activePageId = session.pages.keys().next().value;
    });
    page.on('console', (message) => {
      const type = message.type();
      if (type === 'error' || type === 'warning') this.pushEvent(session, 'console', { type, text: bound(message.text(), 500) });
    });
    page.on('pageerror', (error) => this.pushEvent(session, 'pageErrors', { message: bound(error?.message ?? String(error), 1000) }));
    page.on('requestfailed', (request) => this.pushEvent(session, 'failedRequests', {
      method: request.method(), url: bound(request.url(), 2048), failure: bound(request.failure()?.errorText ?? 'unknown', 500),
    }));
    page.on('download', (download) => { void this.saveDownload(session, download).catch(() => {}); });
    return id;
  }

  pushEvent(session, queue, entry) {
    entry.seq = (session.seq += 1);
    const list = session.queues[queue];
    list.push(entry);
    while (list.length > QUEUE_CAP) { list.shift(); session.dropped[queue] += 1; }
  }

  invalidateRefs(session, pageId) {
    const state = session.pageState.get(pageId);
    if (state) { state.refValid = false; state.refs = new Set(); }
  }

  invalidateAllRefs(session) {
    for (const id of session.pageState.keys()) this.invalidateRefs(session, id);
  }

  /**
   * Brings the registry in line with every context/page reachable from this
   * session's dedicated browser after trusted run_code execution.
   */
  reconcile(session) {
    const browser = session.browser;
    if (!browser) return;
    for (const context of browser.contexts()) this.registerContext(session, context);
    for (const context of browser.contexts()) for (const page of context.pages()) this.registerPage(session, page);
    for (const [id, page] of [...session.pages]) {
      if (page.isClosed()) { session.pages.delete(id); session.pageState.delete(id); }
    }
    if (session.activePageId === undefined || !session.pages.has(session.activePageId)) {
      session.activePageId = session.pages.keys().next().value;
    }
  }

  forceKillBrowserSession(session) {
    try {
      const processHandle = session.browserServer?.process();
      if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
        if (process.platform === 'win32' && processHandle.pid) {
          spawnSync('taskkill', ['/PID', String(processHandle.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        }
        if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGKILL');
      }
    } catch { /* browser already fully closed */ }
  }

  forceKillAll() {
    for (const session of new Set([...this.sessions.values(), ...this.closingSessions])) this.forceKillBrowserSession(session);
  }

  async closeSession(session) {
    this.sessions.delete(session.id);
    this.closingSessions.add(session);
    const browser = session.browser;
    const browserServer = session.browserServer;
    try {
      if (browser && !session.crashed) await Promise.race([browser.close().catch(() => {}), delay(this.closeGraceMs)]);
      if (browserServer) await Promise.race([browserServer.close().catch(() => {}), delay(this.closeGraceMs)]);
      this.forceKillBrowserSession(session);
    } finally {
      session.browser = undefined;
      session.browserServer = undefined;
      this.closingSessions.delete(session);
    }
  }

  // ------------------------------------------------------------- artifacts

  beginArtifactReservation(session, label) {
    let bytes = 0;
    let active = true;
    const release = () => {
      if (!active) return;
      session.artifactReservedBytes -= bytes;
      active = false;
    };
    return {
      add: (additionalBytes) => {
        if (!active) throw new Error(`Artifact reservation for ${label} is already settled.`);
        if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) throw new Error(`Invalid artifact reservation size for ${label}.`);
        if (session.artifactBytes + session.artifactReservedBytes + additionalBytes > this.limits.sessionTotalBytes) {
          throw coded(
            'ARTIFACT_TOO_LARGE',
            `${label} would exceed the ${this.limits.sessionTotalBytes}-byte per-session artifact quota (used ${session.artifactBytes} bytes, reserved ${session.artifactReservedBytes} bytes). Playwright close the session and open a new one to reset the quota.`,
          );
        }
        bytes += additionalBytes;
        session.artifactReservedBytes += additionalBytes;
      },
      commit: () => {
        if (!active) return;
        session.artifactReservedBytes -= bytes;
        session.artifactBytes += bytes;
        active = false;
      },
      release,
    };
  }

  async saveDownload(session, download) {
    const base = { suggestedFilename: sanitizeName(download.suggestedFilename()), url: bound(download.url(), 2048) };
    this.pushEvent(session, 'downloads', { ...base, state: 'saving' });
    const directory = path.join(session.artifactDir, 'downloads');
    await mkdir(directory, { recursive: true });
    session.counters.download += 1;
    const name = `${String(session.counters.download).padStart(4, '0')}-${randomUUID()}-${base.suggestedFilename}`;
    const temporaryPath = path.join(directory, `${name}.partial`);
    const finalPath = path.join(directory, name);
    const reservation = this.beginArtifactReservation(session, `Download ${base.suggestedFilename}`);
    let bytes = 0;
    try {
      const stream = await download.createReadStream();
      if (!stream) throw new Error('download stream unavailable');
      const out = createWriteStream(temporaryPath);
      const finished = once(out, 'finish');
      let writeError;
      try {
        for await (const chunk of stream) {
          const nextBytes = bytes + chunk.length;
          if (nextBytes > this.limits.downloadBytes) {
            throw coded('ARTIFACT_TOO_LARGE', `Download exceeded the ${this.limits.downloadBytes}-byte artifact cap.`);
          }
          reservation.add(chunk.length);
          bytes = nextBytes;
          if (!out.write(chunk)) await once(out, 'drain');
        }
      } finally {
        out.end();
        try { await finished; } catch (error) { writeError = error; }
      }
      if (writeError) throw writeError;
      await rename(temporaryPath, finalPath);
      reservation.commit();
      this.pushEvent(session, 'downloads', { ...base, state: 'saved', path: finalPath, bytes });
    } catch (error) {
      reservation.release();
      await unlink(temporaryPath).catch(() => {});
      await unlink(finalPath).catch(() => {});
      if (error?.code === 'ARTIFACT_TOO_LARGE') this.pushEvent(session, 'downloads', { ...base, state: 'too_large', bytes });
      else this.pushEvent(session, 'downloads', { ...base, state: 'failed', error: bound(error?.message ?? String(error), 500) });
    }
  }

  async captureScreenshot(session, page) {
    const buffer = await page.screenshot({ type: 'png' });
    if (buffer.length > this.limits.imageBytes) {
      throw coded('ARTIFACT_TOO_LARGE', `Viewport screenshot is ${buffer.length} bytes, exceeding the ${this.limits.imageBytes}-byte cap; it was not saved.`);
    }
    const directory = path.join(session.artifactDir, 'screenshots');
    await mkdir(directory, { recursive: true });
    session.counters.screenshot += 1;
    const stem = path.join(directory, `${String(session.counters.screenshot).padStart(4, '0')}-${randomUUID()}`);
    const fullImagePath = `${stem}-full.png`;
    const displayImagePath = `${stem}-display.png`;
    const temporaryFull = `${stem}-full.partial.png`;
    const temporaryDisplay = `${stem}-display.partial.png`;
    const reservation = this.beginArtifactReservation(session, 'A screenshot');
    try {
      await writeFile(temporaryFull, buffer);
      const dimensions = await createDisplayPng(temporaryFull, temporaryDisplay);
      const displayBytes = (await stat(temporaryDisplay)).size;
      if (displayBytes > this.limits.imageBytes) {
        throw coded('ARTIFACT_TOO_LARGE', `Display screenshot is ${displayBytes} bytes, exceeding the ${this.limits.imageBytes}-byte cap; it was not saved.`);
      }
      reservation.add(buffer.length + displayBytes);
      await rename(temporaryFull, fullImagePath);
      await rename(temporaryDisplay, displayImagePath);
      reservation.commit();
      return {
        fullImagePath, displayImagePath,
        imageWidth: dimensions.width, imageHeight: dimensions.height,
        sourceWidth: dimensions.sourceWidth, sourceHeight: dimensions.sourceHeight,
      };
    } catch (error) {
      reservation.release();
      for (const artifactPath of [temporaryFull, temporaryDisplay, fullImagePath, displayImagePath]) await unlink(artifactPath).catch(() => {});
      throw error;
    }
  }

  async exportStorageState(session) {
    const context = session.primaryContext && session.contexts.has(session.primaryContext)
      ? session.primaryContext
      : session.browser?.contexts()[0];
    if (!context) throw coded('BROWSER_CRASHED', `playwright session "${session.id}" has no context to export storage state from.`);
    const directory = path.join(session.artifactDir, 'storage-state');
    await mkdir(directory, { recursive: true });
    const artifactPath = path.join(directory, `${String(Date.now())}-${randomUUID()}.json`);
    const temporaryPath = `${artifactPath}.partial`;
    const reservation = this.beginArtifactReservation(session, 'Exported storage state');
    try {
      // Covers cookies, local storage, and IndexedDB in Playwright 1.62.1.
      // Session storage is not captured and is unsupported in v1.
      await context.storageState({ indexedDB: true, path: temporaryPath });
      const size = (await stat(temporaryPath)).size;
      if (size > this.limits.storageStateBytes) {
        throw coded('ARTIFACT_TOO_LARGE', `Exported storage state is ${size} bytes, exceeding the ${this.limits.storageStateBytes}-byte cap; it was deleted.`);
      }
      reservation.add(size);
      await rename(temporaryPath, artifactPath);
      reservation.commit();
      return artifactPath;
    } catch (error) {
      reservation.release();
      await unlink(temporaryPath).catch(() => {});
      await unlink(artifactPath).catch(() => {});
      throw error;
    }
  }

  // ------------------------------------------------------------- observation

  collectEvents(session, settings) {
    const take = (queue, limitValue) => {
      const limit = limitValue ?? DEFAULT_EVENT_LIMIT;
      const list = session.queues[queue];
      const fresh = list.filter((entry) => entry.seq > session.delivered[queue]);
      const requested = limit === 0 ? [] : fresh.slice(-limit);
      const fitted = [];
      let bytes = 2;
      for (let index = requested.length - 1; index >= 0; index -= 1) {
        const entryBytes = Buffer.byteLength(JSON.stringify(requested[index]), 'utf8') + 1;
        if (bytes + entryBytes > MAX_EVENT_CATEGORY_OUTPUT_BYTES) break;
        fitted.unshift(requested[index]);
        bytes += entryBytes;
      }
      const omitted = fresh.length - fitted.length;
      if (omitted > 0) session.dropped[queue] += omitted;
      if (fresh.length > 0) session.delivered[queue] = fresh[fresh.length - 1].seq;
      return fitted;
    };
    const result = {
      console: take('console', settings?.consoleLimit),
      pageErrors: take('pageErrors', settings?.pageErrorLimit),
      failedRequests: take('failedRequests', settings?.requestLimit),
      downloads: take('downloads', settings?.downloadLimit),
      dropped: undefined,
    };
    result.dropped = { ...session.dropped };
    return result;
  }

  async tabSummaries(session) {
    const entries = [...session.pages];
    let selected = entries;
    if (entries.length > MAX_TAB_SUMMARIES) {
      selected = entries.slice(-MAX_TAB_SUMMARIES);
      const active = entries.find(([pageId]) => pageId === session.activePageId);
      if (active && !selected.some(([pageId]) => pageId === active[0])) selected = [active, ...selected.slice(1)];
    }
    const tabs = [];
    for (const [pageId, page] of selected) {
      tabs.push({ pageId, url: bound(page.url(), 2048), title: bound(await page.title().catch(() => ''), 200), active: pageId === session.activePageId });
    }
    return { tabs, dropped: entries.length - selected.length };
  }

  assertRef(session, pageId, target) {
    const state = session.pageState.get(pageId);
    if (!state || !state.refValid || state.revision !== target.revision || !state.refs.has(target.ref)) {
      const current = state?.refValid ? `current revision is ${state.revision}` : 'no fresh observation is available';
      throw coded(
        'STALE_REF',
        `Reference ${bound(target.ref, 128)} (revision ${target.revision}) is not valid for page ${pageId} of playwright session "${session.id}" (${current}). Call playwright observe to capture a fresh reference set.`,
        true,
      );
    }
  }

  locatorFor(page, target) {
    if ('ref' in target) return page.locator(`aria-ref=${target.ref}`);
    if (/(^|[\s"'=(])aria-ref\s*=/.test(target.selector)) {
      throw coded('INVALID_ARGUMENTS', 'selectors must not use the aria-ref engine; pass the ref and its observation revision via the ref field.');
    }
    return page.locator(target.selector);
  }

  /**
   * Builds an observation. When mode is not "none" a fresh snapshot establishes
   * the page's only valid ref set; otherwise only cheap metadata and events are
   * returned and old refs stay invalidated.
   */
  async buildObservation(session, page, settings, signal) {
    const pageId = session.pageIds.get(page);
    const state = session.pageState.get(pageId);
    const mode = settings?.mode ?? 'auto';
    const observation = {
      pageId,
      url: bound(page.url(), 2048),
      title: bound(await page.title().catch(() => ''), 500),
      events: this.collectEvents(session, settings),
    };
    if (mode !== 'none' && pageId !== undefined && state !== undefined) {
      let root = page;
      if (settings?.target) {
        if ('ref' in settings.target) this.assertRef(session, pageId, settings.target);
        root = this.locatorFor(page, settings.target);
      }
      const captured = await captureBoundedSnapshot({
        root,
        depth: settings?.depth,
        mode,
        artifactDir: session.artifactDir,
        artifactCounter: () => (session.snapshotCounter += 1),
        beginArtifactReservation: (label) => this.beginArtifactReservation(session, label),
        signal,
      });
      state.revision += 1;
      state.refs = captured.refs;
      state.refValid = true;
      observation.revision = state.revision;
      observation.snapshot = captured.text;
      if (captured.reduction) observation.reduction = captured.reduction;
    } else {
      observation.refsInvalidated = !state?.refValid;
    }
    if (settings?.includeTabs !== false) {
      const summaries = await this.tabSummaries(session);
      observation.tabs = summaries.tabs;
      if (summaries.dropped > 0) observation.tabsDropped = summaries.dropped;
    }
    return observation;
  }

  async observeCommand(params, signal) {
    const session = this.mustSession(params.sessionId);
    const page = this.resolvePage(session, params.pageId);
    const settings = params.observation ?? {};
    const response = { sessionId: session.id };
    response.observation = await this.buildObservation(session, page, settings, signal);
    if (settings?.screenshot === true) response.screenshot = await this.captureScreenshot(session, page);
    return response;
  }

  // ------------------------------------------------------------------- open

  assertBrowserInstalled() {
    let executable;
    try { executable = chromium.executablePath(); } catch { executable = undefined; }
    if (executable === undefined || !existsSync(executable)) {
      throw coded(
        'BROWSER_NOT_INSTALLED',
        'The Playwright-pinned Chromium build is not installed. Repair from the pie repository root: npm run install:dependencies',
      );
    }
  }

  async validateStorageStatePath(storageStatePath) {
    if (storageStatePath === undefined) return;
    let raw;
    try { raw = await readFile(storageStatePath); } catch {
      throw coded('INVALID_STORAGE_STATE', `Storage state file is not readable: ${bound(storageStatePath, 300)}.`);
    }
    if (raw.length > MAX_STORAGE_STATE_BYTES) {
      throw coded('INVALID_STORAGE_STATE', `Storage state file is ${raw.length} bytes, exceeding the ${MAX_STORAGE_STATE_BYTES}-byte cap.`);
    }
    let value;
    try { value = JSON.parse(raw.toString('utf8')); } catch {
      throw coded('INVALID_STORAGE_STATE', 'Storage state file is not valid JSON; export one with playwright close exportStorageState.');
    }
    if (!value || typeof value !== 'object' || !Array.isArray(value.cookies) || !Array.isArray(value.origins)) {
      throw coded('INVALID_STORAGE_STATE', 'Storage state must be a Playwright storage-state JSON object with cookies and origins arrays.');
    }
  }

  async open(params, signal) {
    this.assertBrowserInstalled();
    await this.validateStorageStatePath(params.storageStatePath);
    if (this.sessions.has(params.sessionId)) {
      throw coded('INVALID_ARGUMENTS', `playwright session "${bound(params.sessionId, 128)}" already exists; close it or choose another sessionId.`);
    }
    const session = this.makeSession(params.sessionId, params);
    this.sessions.set(session.id, session);
    try {
      let browser;
      try {
        // Only the Playwright-pinned Chromium build, always headless. Never
        // connects to the user's visible Chrome/Edge (no CDP attach, no
        // userDataDir, no channel fallback). launchServer gives this dedicated
        // tool session an explicit process handle for deterministic cleanup;
        // the subsequent connection is to that fresh local process only.
        session.browserServer = await chromium.launchServer({ headless: true });
        browser = await chromium.connect(session.browserServer.wsEndpoint());
      } catch (error) {
        throw coded('BROWSER_LAUNCH_FAILED', `Headless Chromium failed to launch: ${firstLine(error?.message ?? error)}`);
      }
      session.browser = browser;
      browser.on('disconnected', () => { session.crashed = true; });
      const contextOptions = { viewport: params.viewport ?? { width: 1280, height: 720 } };
      if (params.storageStatePath !== undefined) contextOptions.storageState = params.storageStatePath;
      let context;
      try {
        context = await browser.newContext(contextOptions);
      } catch (error) {
        if (params.storageStatePath !== undefined) {
          throw coded('INVALID_STORAGE_STATE', `Playwright rejected the imported storage state: ${firstLine(error?.message ?? error)}`);
        }
        throw error;
      }
      context.setDefaultTimeout(session.actionTimeoutMs);
      context.setDefaultNavigationTimeout(session.navigationTimeoutMs);
      session.primaryContext = context;
      this.registerContext(session, context);
      const page = await context.newPage();
      session.activePageId = this.registerPage(session, page);
      if (params.url !== undefined) {
        try {
          await page.goto(params.url, { timeout: session.navigationTimeoutMs });
        } catch (error) {
          throw coded('NAVIGATION_FAILED', `Navigation to ${bound(params.url, 300)} failed: ${firstLine(error?.message ?? error)}`);
        }
      }
      const settings = params.observation ?? {};
      const response = { sessionId: session.id, headless: true, isolated: true };
      response.observation = await this.buildObservation(session, page, settings, signal);
      if (settings.screenshot === true) response.screenshot = await this.captureScreenshot(session, page);
      return response;
    } catch (error) {
      await this.closeSession(session).catch(() => {});
      throw error;
    }
  }

  // -------------------------------------------------------------------- act

  installDialogPolicy(page, policy, state) {
    let nextPolicy = policy;
    const record = (entry) => {
      if (state.records.length < MAX_DIALOG_RECORDS) state.records.push(entry);
      else state.dropped += 1;
    };
    const handler = (dialog) => {
      const currentPolicy = nextPolicy;
      nextPolicy = undefined;
      void (async () => {
        try {
          if (currentPolicy?.action === 'accept') {
            await dialog.accept(currentPolicy.promptText);
            record({ result: 'accepted', type: dialog.type(), message: bound(dialog.message(), 500), defaultValue: dialog.defaultValue() });
          } else {
            await dialog.dismiss();
            record({ result: currentPolicy ? 'dismissed' : 'auto-dismissed', type: dialog.type(), message: bound(dialog.message(), 500), defaultValue: dialog.defaultValue() });
          }
        } catch (error) {
          record({ result: 'auto-dismissed', type: dialog.type(), message: `dialog handling failed: ${bound(error?.message ?? error, 300)}` });
        }
      })();
    };
    page.on('dialog', handler);
    return () => { page.off('dialog', handler); };
  }

  normalizeActionError(error, kind, target) {
    if (error?.code !== undefined && typeof error.code === 'string') return error;
    const message = error?.message ?? String(error);
    const timedOut = error?.name === 'TimeoutError' || /Timeout\s+\d+ms\s+exceeded/.test(message);
    if (/strict mode violation/.test(message)) {
      return coded('AMBIGUOUS_TARGET', `The target resolved to multiple elements: ${firstLine(message)} Use a ref from a fresh observation or a more specific selector.`, true);
    }
    if (timedOut && target && 'ref' in target) {
      return coded('STALE_REF', `Reference ${target.ref} did not resolve before the action timeout; the DOM likely replaced it. Call playwright observe to capture fresh references.`, true);
    }
    if (timedOut && kind === 'wait') return coded('ACTION_TIMEOUT', `Wait condition was not met within its deadline: ${firstLine(message)}`, true);
    if (NAVIGATION_KINDS.has(kind)) return coded('NAVIGATION_FAILED', `Navigation (${kind}) failed: ${firstLine(message)}`);
    if (timedOut) return coded('ACTION_TIMEOUT', `Action ${kind} timed out and may already have affected the page; observe before retrying: ${firstLine(message)}`);
    return coded('REQUEST_FAILED', `Action ${kind} failed: ${firstLine(message)}`);
  }

  async dispatchInput(session, page, input, timeoutMs, signal, dialogPolicy, dialogState) {
    const target = input.target;
    const locator = target === undefined ? undefined : this.locatorFor(page, target);
    const timeout = timeoutMs;
    switch (input.kind) {
      case 'navigate': await page.goto(input.url, { timeout }); return;
      case 'back': await page.goBack({ timeout }); return;
      case 'forward': await page.goForward({ timeout }); return;
      case 'reload': await page.reload({ timeout }); return;
      case 'click': await locator.click({ timeout }); return;
      case 'double_click': await locator.dblclick({ timeout }); return;
      case 'fill': await locator.fill(input.value, { timeout }); return;
      case 'type': await locator.pressSequentially(input.text, { timeout }); return;
      case 'press':
        if (locator === undefined) await page.keyboard.press(input.key);
        else await locator.press(input.key, { timeout });
        return;
      case 'select': await locator.selectOption(input.values, { timeout }); return;
      case 'check': await locator.check({ timeout }); return;
      case 'uncheck': await locator.uncheck({ timeout }); return;
      case 'hover': await locator.hover({ timeout }); return;
      case 'focus': await locator.focus({ timeout }); return;
      case 'upload': await locator.setInputFiles(input.paths, { timeout }); return;
      case 'wait': {
        const condition = input.condition;
        if (condition.timeMs !== undefined) { await page.waitForTimeout(condition.timeMs); return; }
        if (condition.url !== undefined) { await page.waitForURL(condition.url, { timeout }); return; }
        if (condition.text !== undefined) { await page.getByText(condition.text).first().waitFor({ state: 'visible', timeout }); return; }
        if (/(^|[\s"'=(])aria-ref\s*=/.test(condition.selector ?? '')) {
          throw coded('INVALID_ARGUMENTS', 'wait selector must not use the aria-ref engine.');
        }
        await page.waitForSelector(condition.selector, { state: 'visible', timeout });
        return;
      }
      case 'tab_open': {
        const newPage = await session.primaryContext.newPage();
        const id = this.registerPage(session, newPage);
        session.activePageId = id;
        const uninstall = this.installDialogPolicy(newPage, dialogPolicy, dialogState);
        try {
          if (input.url !== undefined) {
            try { await newPage.goto(input.url, { timeout: timeoutMs }); }
            catch (error) { throw coded('NAVIGATION_FAILED', `Navigation to ${bound(input.url, 300)} failed: ${firstLine(error?.message ?? error)}`); }
          }
        } finally {
          uninstall();
          await delay(25);
        }
        return;
      }
      case 'tab_select': {
        const selected = session.pages.get(input.pageId);
        if (!selected || selected.isClosed()) throw coded('PAGE_NOT_FOUND', `Page "${bound(input.pageId, 128)}" does not exist in playwright session "${session.id}".`, true);
        session.activePageId = input.pageId;
        await selected.bringToFront().catch(() => {});
        return;
      }
      case 'tab_close': {
        const closingId = input.pageId ?? session.activePageId;
        const closing = closingId === undefined ? undefined : session.pages.get(closingId);
        if (!closing) throw coded('PAGE_NOT_FOUND', `Page "${bound(closingId, 128)}" does not exist in playwright session "${session.id}".`, true);
        await closing.close();
        return;
      }
      default: throw coded('INVALID_ARGUMENTS', `Unsupported action kind: ${String(input.kind)}.`);
    }
  }

  async act(params, signal) {
    const session = this.mustSession(params.sessionId);
    const input = params.input;
    // tab_open is the explicit recovery path after the last page was closed; it
    // must not require an existing active page.
    const page = input.kind === 'tab_open' ? undefined : this.resolvePage(session, params.pageId);
    const pageId = page === undefined ? undefined : session.pageIds.get(page);
    if (input.target !== undefined && 'ref' in input.target) this.assertRef(session, pageId, input.target);

    // Every dispatched state-changing action invalidates the previous ref set
    // up front — whether it succeeds, fails ambiguously, or observes nothing.
    if (STATE_CHANGING_KINDS.has(input.kind)) {
      if (input.kind.startsWith('tab_')) this.invalidateAllRefs(session);
      else this.invalidateRefs(session, pageId);
    }

    const timeoutMs = params.timeoutMs ?? (NAVIGATION_KINDS.has(input.kind) || input.kind === 'tab_open' ? session.navigationTimeoutMs : session.actionTimeoutMs);
    const dialogState = { records: [], dropped: 0 };
    const uninstallDialogPolicy = page === undefined ? () => {} : this.installDialogPolicy(page, params.dialog, dialogState);
    try {
      await this.dispatchInput(session, page, input, timeoutMs, signal, params.dialog, dialogState);
    } catch (error) {
      throw this.normalizeActionError(error, input.kind, input.target);
    } finally {
      uninstallDialogPolicy();
      // tab_open installs on its newly created page inside dispatchInput.
      if (page !== undefined) await delay(25);
    }

    const settings = params.observation ?? {};
    const response = { sessionId: session.id, actionKind: input.kind, dialogs: dialogState.records };
    if (dialogState.dropped > 0) response.dialogsDropped = dialogState.dropped;
    const observationPage = session.activePageId !== undefined ? session.pages.get(session.activePageId) : page;
    if (observationPage && !observationPage.isClosed()) {
      response.observation = await this.buildObservation(session, observationPage, settings, signal);
      if (settings.screenshot === true) response.screenshot = await this.captureScreenshot(session, observationPage);
    }
    return response;
  }

  // --------------------------------------------------------------- run_code

  async summarizeRunCodeResult(session, value) {
    let text;
    if (value === undefined) {
      text = 'undefined';
    } else {
      const seen = new WeakSet();
      try {
        text = JSON.stringify(value, (key, entry) => {
          if (typeof entry === 'bigint') return `${entry}n`;
          if (typeof entry === 'function') return `[function ${entry.name || 'anonymous'}]`;
          if (entry !== null && typeof entry === 'object') {
            if (seen.has(entry)) return '[circular]';
            seen.add(entry);
          }
          return entry;
        }, 2);
        if (text === undefined) text = String(value);
      } catch {
        text = `[unserializable result: ${bound(String(value), 4000)}]`;
      }
    }
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= MAX_RUN_CODE_INLINE_BYTES) return { text, bytes, truncated: false };
    if (bytes > this.limits.runCodeBytes) {
      throw coded('ARTIFACT_TOO_LARGE', `run_code returned ${bytes} bytes, exceeding the ${this.limits.runCodeBytes}-byte result artifact cap; no incomplete artifact was saved.`);
    }
    const directory = path.join(session.artifactDir, 'run-code');
    await mkdir(directory, { recursive: true });
    session.counters.runCode += 1;
    const artifactPath = path.join(directory, `${String(session.counters.runCode).padStart(4, '0')}-${randomUUID()}.json`);
    const temporaryPath = `${artifactPath}.partial`;
    const reservation = this.beginArtifactReservation(session, 'A run_code result');
    try {
      reservation.add(bytes);
      await writeFile(temporaryPath, text);
      await rename(temporaryPath, artifactPath);
      reservation.commit();
      return {
        text: `${text.slice(0, 2000)}\n…[result preview truncated; complete JSON saved to the artifact path]`,
        bytes,
        truncated: true,
        artifactPath,
      };
    } catch (error) {
      reservation.release();
      await unlink(temporaryPath).catch(() => {});
      await unlink(artifactPath).catch(() => {});
      throw error;
    }
  }

  async writeRunCodeHelperArtifact(session, artifactId, name, value) {
    let buffer;
    if (Buffer.isBuffer(value)) buffer = value;
    else if (ArrayBuffer.isView(value)) buffer = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else if (value instanceof ArrayBuffer) buffer = Buffer.from(value);
    else if (typeof value === 'string') buffer = Buffer.from(value, 'utf8');
    else {
      let json;
      try { json = JSON.stringify(value, null, 2); }
      catch (error) { throw coded('REQUEST_FAILED', `run_code helper artifact could not be serialized: ${firstLine(error?.message ?? error)}`); }
      buffer = Buffer.from(json ?? 'null', 'utf8');
    }
    if (buffer.length > this.limits.runCodeBytes) {
      throw coded('ARTIFACT_TOO_LARGE', `run_code helper artifact is ${buffer.length} bytes, exceeding the ${this.limits.runCodeBytes}-byte cap; it was not saved.`);
    }
    const directory = path.join(session.artifactDir, 'run-code');
    await mkdir(directory, { recursive: true });
    session.counters.runCode += 1;
    const artifactPath = path.join(directory, `${String(session.counters.runCode).padStart(4, '0')}-${artifactId}-${sanitizeName(String(name ?? 'output'))}`);
    const temporaryPath = `${artifactPath}.partial`;
    const reservation = this.beginArtifactReservation(session, 'A run_code helper artifact');
    try {
      reservation.add(buffer.length);
      await writeFile(temporaryPath, buffer);
      await rename(temporaryPath, artifactPath);
      reservation.commit();
      return { artifactId, path: artifactPath, bytes: buffer.length };
    } catch (error) {
      reservation.release();
      await unlink(temporaryPath).catch(() => {});
      await unlink(artifactPath).catch(() => {});
      throw error;
    }
  }

  async cleanupRunCodeHelperArtifacts(session, records) {
    for (const record of records) await unlink(record.path).catch(() => {});
    session.artifactBytes = Math.max(0, session.artifactBytes - records.reduce((total, record) => total + record.bytes, 0));
  }

  async runCode(params, signal) {
    const session = this.mustSession(params.sessionId);
    const page = this.resolvePage(session, params.pageId);
    const timeoutMs = params.timeout ?? DEFAULT_RUN_CODE_TIMEOUT_MS;

    // Arbitrary code may touch anything reachable from the session browser:
    // invalidate everything before dispatch, reconcile and re-key afterwards.
    this.invalidateAllRefs(session);

    let fn;
    try { fn = (0, eval)(`(${params.code})`); } catch { fn = undefined; }
    if (typeof fn !== 'function') fn = undefined;

    let helperActive = true;
    const helperArtifacts = [];
    const helperTasks = [];
    const helpers = {
      writeArtifact: (name, value) => {
        if (!helperActive) return Promise.resolve({ saved: false, error: 'run_code artifact helper is no longer active' });
        if (helperTasks.length >= MAX_RUN_CODE_HELPER_ARTIFACTS) return Promise.resolve({ saved: false, error: `run_code permits at most ${MAX_RUN_CODE_HELPER_ARTIFACTS} helper artifacts per call` });
        const artifactId = randomUUID();
        const task = this.writeRunCodeHelperArtifact(session, artifactId, name, value).then((record) => {
          helperArtifacts.push(record);
          return { saved: true, artifactId, bytes: record.bytes };
        });
        void task.catch(() => {});
        helperTasks.push(task);
        return task;
      },
    };

    const invocation = async () => {
      if (fn) return await fn({ page, context: session.primaryContext, helpers });
      const body = new Function('page', 'context', 'helpers', `'use strict'; return (async () => { ${params.code}\n })();`);
      return await body(page, session.primaryContext, helpers);
    };

    let value;
    let runCodeSummary;
    let runCodeTimer;
    let abortHandler;
    try {
      const deadline = new Promise((_, reject) => {
        runCodeTimer = setTimeout(() => {
          reject(coded('RUN_CODE_TIMEOUT', `run_code exceeded ${timeoutMs}ms. Its outcome is ambiguous; the parent will terminate the browser runtime and every prior session/page/ref id must be reopened.`, false));
        }, timeoutMs);
        runCodeTimer.unref?.();
        abortHandler = () => reject(coded('CANCELLED', 'Playwright run_code was cancelled; the parent will terminate the browser runtime.'));
        signal?.addEventListener('abort', abortHandler, { once: true });
      });
      value = await Promise.race([invocation(), deadline]);
      helperActive = false;
      const helperSettlements = await Promise.allSettled(helperTasks);
      const helperFailure = helperSettlements.find((settlement) => settlement.status === 'rejected');
      if (helperFailure?.status === 'rejected') throw helperFailure.reason;
      // Serialize only after helpers are finalized. A result toJSON() therefore
      // cannot enlarge a raw helper path behind quota accounting.
      runCodeSummary = await this.summarizeRunCodeResult(session, value);
    } catch (error) {
      helperActive = false;
      await Promise.allSettled(helperTasks);
      await this.cleanupRunCodeHelperArtifacts(session, helperArtifacts);
      throw error;
    } finally {
      if (runCodeTimer) clearTimeout(runCodeTimer);
      if (abortHandler) signal?.removeEventListener('abort', abortHandler);
      this.reconcile(session);
    }

    const response = {
      sessionId: session.id,
      actionKind: 'run_code',
      runCode: runCodeSummary,
    };
    if (helperArtifacts.length > 0) response.helperArtifacts = helperArtifacts;
    const active = session.activePageId !== undefined ? session.pages.get(session.activePageId) : undefined;
    const settings = params.observation ?? {};
    if (active && !active.isClosed() && (settings.mode ?? 'auto') !== 'none') {
      response.observation = await this.buildObservation(session, active, settings, signal);
    } else if (active && !active.isClosed()) {
      response.observation = await this.buildObservation(session, active, { ...settings, mode: 'none' }, signal);
    }
    return response;
  }

  // ------------------------------------------------------------------ close

  async close(params) {
    const ids = params.scope === 'session'
      ? (params.sessionId === undefined ? [] : [params.sessionId])
      : [...this.sessions.keys()];
    let storageStatePath;
    let exportError;
    try {
      if (params.exportStorageState === true && params.sessionId !== undefined) {
        const session = this.sessions.get(params.sessionId);
        if (session) storageStatePath = await this.exportStorageState(session);
      }
    } catch (error) {
      exportError = error;
    }
    const closedIds = [];
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (session) { await this.closeSession(session); closedIds.push(id); }
    }
    const returnedIds = closedIds.slice(0, MAX_CLOSED_SESSION_IDS);
    const omittedSessionIds = closedIds.length - returnedIds.length;
    if (exportError) {
      const sample = closedIds.slice(0, 10);
      exportError.message = `${exportError.message} Close still completed for: ${sample.join(', ') || '(no live sessions)'}${closedIds.length > sample.length ? ` (+${closedIds.length - sample.length} more)` : ''}.`;
      throw exportError;
    }
    return {
      sessionId: params.sessionId, storageStatePath,
      closed: { scope: params.scope, sessionIds: returnedIds, ...(omittedSessionIds > 0 ? { omittedSessionIds } : {}) },
    };
  }
}
