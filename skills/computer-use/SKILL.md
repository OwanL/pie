---
name: computer-use
description: Evidence-led operation of visible Windows applications through the generic computer tool, including observation, interaction, deterministic sequences, recovery, and software dogfooding.
---

# Computer use

Use the generic `computer` tool for every visible-UI operation. Other coding tools may inspect or modify source, but must not substitute for UI evidence. Treat computer use as a live, stateful session, not as a collection of application recipes. Prefer short observe–act–observe loops and keep durable evidence in session artifacts.

## Open and observe

Every computer call requires an active persistent Pi session with a session JSONL path.
The tool obtains this path from the session manager and rejects an ephemeral or
pathless session (`SESSION_PATH_REQUIRED`); it is not a public computer parameter.
The runtime sidecar is owned by the canonical session path, and generated artifacts
are stored under that session's internal artifact directory.

1. Discover the desktop, foreground window, process, title, or another generic target.
2. `open` or reuse the target and note its session/target identifiers, geometry, and capabilities. When first-frame grounding is needed, request `screenshot`/`tree`/`state` on `open` so registration and the initial observation happen in one call; an inline observation returns any produced artifact paths.
3. `observe` before every new interaction. Record the observation revision, screenshot geometry, focus/foreground state, cursor position, and held keys/buttons.
4. Target screenshot coordinates are in the returned model/display frame — the image part you receive and its `display_size` (long edge capped at 1600). The full-resolution `full_png` (with `full_png_size`) is durable evidence only; never scale coordinates against or read them from the full PNG dimensions. If the result says `image_delivery: unavailable`, the active model did not receive the pixels: do not infer their contents or begin pixel work from the artifact path. Use textual/accessibility evidence, switch models, or delegate with `modelRequirements.inputKinds=["image"]` first.
5. A window screenshot is a foreground visible-region capture, not an HWND-owned pixel surface. It supports only windows entirely on NutJS's main display, and composited overlays or other content drawn over the region can appear in the image.
6. Use semantic refs only when the current accessibility evidence is clear and relevant. Otherwise use target-relative screenshot pixels in the display frame. Do not infer that a missing or ambiguous semantic tree is safe to act on.
7. Screenshot coordinates are valid only for the latest observation revision and matching geometry. Re-observe immediately before coordinate actions; never carry coordinates across a changed revision, resize, move, focus change, or target switch.

## Act and verify

- Use the smallest action that tests the next hypothesis. Exact-window input automatically attempts bounded PID/HWND-validated foreground recovery when another app stole focus; explicit `focus` remains useful before observation.
- A semantic ref must belong to the target's latest revision. If a ref or target is stale, stop and observe again rather than retrying the same action.
- Explicit release is a nested `act` input, not a top-level computer action: `{ "action": "act", "sessionId": "<session>", "targetId": "<target>", "input": { "kind": "release_all" } }`. The `targetId` may be omitted only when the active target is unambiguous; `release_all` itself does not require a revision. Confirm that no keys or buttons remain held.
- After each meaningful action, obtain a fresh observation and verify a visible or fixture-reported postcondition. Check the cursor and held-input state as part of the observation when relevant.
- Never claim success from an accepted action, a backend response, or an unchanged screenshot alone. Success requires a visible or fixture postcondition.
- When an action is unsupported or ambiguous, report that fact and return to discovery; do not invent an application-specific fallback.
- Prefer stable semantic labels, roles, and visible menu actions over positional control indexes or incidental node/control names. Treat positions as observation-scoped evidence, never durable test identifiers.

## Recovery

For an exact window, losing foreground to another app is not by itself a stale-target
condition for foreground-requiring input: delivery revalidates the exact PID/HWND,
attempts bounded automatic reacquisition, and proves foreground before input. Do not switch to a desktop
session or reopen solely because focus was stolen. Observe afterward and verify the
postcondition freshly.

When the exact-window reacquisition fails, a target/ref is stale, geometry changes, or
the target disappears:

1. stop dispatching actions;
2. observe and rediscover the target;
3. reopen or rebind it if necessary;
4. take a new observation and use only its refs/coordinates; and
5. verify the next postcondition freshly.

