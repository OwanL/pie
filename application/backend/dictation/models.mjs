import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
export const MODEL_ASSETS = [
  { name: 'ggml-base.en.bin', bytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' },
  { name: 'ggml-silero-v6.2.0.bin', bytes: 885098, sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987', url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin' },
];
async function verify(file, asset) {
  if ((await stat(file)).size !== asset.bytes) throw new Error('Dictation model size mismatch');
  const hash = createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  if (hash.digest('hex') !== asset.sha256) throw new Error('Dictation model checksum mismatch');
}
export async function ensureModels(directory, notice, signal, assets = MODEL_ASSETS) {
  const paths = [];
  for (const asset of assets) {
    const root = join(directory, asset.sha256);
    await mkdir(root, { recursive: true });
    const target = join(root, asset.name);
    try { await stat(target); await verify(target, asset); paths.push(target); continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    notice(`Downloading ${asset.name}`);
    const owned = join(root, `.${randomUUID()}.download`);
    try {
      const downloadSignal = AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(180000)]);
      const response = await fetch(asset.url, { signal: downloadSignal });
      if (!response.ok || !response.body) throw new Error('Dictation model download failed');
      let bytes = 0;
      const bound = new Transform({ transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        callback(bytes > asset.bytes ? new Error('Dictation model exceeds pinned size') : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body), bound, createWriteStream(owned, { flags: 'wx' }), { signal: downloadSignal });
      await verify(owned, asset);
      // Atomic no-clobber publication; existing durable assets are never rewritten.
      try { await link(owned, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      await verify(target, asset);
      paths.push(target);
    } finally { await unlink(owned).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return paths;
}
