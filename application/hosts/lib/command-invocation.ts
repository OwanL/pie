export interface CommandInvocation {
  command: string;
  args: string[];
}

export function resolveCommandInvocation(
  command: string,
  args: string[],
  options?: {
    platform?: NodeJS.Platform;
    comSpec?: string;
  },
): CommandInvocation {
  const platform = options?.platform ?? process.platform;

  if (platform === 'win32' && command === 'npm') {
    const comSpec = options?.comSpec ?? process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
    return {
      command: comSpec,
      args: ['/d', '/s', '/c', ['npm', ...args].join(' ')],
    };
  }

  return { command, args };
}
