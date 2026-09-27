import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';

import { MAX_IMAGE_PREVIEW_BYTES } from '../../../lib/protocol/image-preview.js';
import {
  openFileWithFallback,
  readImagePreviewWithFallback,
  type OpenFileAdapter,
} from '../../vscode/editor-integration/open-file.js';

interface Recorder {
  opened: string[];
  searched: Array<{ workingDirectory: string; basename: string }>;
  chooserCalls: number;
  errors: string[];
}

function makeAdapter(options: {
  exists?: boolean;
  matches?: readonly string[];
  selected?: string;
} = {}): { adapter: OpenFileAdapter; recorder: Recorder } {
  const recorder: Recorder = { opened: [], searched: [], chooserCalls: 0, errors: [] };
  return {
    recorder,
    adapter: {
      exists: async () => options.exists ?? false,
      findFiles: async (workingDirectory, basename) => {
        recorder.searched.push({ workingDirectory, basename });
        return options.matches ?? [];
      },
      chooseFile: async () => {
        recorder.chooserCalls += 1;
        return options.selected;
      },
      open: async (filePath) => { recorder.opened.push(filePath); },
      showError: (message) => { recorder.errors.push(message); },
    },
  };
}

const cwd = path.resolve('project');
const exactPath = path.join(cwd, 'README.md');

test('opens the exact supplied path before searching', async () => {
  const { adapter, recorder } = makeAdapter({ exists: true });

  await openFileWithFallback({ path: exactPath, reference: 'README.md', workingDirectory: cwd }, adapter);

  assert.deepEqual(recorder.opened, [exactPath]);
  assert.deepEqual(recorder.searched, []);
  assert.deepEqual(recorder.errors, []);
});

test('preserves an absolute reference and never basename-searches it', async () => {
  const { adapter, recorder } = makeAdapter({ exists: true });

  await openFileWithFallback({ path: exactPath, reference: exactPath, workingDirectory: cwd }, adapter);

  assert.deepEqual(recorder.opened, [exactPath]);
  assert.deepEqual(recorder.searched, []);
  assert.deepEqual(recorder.errors, []);
});

test('opens the unique basename match scoped to the originating working directory', async () => {
  const match = path.join(cwd, 'docs', 'README.md');
  const { adapter, recorder } = makeAdapter({ matches: [match] });

  await openFileWithFallback({ path: exactPath, reference: 'README.md', workingDirectory: cwd }, adapter);

  assert.deepEqual(recorder.searched, [{ workingDirectory: cwd, basename: 'README.md' }]);
  assert.deepEqual(recorder.opened, [match]);
  assert.deepEqual(recorder.errors, []);
});

test('shows a chooser for multiple matches and opens the selected path', async () => {
  const matches = [path.join(cwd, 'src', 'README.md'), path.join(cwd, 'docs', 'README.md')];
  const { adapter, recorder } = makeAdapter({ matches, selected: matches[1] });

  await openFileWithFallback({ path: exactPath, reference: 'README.md', workingDirectory: cwd }, adapter);

  assert.equal(recorder.chooserCalls, 1);
  assert.deepEqual(recorder.opened, [matches[1]]);
  assert.deepEqual(recorder.errors, []);
});

test('treats chooser cancellation as a no-op', async () => {
  const matches = [path.join(cwd, 'src', 'README.md'), path.join(cwd, 'docs', 'README.md')];
  const { adapter, recorder } = makeAdapter({ matches });

  await openFileWithFallback({ path: exactPath, reference: 'README.md', workingDirectory: cwd }, adapter);

  assert.equal(recorder.chooserCalls, 1);
  assert.deepEqual(recorder.opened, []);
  assert.deepEqual(recorder.errors, []);
});

test('shows a clear error when no exact or scoped basename match exists', async () => {
  const { adapter, recorder } = makeAdapter();

  await openFileWithFallback({ path: exactPath, reference: 'README.md', workingDirectory: cwd }, adapter);

  assert.deepEqual(recorder.errors, [`Could not find file "README.md" under ${cwd}.`]);
});

