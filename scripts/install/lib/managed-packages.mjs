// Read-only readiness checks for Pi packages installed below the active
// managed agent directory. This deliberately never searches npm's global root.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { classifyManagedPackageSources, MANAGED_PACKAGE_REQUIREMENTS, managedPackageRoot, managedRequiredFileCandidates, resolveManagedCacheTargets } from '../../../shared/managed-package-contract.mjs';

function requirementFor(name) {
  const result = MANAGED_PACKAGE_REQUIREMENTS.find((entry) => entry.name === name);
  if (!result) throw new Error(`Unsupported managed package: ${name}`);
  return result;
}

export function inspectManagedPackage({ agentDir, packageName, cacheDir = process.env.PIE_CACHE_DIR }) {
  const requirement = requirementFor(packageName);
  const root = managedPackageRoot(agentDir, packageName);
  const remediation = `Install the managed package with: pi install ${requirement.source}`;
  const cacheTargets = resolveManagedCacheTargets(packageName, cacheDir) ?? [];
  const base = { name: packageName, expectedVersion: requirement.version, root, cacheTargets, remediation };
  let manifest;
  const manifestPath = path.join(root, 'package.json');
  if (!existsSync(manifestPath)) {
    return { ...base, status: 'missing', sourceFingerprint: 'unavailable', detail: `Managed package manifest is missing: ${manifestPath}` };
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return { ...base, status: 'malformed-manifest', sourceFingerprint: 'unavailable', detail: `Managed package manifest is not valid JSON: ${manifestPath}` };
  }
  if (manifest?.name !== packageName || typeof manifest.version !== 'string') {
    return { ...base, status: 'malformed-manifest', sourceFingerprint: 'unavailable', detail: `Managed package manifest is malformed: ${path.join(root, 'package.json')}` };
  }
  if (manifest.version !== requirement.version) {
    return { ...base, status: 'wrong-version', sourceFingerprint: 'unavailable', detail: `Managed package version ${manifest.version} is unsupported; expected ${requirement.version}.` };
  }
  for (const relative of requirement.requiredFiles) {
    if (!managedRequiredFileCandidates(root, relative).some((candidate) => existsSync(candidate))) {
      return { ...base, status: 'missing-source', sourceFingerprint: 'unavailable', detail: `Required managed package file is missing: ${relative}` };
    }
  }
  if (cacheTargets.length !== requirement.cacheTargets.length) {
    return { ...base, status: 'unresolved-cache', sourceFingerprint: 'unavailable', detail: 'PIE_CACHE_DIR is unset or is not an absolute path; the canonical cache target cannot be verified.' };
  }
  let fingerprint;
  try {
    const files = packageName === 'pi-web-access'
      ? { index: readFileSync(path.join(root, 'index.ts'), 'utf8'), storage: readFileSync(path.join(root, 'storage.ts'), 'utf8') }
      : { agentDir: readFileSync(path.join(root, 'agent-dir.ts'), 'utf8') };
    fingerprint = classifyManagedPackageSources(packageName, files);
  } catch {
    fingerprint = 'unavailable';
  }
  if (fingerprint === 'unsupported' || fingerprint === 'unavailable') {
    return { ...base, status: 'unsupported-source', sourceFingerprint: fingerprint, detail: `Pinned ${packageName} source fingerprint is unsupported or unreadable.` };
  }
  return { ...base, status: 'ready', sourceFingerprint: fingerprint, detail: `Managed ${packageName}@${requirement.version} source is ${fingerprint}.` };
}

export function inspectManagedPackages({ agentDir, cacheDir = process.env.PIE_CACHE_DIR }) {
  return MANAGED_PACKAGE_REQUIREMENTS.map(({ name }) => inspectManagedPackage({ agentDir, packageName: name, cacheDir }));
}

export function configuredManagedPackageSources(settings) {
  const entries = Array.isArray(settings?.packages) ? settings.packages : [];
  return entries.map((entry) => typeof entry === 'string' ? entry : entry?.source).filter((source) => typeof source === 'string');
}

export function managedPackagePinsReady(settings) {
  const configured = configuredManagedPackageSources(settings);
  return MANAGED_PACKAGE_REQUIREMENTS.every((requirement) => {
    const prefix = `npm:${requirement.name}@`;
    const bare = `npm:${requirement.name}`;
    const relevant = configured.filter((source) => source === bare || source.startsWith(prefix));
    return relevant.length === 1 && relevant[0] === requirement.source;
  });
}
