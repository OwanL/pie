# Computer use

Pie exposes one generic `computer` tool and a supporting `computer-use` skill for visible Windows applications. The implementation is application-neutral: there are no browser, Godot, VS Code, or site-specific branches.

## Selected implementation

Pinned dependencies live in `extensions/computer-use/package.json` and its lockfile:

- `@trycua/cua-driver@0.12.5` — discovery, accessibility observations, desktop capture, launch, primary focus, and lifecycle;
- `@computer-use/nut-js@4.2.0` — foreground visible-region capture, generic focus fallback, and all physical keyboard/pointer delivery; a bounded built-in Win32 PID/HWND-validated fallback handles Windows foreground-lock cases left unresolved by both libraries;
- `pngjs@7.0.0` — bounded model/display PNG generation.

Cua + NutJS was selected over Terminator `0.24.32` + NutJS. Both finalists passed all executable candidate-matrix rows, but Cua observations were about 2–21× faster depending on the surface, exposed richer browser/Electron trees, and shipped declared license metadata.

## Architecture and ownership

`extensions/computer-use/index.ts` registers one sequential tool with five actions:

- `open` — discover or launch an exact target; accepts optional `screenshot`/`tree`/`state` to perform the initial observation inline, exactly like `observe`;
- `observe` — return pixels, optional accessibility data, target/revision state, and artifacts;
- `act` — execute one generic input/focus/release action;
- `run_sequence` — execute a serializable monotonic input sequence; accepts optional `screenshot`/`tree`/`state` for a trailing verification observation;
- `close` — release input and close runtime state, optionally the exact application.

Each durable pie session owns a lazy Node sidecar keyed by canonical session path. Native packages load only in that child. Parent and child communicate through bounded 1 MiB JSONL records; screenshots remain files and never cross the sidecar protocol as base64. The parent owns timeout, restart, cancellation, and emergency-release recovery.

Target safety is fail-closed:

- every window target requires a positive PID and HWND;
- partial selectors reject ambiguity;
- launched windows must remain a stable unique PID/HWND match;
- launch path inputs are normalized: bare executable names resolve via PATH and `.lnk` shortcuts resolve to their target, but only a deterministically resolved native `.exe` is launched; shell wrappers, scripts, and unresolvable links are rejected with `LAUNCH_UNRESOLVED` rather than unsafe shell correlation;
- every non-release physical input to a window revalidates the exact target, active foreground HWND, and unique NutJS HWND region immediately before delivery; if another app stole foreground between model turns, the backend safely reacquires the exact PID/HWND before delivery; a move or resize beyond the deterministic one-pixel tolerance fails with retryable `STALE_GEOMETRY` before input;
- a vanished exact HWND rebinds only to one unique replacement window with the same PID and process identity, bumping the target generation so old semantic refs are stale and forcing a fresh observation for screenshot-relative coordinates; zero or multiple replacements stay fail-closed `STALE_TARGET`;
- desktop actions are an intentional exception to target ownership, but desktop observation binds the same active HWND before and after capture, every physical action requires that latest revision, and input is refused with `DESKTOP_FOREGROUND_CHANGED` if the active HWND changed;
- focus uses Cua first, immediately follows with a bounded Win32 thread-input fallback that validates the HWND's PID before activation and final foreground proof, then uses exact-HWND NutJS restore/focus as the last fallback;
- stale, background, ambiguous, or vanished targets receive explicit retryable errors;
- application close revalidates the exact PID/HWND;
- key/button release is always allowed, attempts every owned input, and retains failures in parent/child ledgers for bounded retry.

Cua telemetry and update checks are disabled before native import with `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` and `CUA_DRIVER_RS_UPDATE_CHECK=false`.

## Observation and coordinate contract

Cua supplies bounded accessibility state (maximum 250 elements and 32 KiB). Semantic refs contain a restart-unique epoch, target generation, observation revision, and ordinal; old refs cannot become valid after reopen or sidecar restart.

NutJS owns all window screenshots, including when UIA is unavailable. This avoids Cua's Windows high-DPI custom-surface crop, where a successful or timed-out Godot capture could contain only the physical top-left portion of the window. These are foreground visible-region captures, not HWND-owned pixel surfaces. Before capture the backend proves the exact PID/HWND foreground, rediscovers one unique exact NutJS region, and requires the entire region to lie on NutJS's main display. Immediately after capture it re-proves foreground and unchanged geometry; a raced image is deleted. Because capture reads the composited visible screen region, overlays or other content drawn above the target can appear. Other displays are not supported for window capture.

`screenshot:false` observations can still return accessibility or degradation metadata for a background target. If accessibility is unavailable, degradation reports `fallback:"none"` and explicitly says that no image was captured.

The model receives a display PNG with long edge at most 1600 pixels. Public target-relative coordinates and `target.geometry.screenshot` are in that exact display frame. The full PNG and its dimensions are durable evidence only. Conversion is per-axis:

```text
desktop = logicalWindowOrigin + displayCoordinate * logicalWindowSize / displayFrameSize
```

