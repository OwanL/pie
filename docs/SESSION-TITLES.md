# Session titles

Pie can generate a compact title for a new session with a low-priority asynchronous LLM request.

## User experience

1. The first user prompt immediately becomes a literal, whitespace-normalized tab snippet, truncated to 40 characters.
2. A small wheel appears in the tab while title generation is armed or running.
3. Generation starts at the first assistant-start commit point, outside the per-session mutation queue. It never delays sending, streaming, or other session operations.
4. A valid generated title replaces the snippet and is persisted as SDK session metadata. Failure or timeout removes the wheel and leaves the snippet in place.

An explicit SDK/manual session name always wins. The worker checks for one both before the model request and immediately before writing, so a rename racing an in-flight request is not overwritten.

## Settings

Settings → Chat → Session titles provides:

- an enable/disable toggle, enabled by default;
- a provider-qualified model picker containing enabled text-capable models;
- a thinking-level selector, defaulting to `off`;
- a 5–60 second timeout selector, defaulting to 15 seconds.

The default is `ollama/deepseek-v4-flash:0731-cloud`. `models.yaml` seeds missing settings, while existing `settings.json.sessionTitles` values remain user-owned. Enabling the feature affects new unnamed sessions only; Pie does not bulk-retitle history.

## Worker contract

The host calls the backend `session.title.generate` RPC. It is classified as low-priority `session-title` provider work. The worker:

- compacts the first prompt to at most 2,000 characters, removing code fences and retaining bounded beginning/end context;
- asks for only 2–6 words and at most 40 characters;
- passes the configured thinking budget (disabled by default) and uses deterministic temperature;
- enforces the configured end-to-end timeout;
- accepts only one short, control-character-free line in the output contract;
- fails open, returning a reason rather than surfacing a user-blocking error.

No generated-title cache is used. Each new unnamed session has one generation attempt, and results are fenced by session path plus correlation ID.

## State ownership

`ArchState.sessions.titleGenerationBySession` owns `armed`, `pending`, and `failed` lifecycle state. Projection publishes only `ViewState.generatingTitleSessionPaths`; the webview does not own title lifecycle. Pending-path replacement rekeys the state to the real JSONL path. Session close/invalidation clears it. Send rollback clears an armed attempt and restores the original summary.
