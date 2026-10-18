# Windows owned trees (SDK-independent)

`windows-owned-tree.mjs` requires Windows 10+ and Windows PowerShell 5.1 with
working `Add-Type`. It does not resolve, build, validate, or register an SDK, and
has no dependency on the workspace reader gate or verification machinery.

## API

```ts
spawnWindowsOwnedTree({
  command: string, // absolute executable path; no shell or PATH resolution
  args?: string[],
  cwd: string, // absolute directory
  env?: Record<string, string | undefined>, // exact child environment; default process.env
  startupTimeoutMs?: number, // default 15000; integer 0..60000
  signal?: AbortSignal, // pending startup only; use stopAndDrain after readiness
}): Promise<{
  invocationId: string,
  rootPid: number,
  guardianPid: number, // diagnostic/fault injection only, not lifetime authority
  evidenceDirectory: string,
  stdout: Readable,
  stderr: Readable,
  completion: Promise<{ code: number | null }>,
  authorizeStartup(text: string): Promise<void>,
  stopAndDrain(options?: { timeoutMs?: number }): Promise<
    | { gone: true, activeProcesses: 0, invocationId: string, rootPid: number,
        admissionSealed: true, authority: 'open-windows-job-accounting' }
    | { gone: false, invocationId: string, rootPid: number,
        diagnostic: string, evidenceDirectory: string }
  >,
  closeAfterRelease(): Promise<void>,
}>
```

`authorizeStartup` writes the exact UTF-8 text (at most 16 KiB, no NULs) once
and closes private child stdin. Empty text closes stdin without a zero-length
write. Callers supply their own newline/token protocol;
the primitive does not validate a token or claim that arbitrary children wait
for it. In particular Node preloads execute before authorization, **inside** the
Job. A second authorization or authorization after stop is rejected. A lost
write acknowledgement is not permission to retry authorization.

`completion` describes the root only. Its native unsigned Windows exit code is
returned, or `null` on lost supervision. Grandchildren can still be alive.
Consume stdout/stderr as ordinary child output (with backpressure). PowerShell
bootstrap failures can also appear on stderr. Output cannot forge control frames:
only the guardian holds the separate outbound named-pipe control handle. Child
stdin is not the guardian's control stdin.

`stopAndDrain` synchronously seals local admission, coalesces concurrent stop
calls, and tells the guardian to seal admission and terminate the Job. It then
polls kernel Job accounting with the Job handle **still open**. Only an observed
zero active process count produces the frozen, invocation/root-bound proof.
The default drain timeout is 10000 ms (integer 0..60000); acknowledgement has an
additional 5000 ms transport allowance. Timeout/termination success/process exit
is not proof. A delayed response cannot satisfy another request. False results
retain diagnostic evidence and permit retry while supervision remains intact.
A received proof remains valid because admission is permanently sealed and no
other process owns the unnamed Job handle; the proof is cached.

After releasing its external resources using that matching proof, the owner
calls `closeAfterRelease`. This requires the proof, acknowledges close, waits for
guardian exit, and deletes this invocation's temporary script/evidence directory.
The method is idempotent. It does not itself release any external lease. Failure
retains evidence; no recovery of external resources is implied.

## Containment and failure boundaries

Before Add-Type, compiler-free Reflection.Emit interop places the guardian
itself in a private, noninheritable KILL_ON_JOB_CLOSE bootstrap Job. This contains
compiler helpers even on forced startup teardown; its handle is held until
guardian exit and is **never** used as an extinction authority. Inside that Job,
the guardian creates a separate unnamed, noninheritable root Job with
KILL_ON_JOB_CLOSE and without breakaway flags. It creates the root suspended using `CreateProcessW`
and a restricted `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` containing **only** private
child stdin and duplicates of stdout/stderr. The Job and control handles are not
inherited. No process is opened by PID.

One deliberate refinement of the proposed create/assign/resume sequence is
`PROC_THREAD_ATTRIBUTE_JOB_LIST`: assignment occurs **atomically at process
creation**, while the root is suspended. This avoids an unowned suspended root
if the guardian crashes between creation and a later `AssignProcessToJobObject`.
Membership is verified through the original returned process handle before
`ResumeThread`. Unsupported job-list attributes or incompatible enclosing Jobs
fail closed; there is no attach-by-PID, breakaway, or uncontained fallback.

The guardian receives the intended child environment separately over private
stdin. Its own environment uses the existing agent-process guardian's small
Windows allowlist and is checked against the Add-Type 64 KiB environment limit.
No child environment or authorization token is written to the evidence directory.

Control EOF requests termination and bounded best-effort drain before closing
the Job. Guardian death triggers KILL_ON_JOB_CLOSE, but the caller cannot infer
empty proof from that. Startup timeout/abort closes control stdin, waits up to
15 seconds for graceful guardian teardown, and then kills/awaits the guardian if
necessary. Atomic assignment also contains the root during this last-resort
kill. Early startup errors include an `evidenceDirectory` property once one has
been allocated; pre-validation/pre-abort errors have no allocated resources.

This is not a hostile-user security boundary: an administrator/debugger, kernel
failure, machine shutdown, or malicious child using external brokers/privileged
handle duplication is outside the model. The bootstrap Job is kill-on-close
containment, not a compiler-helper empty proof. The primitive does not recover
after guardian/owner or machine failure. Unknown supervision retains evidence
and must not authorize
an external reader release. Only the successfully observed open-Job proof is an
extinction authority for this invocation's contained tree.
