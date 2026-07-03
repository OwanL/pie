# pie LLM proxy

A local [LiteLLM Proxy](https://docs.litellm.ai/docs/proxy/quick_start) that sits in front of the
**API-key providers** used by pie (umans today; future providers as one-line upstreams). It enforces
per-provider concurrency limits so a subagent fan-out can't burst the upstream account — the missing
throughput governor for the umans "4 concurrent active sessions" limit.

> **What routes through the proxy:** umans (and any future API-key provider).
> **What stays direct:** GitHub Copilot (pi-ai's OAuth device-flow + editor-header auth is not
> reproduced through LiteLLM — see `docs/AGENT-HARNESS-IMPROVEMENTS.md` §2) and Ollama (localhost).

## Prerequisites

- [`uv`](https://docs.astral.sh/uv/) ≥ 0.5 (already required by this repo). `uv` isolates the proxy
  in a project-local `.venv` — no system Python, no global install.

## Run

### From the pie root (recommended)

```powershell
npm run proxy           # start in foreground
npm run proxy:bg        # start in background (logs to data/proxy/proxy.log)
npm run proxy:down      # stop the background instance
npm run proxy:health    # health-check (exit 0 = up)
```

### Directly

```powershell
cd proxy
uv run litellm --config litellm_config.yaml --port 4000
```

On first run `uv` creates `proxy/.venv` with `litellm[proxy]` pinned in `pyproject.toml`.
Subsequent starts are instant.

## How the extension uses it

On activation the pie extension host **spawns the proxy** as a child process (mirroring how it
spawns the PI backend in `extension/src/host/session-service/startup.ts`) and waits for a
`/health/liveness` 200 before starting the backend. If the proxy fails to boot, the extension
**fails loud** — a notice is shown and umans will be unavailable until it's fixed (no silent
fallback to direct umans, by design).

`models.json` points the umans provider at the proxy:

```json
"umans": {
  "baseUrl": "http://localhost:4000/v1",
  "api": "openai-completions",
  "apiKey": "$UMANS_API_KEY",
  ...
}
```

The `apiKey` is `$UMANS_API_KEY` (NOT a separate `$LITELLM_MASTER_KEY` env
var) because LiteLLM is DB-less: its `master_key` in `litellm_config.yaml` is
set to the SAME `os.environ/UMANS_API_KEY`, so the Authorization the backend
sends must equal that key. The localhost-only binding (`--host 127.0.0.1`) is
the real gate; the key just has to agree.

## Using `pi` from PowerShell (no extension host)

The extension is not running when you use `pi` in a terminal, so it can't auto-spawn the proxy.
Start it first:

```powershell
npm run proxy:bg     # once per shell session (or machine boot)
pi --provider umans --model umans-glm-5.2 "hello"
```

## Configuring limits and providers

Edit [`litellm_config.yaml`](litellm_config.yaml):

- `umans` upstream has `max_parallel_requests: 4` — the real umans account limit (4 concurrent
  active sessions). Raise only if your tier changes. The setting lives in each entry's
  `litellm_params` (NOT `router_settings`), and every umans variant shares `model_info.id:
  umans-shared` so LiteLLM creates ONE 4-slot queue across all variants (umans' limit is
  account-wide, not per-model). See `litellm_config.yaml` for details.
- To add a future API-key provider: add a `model_list` entry with its own `litellm_params`
  (api key from env, real base URL, `max_parallel_requests`) and a DISTINCT `model_info.id`,
  then add a matching `baseUrl` redirect block in `models.json`.

## The master key

`master_key` in `litellm_config.yaml` is a **localhost-only gate** — it stops arbitrary
local processes from using the proxy. It is *not* a cloud secret. It is set to
`os.environ/UMANS_API_KEY` (the SAME key pie/pi already use) because LiteLLM is
DB-less: a request's Authorization must match `master_key` or LiteLLM falls
through to a virtual-key DB lookup and 400s with "No connected db". So the
backend sends `$UMANS_API_KEY` and the proxy's `master_key` is that same value.
This is still a localhost-only gate (the proxy binds to `127.0.0.1` via
`--host`); it is NOT a cloud-secret reuse. (The real cloud secrets stay in the
OS environment / pie's secure auth storage and are read by LiteLLM from
`os.environ`.)

## Files

| File | Purpose |
|---|---|
| `litellm_config.yaml` | Upstream provider declarations + concurrency limits + master key |
| `pyproject.toml` | uv project: pins `litellm[proxy]` version |
| `.python-version` | Python version for `uv run` (3.13) |
| `.env.example` | Documents env vars LiteLLM reads (UMANS_API_KEY etc.) — `.env` is gitignored |
| `README.md` | This file |

## Troubleshooting

- **`uv: command not found`** — see repo root README; `uv` is a repo prerequisite.
- **`port 4000 already in use`** — `npm run proxy:down` then retry, or change `--port` in both
  this README's commands and `litellm_config.yaml` (`server.port`).
- **Extension shows "proxy failed to start"** — run `npm run proxy` in a terminal and read the
  stderr; the most common cause is a stale `.venv` after a `litellm` version bump (`rm -r
  proxy/.venv` and retry).