If the native sidecar hangs or restarts, assume targets, revisions, cursor state, and
held state are invalid. Wait for recovery, reopen/rediscover, observe again, and
resume from a user-defined step or source sequence. Reuse saved artifact paths and
source sequences rather than reconstructing them from memory. On cancellation, error,
interruption, or close, ensure cleanup has completed; the runtime attempts it
automatically, and the explicit retry is the nested `act`/`release_all` form above.

## Desktop target exception

A desktop session intentionally operates the current global desktop and foreground. Its
actions are not bound to a target PID/HWND. Actions that require desktop foreground
binding require the latest observation revision and are refused if the active HWND
changed since that observation. The binding exceptions are `wait`, `focus`,
`release_all`, `key_up`, and `mouse_up`; these do not require a revision. Target-relative
screenshot coordinates still require a revision. Preserve desktop scope for workflows
that genuinely require desktop-wide interaction, but prefer an exact window session
for safe application work. Observe immediately before each bound desktop action and
verify the current foreground afterward.

When an action opens a native file picker, permission prompt, or other modal window, treat it as a target transition: discover/open the new exact foreground window, observe it, interact through that session, then rediscover the parent after the dialog closes. Never continue keyboard input through the old parent target.

## Browser and ordinary visible applications

Operate an ordinary browser profile through its visible UI. Open/reuse the visible window, inspect what is actually shown, and use normal navigation, typing, clicking, scrolling, and visible form interaction. Do not replace the profile or assume hidden DOM state is equivalent to what the user can see. The same evidence loop applies to browsers, editors, games, and native applications.

## Deterministic sequences

Use `run_sequence` for timing-sensitive work rather than approximating timing with repeated model calls. Author serializable, application-neutral sequences with explicit monotonic offsets and reusable artifact files.

- Put key/button down and up events, waits, paths, and simultaneous/held inputs explicitly in the sequence.
- Keep the input source distinct from run evidence: an input `sequencePath` is a caller-supplied sequence file (normally user-authored), while the returned `sequencePath` copy and `tracePath` are generated per-run evidence with timestamp/UUID names. Do not treat those generated paths as stable source identifiers.
- Observe before starting and request a trailing `screenshot`/`tree`/`state` on `run_sequence` when one end-state observation is sufficient. For long workflows, split the sequence into shorter runs and observe between them.
- On cancellation or failure, release all inputs; do not assume a sequence completed because its process returned.

## Long sessions: journal and evidence loop

For work lasting more than a few turns, maintain a concise journal beside the session artifacts. For each issue or workflow, record:

- target/session and observation revision;
- intended action and evidence used to choose semantic refs or pixels;
- source sequence and generated artifact paths, when applicable;
- result, uncertainty, and the next recovery/resume step.

Keep observations bounded in the transcript while preserving full screenshots, sequences,
traces, and relevant evidence as artifacts. Periodically re-observe the active target
and confirm focus/cursor/held state. After restart or context loss, read the journal,
reopen/rediscover, observe freshly, and continue from the first incomplete user-defined
step. Split long sequences and observe between chunks rather than relying on one long
run.

## Evaluate and modify software

Use this general loop:

1. evaluate the current software visibly and record a concrete issue with screenshot/fixture evidence;
2. inspect the relevant source and make the smallest justified modification;
3. build using the repository's documented command and wait for its real result;
4. if reloading the controlling VS Code instance would interrupt the computer session, launch a separate Extension Development Host only for that evaluation loop;
5. reopen or rediscover the resulting UI, observe freshly, and compare the stated postcondition with the captured baseline; and
6. record the result and any remaining issue in the journal.

For rendered integration probes, start with the smallest focused scenario and one representative viewport/configuration. Make each variant report its own postcondition and fail near the responsible step; run the full replay/matrix only after the focused probe passes. Keep selectors tied to user-visible semantics so unrelated node removal or control insertion does not break the probe.

Do not stop at a successful build: visual or fixture verification is required. Do not claim an improvement, completed workflow, or working software without a visible or fixture-reported postcondition.
