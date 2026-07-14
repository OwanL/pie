import assert from 'node:assert/strict';
import test from 'node:test';

import { prepareContextFiles } from '../../../src/backend/context-files';

test('prepareContextFiles deduplicates Windows paths that differ only by case or slash style', () => {
  const files = prepareContextFiles([
    {
      path: 'D:\\Projects\\StandAloneProjects\\pi-config\\AGENTS.md',
      content: 'Repo rules',
    },
    {
      path: 'd:/Projects/StandAloneProjects/pi-config/AGENTS.md',
      content: 'Duplicate repo rules',
    },
  ]);

  assert.deepEqual(files, [{
    path: 'D:/Projects/StandAloneProjects/pi-config/AGENTS.md',
    content: 'Repo rules',
    displayPath: 'pi-config/AGENTS.md',
  }]);
});

test('prepareContextFiles expands the displayed suffix until context file labels are unique', () => {
  const files = prepareContextFiles([
    { path: '/workspace/app/shared/AGENTS.md', content: 'App rules' },
    { path: '/workspace/lib/shared/AGENTS.md', content: 'Lib rules' },
  ]);

  assert.deepEqual(files.map((file) => file.displayPath), [
    'app/shared/AGENTS.md',
    'lib/shared/AGENTS.md',
  ]);
});