test('previews an explicit absolute image path outside the originating working directory', async () => {
  const outside = path.resolve('other-project', 'preview.png');
  const { adapter, recorder } = makeAdapter({ exists: true });
  const readPaths: string[] = [];
  const preview = await readImagePreviewWithFallback({ path: outside, reference: outside, workingDirectory: cwd }, {
    ...adapter,
    readFile: async (filePath, maxBytes) => {
      readPaths.push(`${filePath}:${maxBytes}`);
      return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    },
  });

  assert.deepEqual(readPaths, [`${outside}:${MAX_IMAGE_PREVIEW_BYTES}`]);
  assert.equal(preview?.mimeType, 'image/png');
  assert.equal(preview?.dataUrl, 'data:image/png;base64,iVBORw0KGgo=');
  assert.deepEqual(recorder.searched, []);
  assert.deepEqual(recorder.errors, []);
});

test('previews only a unique exact-path/bare-filename resolution', async () => {
  const match = path.join(cwd, 'assets', 'preview.webp');
  const { adapter, recorder } = makeAdapter({ matches: [match] });
  const preview = await readImagePreviewWithFallback({
    path: path.join(cwd, 'preview.webp'),
    reference: 'preview.webp',
    workingDirectory: cwd,
  }, {
    ...adapter,
    readFile: async (filePath) => {
      assert.equal(filePath, match);
      return Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    },
  });

  assert.equal(preview?.mimeType, 'image/webp');
  assert.deepEqual(recorder.searched, [{ workingDirectory: cwd, basename: 'preview.webp' }]);
});

test('does not choose among ambiguous preview matches or read unsupported formats', async () => {
  const matches = [path.join(cwd, 'src', 'preview.png'), path.join(cwd, 'docs', 'preview.png')];
  const { adapter, recorder } = makeAdapter({ matches });
  let reads = 0;
  const ambiguous = await readImagePreviewWithFallback({
    path: path.join(cwd, 'preview.png'),
    reference: 'preview.png',
    workingDirectory: cwd,
  }, { ...adapter, readFile: async () => { reads += 1; return new Uint8Array(); } });
  const svg = await readImagePreviewWithFallback({ path: path.join(cwd, 'drawing.svg') }, {
    ...adapter,
    readFile: async () => { reads += 1; return new TextEncoder().encode('<svg/>'); },
  });

  assert.equal(ambiguous, undefined);
  assert.equal(svg, undefined);
  assert.equal(recorder.chooserCalls, 0);
  assert.equal(reads, 0);
});

test('fails closed for oversized, malformed, and unreadable preview files', async () => {
  const request = { path: path.join(cwd, 'preview.png') };
  const { adapter } = makeAdapter({ exists: true });
  const oversized = await readImagePreviewWithFallback(request, {
    ...adapter,
    readFile: async (_filePath, maxBytes) => new Uint8Array(maxBytes + 1),
  });
  const malformed = await readImagePreviewWithFallback(request, {
    ...adapter,
    readFile: async () => new TextEncoder().encode('<svg/>'),
  });
  const unreadable = await readImagePreviewWithFallback(request, {
    ...adapter,
    readFile: async () => { throw new Error('permission denied'); },
  });

  assert.equal(oversized, undefined);
  assert.equal(malformed, undefined);
  assert.equal(unreadable, undefined);
});

test('does not basename-search outside the exact originating cwd or for explicit paths', async () => {
  const mismatchedPath = path.join(cwd, 'nested', 'README.md');
  const { adapter: cwdAdapter, recorder: cwdRecorder } = makeAdapter({
    matches: [path.join(cwd, 'README.md')],
  });
  await openFileWithFallback({
    path: mismatchedPath,
    reference: 'README.md',
    workingDirectory: cwd,
  }, cwdAdapter);
  assert.deepEqual(cwdRecorder.searched, []);
  assert.deepEqual(cwdRecorder.opened, []);

  const { adapter: explicitAdapter, recorder: explicitRecorder } = makeAdapter({
    matches: [path.join(cwd, 'README.md')],
  });
  await openFileWithFallback({
    path: path.join(cwd, 'nested', 'README.md'),
    reference: './nested/README.md',
    workingDirectory: cwd,
  }, explicitAdapter);
  assert.deepEqual(explicitRecorder.searched, []);

  const outside = path.resolve('other-project', 'README.md');
  const { adapter: outsideAdapter, recorder: outsideRecorder } = makeAdapter({ matches: [outside] });
  await openFileWithFallback({ path: exactPath, reference: 'README.md', workingDirectory: cwd }, outsideAdapter);
  assert.deepEqual(outsideRecorder.opened, []);
  assert.equal(outsideRecorder.errors.length, 1);
});
