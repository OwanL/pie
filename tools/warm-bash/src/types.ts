/** Structural shape of pi's BashOperations, declared locally so the testable
 *  core (warm-pool / operations / fast-path) has zero imports from the pi
 *  package. `index.ts` (which runs under the pi runtime where the package
 *  resolves) injects the real `createLocalBashOperations` as the fallback. */
export interface BashOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ) => Promise<{ exitCode: number | null }>;
}