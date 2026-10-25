#!/usr/bin/env node

import { createWriteStream, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Transform } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { run } from 'node:test';
import * as reporters from 'node:test/reporters';
import { waitForOwnershipAuthorization } from './ownership-startup.mjs';

const [configPath] = process.argv.slice(2);
if (!configPath) throw new Error('Node test runner configuration path is required.');

const {
  files,
  sourceFileByEntry = {},
  cwd,
  options,
  reporterNames,
  reporterDestinations,
  waitForOwnership,
} = JSON.parse(readFileSync(configPath, 'utf8'));

async function resolveReporter(name) {
  if (typeof reporters[name] === 'function') return reporters[name];
  const reporterPath = path.isAbsolute(name) ? name : path.resolve(cwd, name);
  const loaded = await import(pathToFileURL(reporterPath).href);
  const reporter = loaded.default;
  if (typeof reporter !== 'function') throw new Error(`Test reporter must export a default stream transform: ${name}`);
  return reporter;
}

function destinationFor(name) {
  if (name === undefined || name === 'stdout') return process.stdout;
  if (name === 'stderr') return process.stderr;
  return createWriteStream(path.resolve(cwd, name));
}

function projectReporterEvent(event, sourceFileByEntry) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return event;
  const sourceFor = entry => typeof entry === 'string' && Object.hasOwn(sourceFileByEntry, entry)
    ? sourceFileByEntry[entry]
    : undefined;
  const name = sourceFor(data.name);
  const file = sourceFor(data.file);
  if (name === undefined && file === undefined) return event;
  return { ...event, data: { ...data, ...(name === undefined ? {} : { name }), ...(file === undefined ? {} : { file }) } };
}

function reporterEventTransform(sourceFileByEntry) {
  return new Transform({
    objectMode: true,
    transform(event, _encoding, callback) { callback(null, projectReporterEvent(event, sourceFileByEntry)); },
  });
}

// Keep this root child-free until the live ownership census explicitly authorizes it.
if (waitForOwnership) await waitForOwnershipAuthorization(process.stdin);

const selectedReporters = reporterNames.length > 0
  ? reporterNames
  : [process.stdout.isTTY ? 'spec' : 'tap'];
if (reporterDestinations.length > 0 && reporterDestinations.length !== selectedReporters.length) {
  throw new Error('Each --test-reporter requires a matching --test-reporter-destination.');
}
const reporterTransforms = await Promise.all(selectedReporters.map(resolveReporter));
const testStream = run({
  ...options,
  files,
  cwd,
  isolation: options.isolation ?? 'process',
  // Node inherits process runtime flags; execArgv would append them again.
});
const fileNames = new Set(files);
const activeFiles = new Map();
const sourceName = entry => sourceFileByEntry[entry] ?? entry;
// Optional native file-lifecycle diagnostics make a watchdog failure actionable
// without introducing a second scheduler or changing Node's test execution.
if (process.env.PIE_TEST_FILE_DIAGNOSTICS === '1') {
  testStream.on('test:dequeue', data => {
    if (fileNames.has(data.name)) {
      const source = sourceName(data.name);
      activeFiles.set(data.name, source);
      console.error(`[node:test start] ${source}`);
    }
  });
  const completed = data => {
    const source = activeFiles.get(data.name);
    if (source !== undefined) {
      activeFiles.delete(data.name);
      console.error(`[node:test complete] ${source}`);
    }
  };
  testStream.on('test:complete', completed);
  testStream.on('test:pass', completed);
  testStream.on('test:fail', completed);
  const pending = () => { for (const source of activeFiles.values()) console.error(`[node:test pending] ${source}`); };
  process.on('beforeExit', pending);
  const timer = setInterval(pending, 30_000);
  timer.unref();
  testStream.once('end', () => clearInterval(timer));
}
// Node serializes enumerable Error metadata and wraps failures in ERR_TEST_FAILURE.
// Inspect only failed events: expected assert.rejects errors are not failures.
function teardownUnconfirmed(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  return error.teardownUnconfirmed === true
    || teardownUnconfirmed(error.cause, seen)
    || (Array.isArray(error.errors) && error.errors.some(value => teardownUnconfirmed(value, seen)));
}
let uncertainFailure = false;
testStream.on('test:fail', data => {
  uncertainFailure ||= teardownUnconfirmed(data.details?.error);
  process.exitCode = uncertainFailure ? 125 : 1;
});
testStream.on('test:summary', data => {
  if (data.success === false || (data.failed ?? 0) > 0) process.exitCode = uncertainFailure ? 125 : 1;
});
for (let index = 0; index < reporterTransforms.length; index += 1) {
  testStream.compose(reporterEventTransform(sourceFileByEntry))
    .compose(reporterTransforms[index])
    .pipe(destinationFor(reporterDestinations[index]));
}
