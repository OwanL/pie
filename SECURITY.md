# Security and local state

## Credentials

Never commit, copy, or cloud-sync `auth.json`, `.env` files, API keys, or OAuth tokens. Each machine must authenticate independently. The installers move credentials to an OS-local directory and set `PI_CODING_AGENT_AUTH_DIR`:

- Windows: `%LOCALAPPDATA%\pie\auth.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/pie/auth.json`
- macOS: `~/Library/Application Support/pie/auth.json`

`PI_CODING_AGENT_AUTH_DIR` must point outside the Git checkout. If `auth.json` reappears at the repository root, stop using pie and re-run the installer; it will merge the newer credentials into the secure location and remove the split-brain copy. Rotate any credential that was committed, uploaded, or copied to an untrusted location.

## Sessions and analytics

`data/` and legacy `sessions/` are machine-local and git-ignored. Session JSONL, logs, and analytics may contain prompts, source code, absolute paths, tool output, and secrets. Do not sync them between active machines. Back them up only to encrypted storage, and never allow two machines to write to the same session directory.

The supported policy is one local store per checkout at `data/outcomes/sessions/`. `PI_CODING_AGENT_SESSION_DIR` should resolve to that directory on the current machine.

## Dependencies and packages

Pi packages and extensions execute with the user's full permissions. Review third-party source before installation. Tracked dependencies are restored from lockfiles with `npm ci`; updates should arrive through reviewed Dependabot changes. The standalone `pi` CLI is pinned to the exact SDK version in `extension/package-lock.json`.

## Pre-share check

Run:

```bash
npm run doctor

git status --short --ignored
```

Confirm that no credential or runtime-data file is staged or included in an archive. Clone the Git repository on another machine rather than copying a populated working directory.
