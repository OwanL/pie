import { pathToFileURL } from 'node:url';

export function withWinLddTracePreload(args, preloadPath) {
  return ['--import', pathToFileURL(preloadPath).href, ...args];
}
