import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';

export default function (pi: ExtensionAPI) {
  pi.on('resources_discover', async (event) => {
    const cwd = typeof event.cwd === 'string' ? event.cwd.trim() : '';
    if (!cwd || !isAbsolute(cwd)) {
      return {};
    }

    const skillsDir = join(cwd, 'skills');
    if (!existsSync(skillsDir)) {
      return {};
    }

    try {
      if (!statSync(skillsDir).isDirectory()) {
        return {};
      }
    } catch {
      return {};
    }

    return {
      skillPaths: [skillsDir],
    };
  });
}
