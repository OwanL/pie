---
name: computer-use
description: Evidence-led operation of visible Windows applications through the generic computer tool, including observation, interaction, deterministic sequences, recovery, and software dogfooding.
---

# Computer use

Use the generic `computer` tool for every visible-UI operation. Other coding tools may inspect or modify source, but must not substitute for UI evidence. Treat computer use as a live, stateful session, not as a collection of application recipes. Prefer short observe–act–observe loops and keep durable evidence in session artifacts.

## Open and observe

1. Discover the desktop, foreground window, process, title, or another generic target.
2. `open` or reuse the target and note its session/target identifiers, geometry, capabilities, and artifact root. When first-frame grounding is needed, request `screenshot`/`tree`/`state` on `open` so registration and the initial observation happen in one call.
3. `observe` before every new interaction. Record the observation revision, screenshot geometry, focus/foreground state, cursor position, and held keys/buttons.
4. Target screenshot coordinates are in the returned model/display frame — the image part you receive and its `display_size` (long edge capped at 1600). The full-resolution `full_png` (with `full_png_size`) is durable evidence only; never scale coordinates against or read them from the full PNG dimensions.
5. A window screenshot is a foreground visible-region capture, not an HWND-owned pixel surface. It supports only windows entirely on NutJS's main display, and composited overlays or other content drawn over the region can appear in the image.
6. Use semantic refs only when the current accessibility evidence is clear and relevant. Otherwise use target-relative screenshot pixels in the display frame. Do not infer that a missing or ambiguous semantic tree is safe to act on.
7. Screenshot coordinates are valid only for the latest observation revision and matching geometry. Re-observe immediately before coordinate actions; never carry coordinates across a changed revision, resize, move, focus change, or target switch.

## Act and verify

- Use the smallest action that tests the next hypothesis. Exact-window input automatically attempts bounded PID/HWND-validated foreground recovery when another app stole focus; explicit `focus` remains useful before observation.
- A semantic ref must belong to the target's latest revision. If a ref or target is stale, stop and observe again rather than retrying the same action.
- After each meaningful action, obtain a fresh observation and verify a visible or fixture-reported postcondition. Check the cursor and held-input state as part of the observation when relevant.
- Never claim success from an accepted action, a backend response, or an unchanged screenshot alone. Success requires a visible or fixture postcondition.
- When an action is unsupported or ambiguous, report that fact and return to discovery; do not invent an application-specific fallback.
- Prefer stable semantic labels, roles, and visible menu actions over positional control indexes or incidental node/control names. Treat positions as observation-scoped evidence, never durable test identifiers.

## Recovery

When a target disappears, loses focus, changes geometry, or reports a stale target/ref:

1. stop dispatching actions;
2. observe the desktop and rediscover the generic target;
3. reopen or rebind the target if necessary;
4. take a new observation and use only its refs/coordinates; and
5. verify the next postcondition freshly.

If the native sidecar hangs or restarts, assume targets, revisions, cursor state, and held state are invalid. Wait for the runtime to recover, reopen/rediscover, observe again, and resume from a known checkpoint. Reuse saved artifacts and sequences rather than reconstructing them from memory. On cancellation, error, interruption, or close, invoke `release_all` and confirm that no keys or buttons remain held.

## Desktop target exception

A desktop session intentionally operates the current global desktop and foreground. Its actions are not bound to a target PID/HWND. Every physical desktop action therefore requires the latest observation revision and is refused if the active HWND changed since that observation. Preserve this mode for workflows that genuinely require desktop-wide interaction, but prefer an exact window session for safe application work. Observe immediately before each desktop action and verify the current foreground afterward.

When an action opens a native file picker, permission prompt, or other modal window, treat it as a target transition: discover/open the new exact foreground window, observe it, interact through that session, then rediscover the parent after the dialog closes. Never continue keyboard input through the old parent target.

## Browser and ordinary visible applications

Operate an ordinary browser profile through its visible UI. Open/reuse the visible window, inspect what is actually shown, and use normal navigation, typing, clicking, scrolling, and visible form interaction. Do not replace the profile or assume hidden DOM state is equivalent to what the user can see. The same evidence loop applies to browsers, editors, games, and native applications.

## Deterministic sequences

Use `run_sequence` for timing-sensitive work rather than approximating timing with repeated model calls. Author serializable, application-neutral sequences with explicit monotonic offsets and reusable artifact files.

- Put key/button down and up events, waits, paths, and simultaneous/held inputs explicitly in the sequence.
- Save the sequence, inputs, and bounded trace as artifacts; give them stable names and reuse them for repeatable runs.
- Observe before starting and request a trailing `screenshot`/`tree`/`state` on `run_sequence` when one end-state observation is sufficient; use explicit checkpoints for longer sequences.
- On cancellation or failure, release all inputs; do not assume a sequence completed because its process returned.

## Long sessions: journal and evidence loop

For work lasting more than a few turns, maintain a concise journal beside the session artifacts. For each issue or workflow, record:

- target/session and observation revision;
- intended action and evidence used to choose semantic refs or pixels;
- artifact paths, sequence names, and checkpoint/postcondition;
- result, uncertainty, and the next recovery/resume step.

Keep observations bounded in the transcript while preserving full screenshots, sequences, traces, and relevant evidence as artifacts. Periodically re-observe the active target, confirm focus/cursor/held state, and write a checkpoint. After restart or context loss, read the journal and artifact manifest, then continue from the first incomplete checkpoint.

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
