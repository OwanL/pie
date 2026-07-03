# Pie repo specific conventions

Personal pi config stack: VS Code extension GUI ("pie"), custom pi extensions, agents, skills, and centralized settings.

- `extension/` — VS Code extension
- `extensions/` — Custom pi tools ie `subagent`
- `docs/` — Internal design docs; `STATE_CONTRACT.md` is authoritative for host↔webview sync
- `models.yaml` — single source of truth for model config (providers, pricing, eligibility, litellm routing, defaults). Run `npm run sync-models` after editing it; that regenerates `models.json`, `model-profiles.yaml`, `proxy/litellm_config.yaml`, and merges model fields into `settings.json`. Do not edit those derived files directly — `extension/test/model-config-sync.test.ts` fails on drift.

**Always rebuild after editing `extension/src/`** — build auto-syncs output to the installed VS Code extension.

```bash
cd extension
npm run build      # build + sync
npm run watch      # incremental
npm run test       # unit tests
npm run typecheck  # type-check only
npm run package    # produce .vsix
```
