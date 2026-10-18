import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Dependency acquisition stays with each consumer's extension owner.
export function createPngImageTools(PNG, { copyUnscaled = false } = {}) {
  async function pngDimensions(filePath) {
    const image = PNG.sync.read(await readFile(filePath));
    return { width: image.width, height: image.height };
  }

  async function createDisplayPng(sourcePath, destinationPath, maxLongEdge = 1600) {
    const bytes = await readFile(sourcePath);
    const source = PNG.sync.read(bytes);
    const scale = Math.min(1, maxLongEdge / Math.max(source.width, source.height));
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    let displayBytes = bytes;
    if (!copyUnscaled || scale !== 1) {
      const output = new PNG({ width, height });
      for (let y = 0; y < height; y += 1) {
        const sourceY = Math.min(source.height - 1, Math.floor(y / scale));
        for (let x = 0; x < width; x += 1) {
          const sourceX = Math.min(source.width - 1, Math.floor(x / scale));
          const from = (sourceY * source.width + sourceX) * 4;
          const to = (y * width + x) * 4;
          output.data[to] = source.data[from]; output.data[to + 1] = source.data[from + 1];
          output.data[to + 2] = source.data[from + 2]; output.data[to + 3] = source.data[from + 3];
        }
      }
      displayBytes = PNG.sync.write(output);
    }
    const temporary = `${destinationPath}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, displayBytes); await rename(temporary, destinationPath); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return { width, height, sourceWidth: source.width, sourceHeight: source.height };
  }

  return { pngDimensions, createDisplayPng };
}
