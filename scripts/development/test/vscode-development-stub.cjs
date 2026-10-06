'use strict';

// Invocation-only fixture: it supplies the small VS Code surface touched by
// compiled activation and rejects outbound network attempts. It is loaded via
// NODE_OPTIONS only for this headless child and its descendants; it is not a
// product runtime policy or a full VS Code platform emulator.
const Module = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const notify = message => {
  if (typeof process.send === 'function' && process.connected) process.send(message);
};
const networkDenied = (host, api) => {
  const detail = { type: 'external-network-denied', host: String(host ?? '<unknown>'), api };
  notify(detail);
  const logPath = process.env.PIE_VSCODE_FIXTURE_NETWORK_DENIED_FILE;
  if (logPath) {
    try { fsSync.appendFileSync(logPath, `${JSON.stringify(detail)}\n`); } catch {}
  }
  const error = new Error(`Headless VS Code fixture denied external network request via ${api} to ${detail.host}.`);
  error.code = 'PIE_FIXTURE_EXTERNAL_NETWORK_DENIED';
  throw error;
};
function isLoopback(host) {
  const normalized = String(host ?? 'localhost').replace(/^\[|\]$/gu, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
    || normalized.startsWith('127.');
}
function hostFromRequest(input, options) {
  if (typeof input === 'string' || input instanceof URL) {
    try { return new URL(input).hostname; } catch { return undefined; }
  }
  return options?.hostname ?? options?.host ?? input?.hostname ?? input?.host;
}
for (const client of [http, https]) {
  for (const name of ['request', 'get']) {
    const original = client[name];
    client[name] = function (input, options, ...rest) {
      const hostname = hostFromRequest(input, typeof options === 'object' ? options : undefined);
      if (hostname && !isLoopback(hostname)) networkDenied(hostname, `${client === https ? 'https' : 'http'}.${name}`);
      return original.call(this, input, options, ...rest);
    };
  }
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = args[0];
  const host = typeof options === 'object' && options !== null
    ? options.host ?? options.hostname
    : typeof args[1] === 'string' ? args[1] : undefined;
  if (typeof options === 'object' && options !== null && options.path && !options.host && !options.hostname) {
    return originalConnect.apply(this, args);
  }
  if (host && !isLoopback(host)) networkDenied(host, 'net.Socket.connect');
  return originalConnect.apply(this, args);
};
if (typeof globalThis.fetch === 'function') {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, ...args) {
    const hostname = hostFromRequest(input);
    if (hostname && !isLoopback(hostname)) {
      try { networkDenied(hostname, 'fetch'); }
      catch (error) { return Promise.reject(error); }
    }
    return originalFetch.call(this, input, ...args);
  };
}

function disposable() { return { dispose() {} }; }
function makeMemento() {
  const values = new Map();
  return {
    get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
    async update(key, value) { values.set(key, value); },
    keys() { return [...values.keys()]; },
  };
}
const configuration = {
  'pie.logLevel': 'info',
  'pie.tempLogRetention': { maxAgeDays: 7, maxTotalSizeMb: 500 },
  'pie.experimentAssignment': '',
  'pie.browserServer.enabled': true,
  'pie.browserServer.port': Number(process.env.PIE_VSCODE_DEVELOPMENT_BROWSER_PORT) || 0,
  'pie.browserServer.allowLan': false,
  'pie.browserServer.requirePreferredPort': false,
};
const globalSettings = {
  'pie.nodePath': process.execPath,
  'pie.browserServer.port': Number(process.env.PIE_VSCODE_DEVELOPMENT_BROWSER_PORT) || 0,
};
const workspaceFolderPath = process.env.PIE_VSCODE_DEVELOPMENT_WORKSPACE || process.cwd();
const workspaceUri = filePath => ({
  fsPath: path.resolve(filePath),
  scheme: 'file',
  path: path.resolve(filePath).replace(/\\/gu, '/'),
  toString() { return pathToFileURL(path.resolve(filePath)).href; },
});
const progressCalls = { value: 0 };
const outputChannel = name => ({
  name,
  logLevel: 3,
  appendLine() {}, show() {}, dispose() {},
  trace() {}, debug() {}, info() {}, warn() {}, error() {},
});
const vscode = {
  version: '1.99.0-headless-fixture',
  env: { appName: 'pie headless development fixture', language: 'en' },
  Uri: {
    file: workspaceUri,
    parse(value) {
      const parsed = new URL(value);
      return { fsPath: decodeURIComponent(parsed.pathname), scheme: parsed.protocol.slice(0, -1), path: parsed.pathname, toString: () => parsed.href };
    },
  },
  RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  workspace: {
    name: 'pie headless development fixture',
    workspaceFolders: [{ name: path.basename(workspaceFolderPath), uri: workspaceUri(workspaceFolderPath), index: 0 }],
    getConfiguration(section) {
      const prefix = section ? `${section}.` : '';
      return {
        get(key, fallback) {
          const full = `${prefix}${key}`;
          return Object.hasOwn(configuration, full) ? configuration[full]
            : Object.hasOwn(globalSettings, full) ? globalSettings[full] : fallback;
        },
        inspect(key) {
          const full = `${prefix}${key}`;
          return Object.hasOwn(globalSettings, full) ? { globalValue: globalSettings[full] } : undefined;
        },
        async update(key, value) {
          configuration[`${prefix}${key}`] = value;
          globalSettings[`${prefix}${key}`] = value;
        },
      };
    },
    onDidChangeConfiguration() { return disposable(); },
    registerTextDocumentContentProvider() { return disposable(); },
    async findFiles() { return []; },
    fs: {
      async stat(uri) { return fs.stat(uri.fsPath); },
      async readFile(uri) { return fs.readFile(uri.fsPath); },
    },
  },
  window: {
    state: { focused: true },
    createOutputChannel: outputChannel,
    createStatusBarItem() { return { command: undefined, show() {}, hide() {}, dispose() {} }; },
    registerWebviewViewProvider() { return disposable(); },
    showWarningMessage(message) { notify({ type: 'extension-warning', message: String(message) }); return Promise.resolve(undefined); },
    showInformationMessage(message) { notify({ type: 'extension-information', message: String(message) }); return Promise.resolve(undefined); },
    showErrorMessage(message) { notify({ type: 'extension-error', error: String(message) }); return Promise.resolve(undefined); },
    withProgress() {
      progressCalls.value += 1;
      notify({ type: 'production-handoff-attempt' });
      throw new Error('Headless fixture forbids production VS Code coordinator handoff UI.');
    },
  },
  commands: {
    registerCommand() { return disposable(); },
    async executeCommand() { return undefined; },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

globalThis.__PIE_VSCODE_DEVELOPMENT_FIXTURE__ = {
  vscode,
  makeMemento,
  progressCalls: () => progressCalls.value,
};
