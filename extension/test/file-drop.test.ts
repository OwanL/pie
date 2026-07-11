import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canAcceptComposerTransfer,
  canAcceptPathDrop,
  extractComposerInputs,
  extractDroppedPaths,
  formatComposerTransferError,
  hasClipboardFilePayload,
} from '../src/webview/panel/file-drop';

function makeTransfer(options: {
  types?: string[];
  textPlain?: string;
  uriList?: string;
  files?: Array<{
    path?: string;
    type?: string;
    name?: string;
    size?: number;
    arrayBuffer?: () => Promise<ArrayBuffer>;
  }>;
  items?: Array<{
    kind?: string;
    type?: string;
    getAsFile?: () => {
      path?: string;
      type?: string;
      name?: string;
      size?: number;
      arrayBuffer?: () => Promise<ArrayBuffer>;
    } | null;
  }>;
}) {
  return {
    types: options.types ?? [],
    files: options.files ?? [],
    items: options.items ?? [],
    getData(format: string): string {
      if (format === 'text/plain') return options.textPlain ?? '';
      if (format === 'text/uri-list') return options.uriList ?? '';
      return '';
    },
  };
}

function makeArrayBuffer(value: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(value);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test('extractDroppedPaths prefers file URIs from text/uri-list', () => {
  const dataTransfer = makeTransfer({
    types: ['text/uri-list', 'Files'],
    uriList: [
      '# comment',
      'file:///C:/workspaces/pie/README.md',
      'file:///C:/workspaces/pie/README.md',
      'file:///C:/workspaces/pie/src/index.ts',
    ].join('\r\n'),
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), [
    'C:\\workspaces\\pie\\README.md',
    'C:\\workspaces\\pie\\src\\index.ts',
  ]);
});

test('extractDroppedPaths converts UNC file URIs to Windows paths', () => {
  const dataTransfer = makeTransfer({
    types: ['text/uri-list'],
    uriList: 'file://server/share/folder/file.txt',
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), ['\\\\server\\share\\folder\\file.txt']);
});

test('extractDroppedPaths parses VS Code CodeFiles payloads', () => {
  const dataTransfer = makeTransfer({
    types: ['CodeFiles'],
    textPlain: 'not a path',
  });
  dataTransfer.getData = (format: string): string => {
    if (format === 'CodeFiles') {
      return JSON.stringify(['C:/repo/from-explorer.ts', 'C:/repo/from-explorer.ts']);
    }
    if (format === 'text/plain') {
      return 'not a path';
    }
    return '';
  };

  assert.deepEqual(extractDroppedPaths(dataTransfer), ['C:\\repo\\from-explorer.ts']);
});

test('extractDroppedPaths parses VS Code ResourceURLs payloads', () => {
  const dataTransfer = makeTransfer({
    types: ['ResourceURLs'],
  });
  dataTransfer.getData = (format: string): string => {
    if (format === 'ResourceURLs') {
      return JSON.stringify(['file:///C:/repo/from-resource.ts']);
    }
    return '';
  };

  assert.deepEqual(extractDroppedPaths(dataTransfer), ['C:\\repo\\from-resource.ts']);
});

test('canAcceptPathDrop accepts explicit file drag types without reading payloads', () => {
  for (const type of ['Files', 'CodeFiles', 'CodeEditors', 'ResourceURLs', 'application/vnd.code.uri-list']) {
    const dataTransfer = makeTransfer({ types: [type] });
    dataTransfer.getData = (): string => {
      throw new Error('payload unavailable during hover');
    };

    assert.equal(canAcceptPathDrop(dataTransfer), true, `expected ${type} to be accepted during hover`);
  }
});

test('canAcceptPathDrop accepts file drags when the browser exposes files without useful types', () => {
  const dataTransfer = makeTransfer({
    files: [{}],
  });
  dataTransfer.getData = (): string => {
    throw new Error('payload unavailable during hover');
  };

  assert.equal(canAcceptPathDrop(dataTransfer), true);
});

test('supported VS Code file drags still parse on drop after hover payload access fails', () => {
  const hoverTransfer = makeTransfer({
    types: ['CodeFiles'],
  });
  hoverTransfer.getData = (): string => {
    throw new Error('payload unavailable during hover');
  };

  const dropTransfer = makeTransfer({
    types: ['CodeFiles'],
  });
  dropTransfer.getData = (format: string): string => {
    if (format === 'CodeFiles') {
      return JSON.stringify(['C:/repo/from-explorer.ts']);
    }
    return '';
  };

  assert.equal(canAcceptPathDrop(hoverTransfer), true);
  assert.deepEqual(extractDroppedPaths(dropTransfer), ['C:\\repo\\from-explorer.ts']);
});

test('canAcceptPathDrop does not treat generic URL drags as file drops', () => {
  const dataTransfer = makeTransfer({
    types: ['text/uri-list', 'text/plain'],
    uriList: 'https://example.com/readme',
    textPlain: 'https://example.com/readme',
  });

  assert.equal(canAcceptPathDrop(dataTransfer), true);
  assert.deepEqual(extractDroppedPaths(dataTransfer), []);
});

test('extractDroppedPaths accepts plain text absolute paths only', () => {
  const dataTransfer = makeTransfer({
    types: ['text/plain'],
    textPlain: 'C:/repo/a.ts\n\\\\server\\share\\b.ts',
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), [
    'C:\\repo\\a.ts',
    '\\\\server\\share\\b.ts',
  ]);
});

test('extractDroppedPaths rejects arbitrary dragged text', () => {
  const dataTransfer = makeTransfer({
    types: ['text/plain'],
    textPlain: 'dragged text from the editor',
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), []);
  assert.equal(canAcceptPathDrop(dataTransfer), true);
});

test('extractDroppedPaths falls back to file.path when present', () => {
  const dataTransfer = makeTransfer({
    types: ['Files'],
    files: [{ path: 'C:\\repo\\alpha.ts' }, { path: 'C:\\repo\\beta.ts' }],
  });

  assert.deepEqual(extractDroppedPaths(dataTransfer), [
    'C:\\repo\\alpha.ts',
    'C:\\repo\\beta.ts',
  ]);
});

test('canAcceptPathDrop detects file-like drag payloads without parsing plain text drags', () => {
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['Files'] })), true);
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['CodeFiles'] })), true);
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['ResourceURLs'] })), true);
  assert.equal(
    canAcceptPathDrop(makeTransfer({ types: ['text/uri-list'], uriList: 'file:///tmp/app.ts' })),
    true,
  );
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['text/plain'], textPlain: '/tmp/app.ts' })), true);
  assert.equal(canAcceptPathDrop(makeTransfer({ types: ['text/plain'], textPlain: 'hello world' })), true);
});

