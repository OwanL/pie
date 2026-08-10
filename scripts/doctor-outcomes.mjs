// Detect durable outcomes written to a displaced authority after its migration.
// Normal runtime/analytics still reads only the canonical root; registered
// migration sources are inspected solely so late writes cannot remain silent.
import fs from 'node:fs';
import path from 'node:path';

import { readRegisteredOutcomeSources } from './install/lib/outcomes.mjs';

function durableOutcomeFiles(root) {
  const files = [];
  const visit = (dir, accept) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, accept);
      else if (entry.isFile() && accept(file)) files.push(file);
    }
  };

  visit(path.join(root, 'sessions'), (file) => file.endsWith('.jsonl'));
  for (const name of ['reviews.jsonl', 'closure-actions.jsonl']) {
    const file = path.join(root, 'session-reviews', name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
  }
  if (fs.existsSync(root)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{16}$/i.test(entry.name)) continue;
      const file = path.join(root, entry.name, 'run-snapshots.jsonl');
      if (fs.existsSync(file) && fs.statSync(file).isFile()) files.push(file);
    }
  }
  return files;
}

export function collectPostMigrationOutcomeDrift({ canonicalOutcomesRoot }) {
  const canonical = path.resolve(canonicalOutcomesRoot);
  const sources = [];
  let changedFileCount = 0;
  for (const registered of readRegisteredOutcomeSources(canonical)) {
    const sourceRoot = path.resolve(registered.sourceRoot);
    if (sourceRoot === canonical || !fs.existsSync(sourceRoot)) continue;
    const scanStartedAt = registered.scanStartedAt ?? registered.lastMigratedAt;
    const scanStartedAtMs = Date.parse(scanStartedAt);
    if (!Number.isFinite(scanStartedAtMs)) continue;
    // ISO timestamps have millisecond precision while filesystem mtimes may
    // retain sub-millisecond fractions. A one-millisecond boundary tolerance
    // avoids flagging a file written immediately before the scan as a late write.
    const changedFiles = durableOutcomeFiles(sourceRoot)
      .filter((file) => fs.statSync(file).mtimeMs > scanStartedAtMs + 1)
      .map((file) => path.relative(sourceRoot, file));
    changedFileCount += changedFiles.length;
    sources.push({ sourceRoot, scanStartedAt, lastMigratedAt: registered.lastMigratedAt, changedFiles });
  }
  return { canonical, changedFileCount, sources };
}