Desktop-absolute coordinates require explicit `scope:"desktop"`. Target-relative coordinates use exclusive upper bounds: `x >= width` or `y >= height` is rejected. Pixel actions require the latest observation revision. Accessibility refs resolve to their exact observed element centers and are also revision scoped.

The `computer` tool no longer registers its own context projection. A source-specific newest-three `computer` screenshot bound is now applied as the first pass of the generic `image-context-guard` extension, which then applies the active model's per-request image maximum (`maxImagesPerRequest`) to the resulting complete context and emits one aggregate omission notice. The newest-three rule preserves all text and artifact paths, all non-computer images, and the durable session/transcript; it is a sub-bound beneath the per-model total, not a standalone handler. See `extensions/image-context-guard/README.md`. This prevents providers with bounded image request limits from failing during long observe/act loops while keeping one deterministic owner for both passes. When a screenshot artifact exists but the active model is text-only, the tool returns an explicit `image_delivery: unavailable` notice with the artifact path and image-capable delegation guidance instead of silently omitting the pixels.

## Deterministic sequences

Sequence artifacts use:

```json
{"version":1,"actions":[{"atMs":0,"action":{"kind":"key_down","key":"d"}}]}
```

Offsets are non-decreasing integers, scheduled against `performance.now()`, with limits of 10,000 actions and ten minutes. Split key/button down/up supports simultaneous holds. Completion releases newly held input unless `preserveHeld:true`; cancellation, timeout, failure, close, and shutdown enter the release/recovery path. Sequence and bounded trace JSON are saved beside screenshot artifacts.

## Transcript rendering

The ordinary tool-card renderer supports ordered mixed text/image content. Image data renders as `<img>` content instead of YAML/base64 text, and mixed arrays survive durable transcript reload. This is generic webview behavior, not a computer-specific component.

## Evidence summary

Evaluation run `cu-20260725-01` used dependency-managed disposable candidates and reusable DOM, canvas, Godot, and event-ledger fixtures.

- Both Cua + NutJS and Terminator + NutJS passed 27/27 resettable trials plus 2/2 one-off ordinary-profile/restart checks, with zero official silent no-ops.
- Cua + NutJS passed browser DOM/canvas, 175% DPI coordinates, VS Code navigation, Notepad, Settings, Godot editor manipulation, Godot runtime held/simultaneous input, multi-window rediscovery, cancellation release, and sidecar restart.
- Mixed-DPI multi-monitor transfer remains hardware-blocked because the evaluation machine had one attached monitor.
- Public-tool browser dogfood completed ordinary-profile DOM form interaction and canvas click/drag/scroll plus simultaneous W+D. The independent fixture ledger recorded 40 trusted events and a final empty held-key state.
- Public-tool Godot dogfood exposed and drove fixes for provider image-count exhaustion, unsafe launch correlation, foreground validation, UIA timeout degradation, Cua high-DPI crop, and display/full-image coordinate mismatch. Candidate-level Godot editor/runtime acceptance passed 3/3 each. A final model-orchestrated public-tool Godot workflow did not complete end to end on this desktop: focus/grounding retries and one model timeout stopped before runtime verification. The tool failed closed and cleanup targeted only exact evaluation-owned PIDs/HWNDs.
- One early dogfood cleanup incident accepted an incomplete launch record and allowed global input to land on foreground VS Code/pie. The implementation now rejects missing/ambiguous identities, validates foreground before every dispatch, revalidates close, and has deterministic regression coverage for this path.

Focused deterministic coverage: 99 passing computer-use tests with one opt-in live test skipped, plus generic renderer, shared result-format, package-runner, and fixture no-op discrimination tests. The extension build and root typecheck passed on 2026-07-25. A disposable detached source snapshot completed root `npm ci`, normal dependency installation, and resolved both pinned native packages. The full `npm run bootstrap` command was not run because it globally updates pi/extensions and could interrupt the controlling session.

## Install and verification

Root bootstrap installs the independently locked package:

```bash
npm run bootstrap
npm run computer-use:typecheck
npm run computer-use:test
npm run extension:build
```

Live desktop tests are excluded from the deterministic suite and require both `PIE_RUN_INTEGRATION_TESTS=1` and `PIE_COMPUTER_USE_LIVE=1`.

## Known limitations

- Windows ordinary, non-elevated desktop only; protected/elevated desktops are unsupported.
- Window screenshots require exact foreground visibility and a region entirely on NutJS's main display. They capture the composited visible region, so overlays or other content drawn over the target can appear; pixels are not guaranteed to be HWND-owned.
- Desktop sessions intentionally act on the current global desktop rather than a target HWND. They require a fresh revision and stable observed foreground for every physical action; prefer exact window sessions for safe application work.
- Godot/custom surfaces may expose no useful UIA tree; pixel grounding remains available when a screenshot was requested.
- Mixed-DPI movement between multiple monitors is not yet hardware-verified; window capture outside the main display is unsupported.
- Visible applications can reject or delay physical input while the workstation is locked.
- Models still need competent visual grounding; backend success is never a substitute for a fresh visible postcondition.