test('canAcceptComposerTransfer accepts image clipboard payloads', () => {
  const dataTransfer = makeTransfer({
    files: [{ type: 'image/png', name: 'paste.png', size: 4, arrayBuffer: async () => makeArrayBuffer('png!') }],
  });

  assert.equal(canAcceptComposerTransfer(dataTransfer), true);
});

test('hasClipboardFilePayload accepts item-based clipboard images', () => {
  const dataTransfer = makeTransfer({
    items: [{
      kind: 'file',
      type: 'image/png',
      getAsFile: () => ({
        type: 'image/png',
        name: 'clipboard-item.png',
        size: 4,
        arrayBuffer: async () => makeArrayBuffer('png!'),
      }),
    }],
  });

  assert.equal(hasClipboardFilePayload(dataTransfer), true);
  assert.equal(canAcceptComposerTransfer(dataTransfer), true);
});

test('extractComposerInputs lowers dropped path-like payloads into filesystem refs', async () => {
  const dataTransfer = makeTransfer({
    types: ['text/uri-list'],
    uriList: 'file:///workspace/src/app.ts',
  });

  const result = await extractComposerInputs(dataTransfer, 'drop');
  assert.deepEqual(result, {
    inputs: [{
      kind: 'filesystemPathRef',
      path: '/workspace/src/app.ts',
      name: 'app.ts',
      source: 'drop',
    }],
    unsupportedInputs: [],
    rejectedFiles: [],
  });
});

test('extractComposerInputs lowers pasted image blobs into image inputs', async () => {
  const dataTransfer = makeTransfer({
    files: [{
      type: 'image/png',
      name: 'clipboard-image.png',
      size: 4,
      arrayBuffer: async () => makeArrayBuffer('png!'),
    }],
  });

  const result = await extractComposerInputs(dataTransfer, 'paste');
  assert.deepEqual(result, {
    inputs: [{
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'clipboard-image.png',
      sizeBytes: 4,
      dataBase64: Buffer.from('png!').toString('base64'),
      source: 'paste',
    }],
    unsupportedInputs: [],
    rejectedFiles: [],
  });
});

test('extractComposerInputs compresses raster screenshots before base64 when injected codec is smaller', async () => {
  const dataTransfer = makeTransfer({ files: [{
    type: 'image/png', name: 'shot.png', size: 8,
    arrayBuffer: async () => makeArrayBuffer('original'),
  }] });
  const result = await extractComposerInputs(dataTransfer, 'drop', async () => ({
    data: makeArrayBuffer('webp'), mimeType: 'image/webp', width: 1600, height: 900,
  }));
  assert.deepEqual(result.inputs[0], {
    kind: 'imageBlob', mimeType: 'image/webp', name: 'shot.webp', sizeBytes: 4,
    dataBase64: Buffer.from('webp').toString('base64'), width: 1600, height: 900, source: 'drop',
  });
});

