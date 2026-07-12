# pie — Design Philosophy

## What it is

pie is a VS Code sidebar extension that surfaces a running `pi` agent process as a chat UI. Its closest analogue is GitHub Copilot Chat, but it differs in two key ways:

- **More minimal** — every element earns its place; decoration is removed if it adds no information
- **More transparent** — the user can see exactly what the agent is doing (tool calls, inputs, results) without having to ask

## Core UI goals

### Snappy and fast
- No full-page re-renders on state updates. Each region (tab bar, messages, model picker, composer) updates independently.
- Scroll position is preserved unless the user is already at the bottom.
- Event listeners are bound once at init, not re-bound on every render.

### Minimal cognitive load
- The default view shows only what is needed for the current task. Controls that aren't relevant to the current state are hidden, not just disabled.
- Status is communicated through small, unobtrusive indicators (dot on tab, spinner in message) rather than modal dialogs or banners.
- Banners are reserved for genuine errors, not informational noise.

### Intuitive controls
- **Tooltips** on every icon-only or ambiguous control (`title` attribute minimum; richer tooltips where appropriate).
- **Hover effects** to signal interactivity — all clickable elements must have a visible hover state.
- **Keyboard first** — Enter to send, Shift+Enter for newlines, Tab navigation should work naturally throughout.
- Controls mirror VS Code conventions so the UI feels native, not bolted on.

### Clean visual hierarchy
- Three tiers of visual weight: primary action (Send), secondary controls (model picker, tabs), passive content (messages).
- Typography inherits VS Code's font stack and sizing (`--vscode-font-*`). No custom font sizes except where a clear hierarchy demands it.
- Spacing is consistent and tight — this is a sidebar, not a full window. Padding/margin in multiples of 4px.

### Transparency
- Tool calls are always visible in the message stream, collapsed by default but expandable. Input and result are shown verbatim — no paraphrasing.
- The active model and reasoning level are always visible in the composer footer.
- Session history is accessible without leaving the sidebar.

## What to avoid

- **Animations that delay perception** — transitions are fine for smoothness, never to fill time.
- **Confirmation dialogs for low-risk actions** — prefer undo or soft-delete patterns.
- **Information hidden behind hover** that the user needs to act correctly — hover should reveal detail, not primary affordance.
- **Re-rendering regions that haven't changed** — treat the DOM as a cache.
- **Placeholder copy that tries to be clever** — be literal and direct.

## Relationship to VS Code conventions

The UI lives inside a VS Code sidebar panel and must feel like it belongs there:
- Use `--vscode-*` CSS variables for all colours. Never hardcode colours.
- Use `color-scheme: light dark` so the browser's native controls (select, scrollbar) also theme correctly.
- Match VS Code's interaction patterns: hover states, focus rings, disabled opacity.

## Component map

| Region | Update trigger | Notes |
|---|---|---|
| Banner | `notice` state change | Errors only; hidden when null |
| Tab bar | Session list / active session change | Delegated click listener |
| Messages | Transcript change, busy state | Scroll-pinned to bottom unless user scrolled up |
| Model picker | `modelSettings` / `availableModels` change | In-place `<select>` value update, no DOM rebuild |
| Composer | `busy` / `activeSession` change | Textarea never reset except on explicit send |

## Local run analytics

- Run analytics stay local under `data/outcomes/<workspace-hash>/` inside the repo-aligned outcomes directory and capture structured run factors, tool rollups, verification-command classes, and file-mutation summaries.
- Analytics UI is intentionally hidden for now; the store updates automatically and refreshes a `run-analytics.json` source snapshot alongside the raw JSONL/checkpoint files.
- Optional setting: `pie.experimentAssignment` — records an explicit treatment/experiment label on new runs for later comparison.

## Local GUI development

- Run `npm run watch` inside `extension/` while working on the sidebar UI. It runs both Vite watchers and `tsc --watch`; pass `-- --skip-typecheck` only when a separate typecheck watcher is already running.
- The composer accepts pasted images and file drops when the selected model reports image support.
- Screenshot/image paste is wired at the panel level, so pasting anywhere in the pie chat while it is focused attaches the image to the active composer.
- Changes to files under `src/webview/panel/` are rebuilt by Vite automatically.
- The running sidebar webview reloads itself when built assets change, so UI tweaks no longer need a manual Reload Window cycle.
