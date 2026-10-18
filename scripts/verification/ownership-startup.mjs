// Private, bounded startup authorization shared by verification roots.
export const OWNERSHIP_STARTUP_TOKEN = 'pie-focused-ownership-ready\n';

export function waitForOwnershipAuthorization(stream, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const expected = Buffer.from(OWNERSHIP_STARTUP_TOKEN);
    const finish = error => {
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      stream.pause();
      if (error) reject(error);
      else resolve();
    };
    const unauthorized = () => new Error('Test ownership startup was not authorized');
    const onData = chunk => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length > expected.length - received.length) return finish(unauthorized());
      received = Buffer.concat([received, bytes]);
      if (!expected.subarray(0, received.length).equals(received)) finish(unauthorized());
    };
    const onEnd = () => finish(received.equals(expected) ? undefined : unauthorized());
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error('Test ownership startup handshake timed out')), timeoutMs);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    stream.resume();
  });
}
