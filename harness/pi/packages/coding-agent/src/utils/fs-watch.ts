import { type FSWatcher, realpathSync, type WatchListener, watch } from "node:fs";

export const FS_WATCH_RETRY_DELAY_MS = 5000;

export function closeWatcher(watcher: FSWatcher | null | undefined): void {
	if (!watcher) {
		return;
	}

	try {
		watcher.close();
	} catch {
		// Ignore watcher close errors
	}
}

export function watchWithErrorHandler(
	path: string,
	listener: WatchListener<string>,
	onError: () => void,
): FSWatcher | null {
	try {
		// Node 24's Windows libuv watcher can abort on 8.3 aliases before an error can be caught.
		const watchPath = process.platform === "win32" ? realpathSync.native(path) : path;
		const watcher = watch(watchPath, listener);
		watcher.on("error", onError);
		return watcher;
	} catch {
		onError();
		return null;
	}
}
