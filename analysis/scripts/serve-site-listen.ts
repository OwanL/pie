import type * as http from 'node:http';

const HOST = '127.0.0.1';

/** Listen with promise-based startup errors so a port conflict is reported by the
 * serve command's normal error boundary instead of becoming an unhandled event. */
export async function listenOnLocalhost(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: NodeJS.ErrnoException): void => {
      cleanup();
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use. The dashboard may already be running at `
          + `http://${HOST}:${port}; stop that process or pass --port <port>.`,
        ));
        return;
      }
      reject(error);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, HOST);
  });
}
