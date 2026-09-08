import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

export function spawnCliSync(command, args, options) {
  if (process.platform !== 'win32' || ['.exe', '.com'].includes(path.extname(command).toLowerCase())) {
    return spawnSync(command, args, options);
  }

  return spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command, ...args], options);
}
