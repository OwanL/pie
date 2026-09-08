import { readJsonFile } from './json.mjs';

export function readConfiguredPackageSources(settingsPath) {
  const settings = readJsonFile(settingsPath, { fallback: null });
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`Could not parse package settings from ${settingsPath}`);
  }

  const packages = settings.packages ?? [];
  if (!Array.isArray(packages)) {
    throw new Error(`Expected settings.packages to be an array in ${settingsPath}`);
  }

  return packages.map((entry, index) => {
    const source = typeof entry === 'string' ? entry : entry?.source;
    if (typeof source !== 'string' || source.trim() === '' || /[\r\n]/u.test(source)) {
      throw new Error(`Invalid package source at settings.packages[${index}] in ${settingsPath}`);
    }
    return source;
  });
}
