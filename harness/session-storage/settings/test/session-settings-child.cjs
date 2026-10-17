'use strict';
require('tsx/cjs');
const fs = require('node:fs/promises');
const store = require('../session-settings-store.ts');
process.on('message', async message => {
  if (message.kind !== 'write') return;
  try {
    if (message.pause) {
      const original = fs.readFile;
      let paused = false;
      fs.readFile = async (...args) => {
        const result = await original(...args);
        if (!paused && args[0] === message.pauseFile) {
          paused = true;
          process.send({ kind: 'read' });
          await new Promise(resolve => process.once('message', resolve));
        }
        return result;
      };
    }
    process.send({ kind: 'started' });
    await store.writeSystemPromptTogglesForSession(message.session, [message.session], true);
    process.send({ kind: 'done' });
  } catch (error) { process.send({ kind: 'failed', error: String(error) }); }
});
process.send({ kind: 'ready' });
