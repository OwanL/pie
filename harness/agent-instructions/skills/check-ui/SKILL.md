---
name: check-ui
description: "Use before implementing meaningful UI changes involving aesthetics, layout, or nuanced interactions, or when before/after screenshots are requested. Skip purely mechanical changes with no presentation impact."
---

## Workflow

1. Delegate browser work and visual inspection to an image-capable subagent (`modelRequirements: { inputKinds: ["image"] }`). Give it the affected views, intended behavior, and relevant setup instructions; ask for artifact paths and concise findings, not browser chatter. Prefer a small bucket subagent.
2. Follow the target repository's instructions to run the real app locally. Reuse a suitable running server. Capture the affected views **before implementation**, and preserve those originals. If a baseline is unavailable, say so rather than presenting an after-state as “before”.
3. After implementation, repeat the captures and exercise the changed interactions, including error states or cache refresh where relevant.
4. **Inspect the images.** Check overflow, clipping, spacing, readability, and unintended layout changes. Passing browser assertions do not establish that the UI looks good. Fix supported issues and repeat.
5. Save screenshots and useful replay scripts in a task-specific directory under OS temp, outside source trees. Return absolute before/after links, relevant findings, and verification limits. Note non-obvious reusable setup in the project's existing documentation.

## Local setup and mocks

- Prefer existing auth, fixture, and browser-test helpers. Use isolated browser-side mocks if access blocks progress; never add a production auth bypass or embed credentials in shared artifacts.
- Mock only what the scenario needs, keeping the real UI and interactions intact. Use representative synthetic content, including empty and long values. Keep mocked mutation requests from reaching real services.
- Make save/delete mocks stateful so later reads reflect mutations. Do not simulate success by directly changing the DOM or bypassing the interaction under test.
- Record what was mocked and what remains unverified. Mocked UI checks are not evidence of real authentication or backend persistence.

## Playwright and comparison quality

- Use the available Playwright tool or the project's existing harness. Observe before interacting, prefer accessible role/name selectors, and wait for meaningful UI readiness rather than arbitrary sleeps.
- Match viewport, fixtures, route, scroll position, and expanded state between captures. Record enough setup to repeat them.
- Let fonts, images, and layout settle. Avoid loading indicators, stray hover states, and animation in comparison shots unless they are the subject.
- Prefer viewport screenshots for layout comparisons. Add focused editor/tooltip shots when useful; avoid huge full-page images that obscure the change. Preserve the baseline when recapturing revisions.