test('extractComposerInputs uses the codec output MIME type for the compressed filename', async () => {
  const result = await extractComposerInputs(makeTransfer({ files: [{
    type: 'image/png', name: 'shot.png', arrayBuffer: async () => makeArrayBuffer('original'),
  }] }), 'paste', async () => ({
    data: makeArrayBuffer('jpg'), mimeType: 'image/jpeg', width: 1200, height: 800,
  }));
  assert.equal((result.inputs[0] as { mimeType: string }).mimeType, 'image/jpeg');
  assert.equal((result.inputs[0] as { name: string }).name, 'shot.jpg');
});

test('extractComposerInputs keeps original for unsupported codec MIME metadata', async () => {
  const result = await extractComposerInputs(makeTransfer({ files: [{
    type: 'image/png', name: 'shot.png', arrayBuffer: async () => makeArrayBuffer('original'),
  }] }), 'paste', async () => ({
    data: makeArrayBuffer('bad'), mimeType: 'application/octet-stream', width: 1, height: 1,
  }));
  assert.equal((result.inputs[0] as { mimeType: string }).mimeType, 'image/png');
  assert.equal((result.inputs[0] as { name: string }).name, 'shot.png');
  assert.equal((result.inputs[0] as { sizeBytes: number }).sizeBytes, 8);
});

test('extractComposerInputs keeps original when compression is not smaller and skips GIF codec', async () => {
  let calls = 0;
  const codec = async () => {
    calls += 1;
    return { data: makeArrayBuffer('not-smaller'), mimeType: 'image/webp', width: 1, height: 1 };
  };
  const png = await extractComposerInputs(makeTransfer({ files: [{
    type: 'image/png', name: 'shot.png', arrayBuffer: async () => makeArrayBuffer('png!'),
  }] }), 'paste', codec);
  const gif = await extractComposerInputs(makeTransfer({ files: [{
    type: 'image/gif', name: 'animation.gif', arrayBuffer: async () => makeArrayBuffer('gif!'),
  }] }), 'paste', codec);
  assert.equal(calls, 1);
  assert.equal((png.inputs[0] as { mimeType: string }).mimeType, 'image/png');
  assert.equal((gif.inputs[0] as { mimeType: string }).mimeType, 'image/gif');
});

test('extractComposerInputs lowers item-based pasted image blobs into image inputs', async () => {
  const dataTransfer = makeTransfer({
    items: [{
      kind: 'file',
      type: 'image/png',
      getAsFile: () => ({
        type: 'image/png',
        name: 'clipboard-item.png',
        size: 4,
        arrayBuffer: async () => makeArrayBuffer('png!'),
      }),
    }],
  });

  const result = await extractComposerInputs(dataTransfer, 'paste');
  assert.deepEqual(result, {
    inputs: [{
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'clipboard-item.png',
      sizeBytes: 4,
      dataBase64: Buffer.from('png!').toString('base64'),
      source: 'paste',
    }],
    unsupportedInputs: [],
    rejectedFiles: [],
  });
});

test('extractComposerInputs keeps dropped non-image files as filesystem path refs when a path is available', async () => {
  const dataTransfer = makeTransfer({
    files: [{ path: 'C:\\repo\\notes.txt', name: 'notes.txt', type: 'text/plain', size: 12 }],
  });

  const result = await extractComposerInputs(dataTransfer, 'drop');
  assert.deepEqual(result, {
    inputs: [{
      kind: 'filesystemPathRef',
      path: 'C:\\repo\\notes.txt',
      name: 'notes.txt',
      source: 'drop',
    }],
    unsupportedInputs: [],
    rejectedFiles: [],
  });
});

test('extractComposerInputs rejects unsupported arbitrary file blobs without filesystem paths', async () => {
  const dataTransfer = makeTransfer({
    files: [{ name: 'report.pdf', type: 'application/pdf', size: 128 }],
  });

  const result = await extractComposerInputs(dataTransfer, 'drop');
  assert.deepEqual(result, {
    inputs: [],
    unsupportedInputs: [{
      kind: 'fileBlob',
      mimeType: 'application/pdf',
      name: 'report.pdf',
      sizeBytes: 128,
      dataBase64: '',
      source: 'drop',
    }],
    rejectedFiles: ['report.pdf'],
  });
  assert.match(formatComposerTransferError(result.rejectedFiles) ?? '', /arbitrary file blobs/i);
});
