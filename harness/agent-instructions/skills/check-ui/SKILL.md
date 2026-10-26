---
name: check-ui
description: "Use before implementing meaningful UI changes involving aesthetics, layout, or nuanced interactions, or when before/after screenshots are requested. Skip purely mechanical changes with no presentation impact."
---

## Workflow

1. Use an image-capable reviewer for visual inspection when available. Give it affected views, intended behavior and setup details; request concise findings and artifact paths. If delegation or browser tooling is unavailable, perform feasible checks yourself and state the limitation.
2. Follow the target project's instructions, documentation and established style to run its real app locally. Reuse a suitable running server. Capture affected views **before implementation** and preserve originals. If a baseline is unavailable, say so rather than presenting an after-state as “before”.
3. After implementation, repeat captures and exercise changed interactions, including relevant error states and refresh behavior.
4. **Inspect the images.** Check overflow, clipping, spacing, readability and unintended layout changes. Passing browser assertions do not establish that the UI looks good. Fix supported issues and repeat.
5. Save screenshots and useful replay scripts in a task-specific OS-temp directory outside source trees. Return accessible before/after artifacts, relevant findings and verification limits. Document reusable setup in existing project docs only when useful beyond the task.

## Local setup and mocks

- Prefer existing auth, fixture, and browser-test helpers. Use isolated browser-side mocks if access blocks progress; never add a production auth bypass or embed credentials in shared artifacts.
- Mock only what the scenario needs, keeping the real UI and interactions intact. Use representative synthetic content, including empty and long values. Keep mocked mutation requests from reaching real services.
- Make save/delete mocks stateful so later reads reflect mutations. Do not simulate success by directly changing the DOM or bypassing the interaction under test.
- Record what was mocked and what remains unverified. Mocked UI checks are not evidence of real authentication or backend persistence.

## Browser and comparison quality

- Use the target project's supported browser tool or existing harness. Observe before interacting, prefer accessible role/name selectors, and wait for meaningful readiness rather than arbitrary sleeps. Do not assume a browser tool, test command or launch flag exists.
- Match viewport, fixtures, route, scroll position and expanded state between captures. Record enough setup to repeat them.
- Let fonts, images and layout settle. Avoid loading indicators, stray hover states and animation in comparison shots unless they are the subject.
- Prefer viewport screenshots for layout comparisons. Add focused editor/tooltip shots when useful; avoid huge full-page images that obscure the change. Preserve the baseline when recapturing revisions.
