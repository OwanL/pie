import { Socket } from 'node:net';

export interface HostLifetimePipeWatcher {
  dispose(): void;
}

/** Watch an inherited, read-only host lifetime descriptor for pipe EOF.
 *
 * Use `net.Socket` rather than `fs.ReadStream`: on Windows, destroying an fd 3
 * ReadStream can leave its pipe handle pinning process shutdown while the host
 * writer is still open. Destroying this read-only socket releases that handle.
 */
export function watchHostLifetimePipe(
  fd: number,
  handlers: {
    onEof(): void;
    onError(error: Error): void;
  },
): HostLifetimePipeWatcher {
  let disposed = false;
  const socket = new Socket({ fd, readable: true, writable: false });
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    socket.destroy();
  };

  socket.once('end', () => {
    if (disposed) return;
    dispose();
    handlers.onEof();
  });
  socket.once('error', (error) => {
    if (disposed) return;
    dispose();
    handlers.onError(error);
  });
  socket.resume();

  return { dispose };
}
