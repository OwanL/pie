/** Result shape shared by the bounded host command executor and its callers. */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
