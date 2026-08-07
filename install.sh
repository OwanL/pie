#!/usr/bin/env bash
# Bootstrap the pie portable coding-agent configuration on macOS / Linux.
#
# Mirrors install.bat (Windows) / the shared Node core: pins the toolchain and CLI, relocates credentials,
# keeps sessions in a machine-local checkout store, restores packages, writes
# VS Code settings, and builds/installs the extension when the code CLI exists.
#
# Run once after cloning:
#   chmod +x install.sh
#   ./install.sh

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# When launched via double-click on macOS/Linux, a terminating error under
# `set -e` kills the script and the terminal closes before the message is
# readable. Trap ERR to print the failed line, and trap EXIT to pause (only when
# stdin is a TTY, so non-interactive / piped / CI runs are unaffected).
_on_install_err() {
  local _rc=$?
  echo "" >&2
  echo "==> INSTALL FAILED (line ${BASH_LINENO[0]}): command exited $_rc" >&2
  INSTALL_FAILED=1
}
_on_install_exit() {
  local _rc=$?
  if [[ "${INSTALL_FAILED:-0}" == "1" && -t 0 ]]; then
    echo "" >&2
    read -r -p "Press Enter to close..." _ </dev/tty
  fi
}
trap _on_install_err ERR
trap _on_install_exit EXIT
INSTALL_FAILED=0

echo "==> Setting PI_CODING_AGENT_DIR=$repo_root"
export PI_CODING_AGENT_DIR="$repo_root"

# Persist the env var in the user's shell rc.
persist_env_var() {
  local rc="$1"
  local line="export PI_CODING_AGENT_DIR=\"$repo_root\""
  if [[ -f "$rc" ]] && grep -Fq "PI_CODING_AGENT_DIR=" "$rc"; then
    echo "==> $rc already exports PI_CODING_AGENT_DIR; not modifying"
    return
  fi
  printf '\n# Added by pi-config install.sh\n%s\n' "$line" >> "$rc"
  echo "==> Appended PI_CODING_AGENT_DIR export to $rc"
}

case "${SHELL##*/}" in
  zsh)  persist_env_var "$HOME/.zshrc" ;;
  bash) persist_env_var "$HOME/.bashrc" ;;
  *)    echo "==> Unknown shell ($SHELL); set PI_CODING_AGENT_DIR=$repo_root manually" ;;
esac

# Migrate auth.json from the old default location if missing.
old_auth="$HOME/.pi/agent/auth.json"
new_auth="$repo_root/auth.json"
if [[ -f "$old_auth" && ! -f "$new_auth" ]]; then
  echo "==> Migrating auth.json from $old_auth"
  cp "$old_auth" "$new_auth"
  chmod 600 "$new_auth"
elif [[ -f "$new_auth" ]]; then
  echo "==> auth.json already present in repo — skipping migration"
  # Defence in depth: ensure restrictive perms even if pre-existing.
  chmod 600 "$new_auth" 2>/dev/null || true
else
  echo "==> No existing auth.json found — authenticate pi on first run"
fi

# Tooling checks.
require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is required but not found on PATH. $2" >&2
    exit 1
  fi
}

require_cmd node "Install the exact version in .node-version from https://nodejs.org/"
require_cmd npm  "npm ships with Node.js"

# Pinned Node/npm/pi versions come from one shared source
# (scripts/install/run.mjs pinned-versions -> scripts/toolchain.mjs) so the two
# shell installers never drift on how they parse .node-version / package.json /
# the extension lockfile. The comparison + install stays here (thin wrapper).
if ! _pinned_output="$(node "$repo_root/scripts/install/run.mjs" pinned-versions)"; then
  echo "ERROR: Could not resolve pinned toolchain versions (node/npm/pi)." >&2
  exit 1
fi
pinned_node="$(printf '%s\n' "$_pinned_output" | sed -n 1p)"
pinned_npm="$(printf '%s\n' "$_pinned_output" | sed -n 2p)"
pinned_pi="$(printf '%s\n' "$_pinned_output" | sed -n 3p)"
actual_node="$(node -p 'process.versions.node')"
if [[ "$actual_node" != "$pinned_node" ]]; then
  echo "ERROR: Node.js $pinned_node required for reproducible installs, found $actual_node. Use .nvmrc/.node-version." >&2
  exit 1
fi
actual_npm="$(npm --version)"
if [[ "$actual_npm" != "$pinned_npm" ]]; then
  echo "==> Installing pinned npm@$pinned_npm (found $actual_npm)"
  npm install -g "npm@$pinned_npm"
fi

# Keep all session outcomes global to this checkout, independent of cwd. If an
# older environment points elsewhere, merge its reviews, completed run snapshots,
# closure events, and transcripts before switching the authority.
previous_session_dir="${PI_CODING_AGENT_SESSION_DIR:-}"
session_dir="$repo_root/data/outcomes/sessions"
if [[ -n "$previous_session_dir" ]]; then
  node "$repo_root/scripts/migrate-outcomes-store.mjs" \
    --source-session-dir "$previous_session_dir" \
    --dest "$repo_root/data/outcomes"
fi
export PI_CODING_AGENT_SESSION_DIR="$session_dir"
persist_session_env_var() {
  local rc="$1"
  local line="export PI_CODING_AGENT_SESSION_DIR=\"$session_dir\""
  if [[ -f "$rc" ]] && grep -Fq "PI_CODING_AGENT_SESSION_DIR=" "$rc"; then
    node -e '
      const fs = require("fs");
      const [file, replacement] = process.argv.slice(1);
      const source = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, source.replace(/^export PI_CODING_AGENT_SESSION_DIR=.*$/m, replacement));
    ' "$rc" "$line"
    echo "==> Updated PI_CODING_AGENT_SESSION_DIR in $rc"
    return
  fi
  printf '\n# Added by pi-config install.sh (machine-local sessions)\n%s\n' "$line" >> "$rc"
}
case "${SHELL##*/}" in
  zsh)  persist_session_env_var "$HOME/.zshrc" ;;
  bash) persist_session_env_var "$HOME/.bashrc" ;;
esac
node "$repo_root/scripts/migrate-local-sessions.mjs"

# Rewrite absolute extension paths in settings.json that point into another
# machine's npm global node_modules tree (settings.json is git-tracked, so a
# committed C:/Users/<other-user>/... entry breaks pi update on a fresh box).
# Shared with install.bat via scripts/install/run.mjs repair-settings.
node "$repo_root/scripts/install/run.mjs" repair-settings "$repo_root/settings.json"

# Resolve the `pi` CLI: prefer PATH, then probe the npm global prefix/bin so a
# freshly `npm i -g` installed pi is found before a new shell opens.
# Shared with install.bat via scripts/install/run.mjs resolve-pi (manual PATH
# search + npm-prefix probe; no `which` dependency).
resolve_pi() {
  node "$repo_root/scripts/install/run.mjs" resolve-pi
}

PI_BIN="$(resolve_pi)" || true
installed_pi=""
if [[ -n "$PI_BIN" ]]; then installed_pi="$("$PI_BIN" --version 2>/dev/null || true)"; fi
if [[ -z "$PI_BIN" || "$installed_pi" != "$pinned_pi" ]]; then
  echo "==> Installing pinned @earendil-works/pi-coding-agent@$pinned_pi (found '$installed_pi')"
  npm install -g "@earendil-works/pi-coding-agent@$pinned_pi" || {
    echo "ERROR: Failed to install pinned pi CLI $pinned_pi." >&2
    exit 1
  }
  PI_BIN="$(resolve_pi)" || true
  [[ -n "$PI_BIN" ]] || { echo "ERROR: pi installed but could not be resolved." >&2; exit 1; }
else
  echo "==> pi CLI is pinned at $pinned_pi"
fi

# Relocate credentials before executing any third-party pi package code.
# ── Relocate auth.json out of the working tree ─────────────────────────────────
# See docs/internal/SECRET_AND_STORAGE_RELOCATION_PLAN.md Phase 2.
auth_dir_env="${PI_CODING_AGENT_AUTH_DIR:-}"
in_tree_auth="$repo_root/auth.json"

if [[ "$(uname)" == "Darwin" ]]; then
  target_auth_dir="$HOME/Library/Application Support/pie"
else
  target_auth_dir="${XDG_CONFIG_HOME:-$HOME/.config}/pie"
fi
target_auth="$target_auth_dir/auth.json"

if [[ -f "$in_tree_auth" && -z "$auth_dir_env" ]]; then
  echo ""
  echo "==> SECURITY: auth.json is inside the working tree."
  echo "    Target location: $target_auth"
  printf "    Move auth.json to the secure OS user-data directory? [Y/n] "
  read -r move_choice
  if [[ -z "$move_choice" || "$move_choice" =~ ^[Yy] ]]; then
    # Shared Node core performs a SHA-256-verified copy and applies mode 0600
    # without depending on platform-specific shasum/sha256sum utilities.
    if node "$repo_root/scripts/install/run.mjs" relocate-auth "$in_tree_auth" "$target_auth"; then
      # Remove the in-tree file and leave a breadcrumb
      rm -f "$in_tree_auth"
      printf 'Relocated to: %s\nSee: docs/internal/SECRET_AND_STORAGE_RELOCATION_PLAN.md\n' "$target_auth" \
        > "$repo_root/auth.json.removed"

      # Persist the env var in the shell rc
      export PI_CODING_AGENT_AUTH_DIR="$target_auth_dir"
      persist_auth_env_var() {
        local rc="$1"
        local line="export PI_CODING_AGENT_AUTH_DIR=\"$target_auth_dir\""
        if [[ -f "$rc" ]] && grep -Fq "PI_CODING_AGENT_AUTH_DIR=" "$rc"; then
          return
        fi
        printf '\n# Added by pi-config install.sh (secret relocation)\n%s\n' "$line" >> "$rc"
      }
      case "${SHELL##*/}" in
        zsh)  persist_auth_env_var "$HOME/.zshrc" ;;
        bash) persist_auth_env_var "$HOME/.bashrc" ;;
        *)    echo "==> Unknown shell; set PI_CODING_AGENT_AUTH_DIR=$target_auth_dir manually" ;;
      esac

      echo "==> auth.json moved to '$target_auth' and PI_CODING_AGENT_AUTH_DIR set."
    else
      echo "WARN: Hash verification failed after copy. auth.json was NOT moved." >&2
    fi
  else
    echo "WARN: auth.json remains in the working tree. See SECURITY.md for recommended hardening." >&2
  fi
elif [[ -f "$in_tree_auth" && -n "$auth_dir_env" ]]; then
  # ── Merge split-brain auth.json ────────────────────────────
  # This is the "401" painpoint: PI_CODING_AGENT_AUTH_DIR is already set to a
  # secure location, but a *new* in-tree auth.json appeared (typically because
  # `pi` was run in a shell that didn't inherit PI_CODING_AGENT_AUTH_DIR, so it
  # wrote fresh creds back to the repo root). The backend reads from the secure
  # location, which is often empty {} → 401 "invalid api key".
  # Fix: merge the in-tree creds into the secure location (deep merge, in-tree
  # wins on conflict), then remove the in-tree copy.
  # Shared with install.bat via scripts/install/run.mjs merge-auth (handles the
  # empty/missing-secure copy case — with chmod 600 on POSIX — and the
  # both-have-content deep merge, then removes the in-tree copy).
  secure_auth_path="$auth_dir_env/auth.json"
  node "$repo_root/scripts/install/run.mjs" merge-auth "$in_tree_auth" "$secure_auth_path"
  echo "    (in-tree auth.json removed to prevent future split-brain; backend reads from PI_CODING_AGENT_AUTH_DIR)"
fi

# Restore packages without updating the pinned pi CLI itself.
echo "==> Running 'pi update --extensions' to restore packages from settings.json"
"$PI_BIN" update --extensions || echo "WARN: 'pi update --extensions' exited non-zero; continue manually if needed"

# ── Write pie.agentDir to VS Code User settings ───────────────────────────────
# The extension host reads pie.agentDir and forwards it to the backend as
# PI_CODING_AGENT_DIR. This is necessary because VS Code only picks up new
# shell-scope env vars on a full restart (not on window reload), so relying
# on the env var alone means the backend falls back to ~/.pi/agent (where no
# models.json exists) until VS Code is fully restarted. Setting pie.agentDir
# in VS Code's own settings.json makes the backend use the correct agent dir
# on the very first reload after install.
# Shared with install.bat via scripts/install/run.mjs write-vscode-agent-dir,
# which writes pie.agentDir into each existing VS Code User settings.json.
node "$repo_root/scripts/install/run.mjs" write-vscode-agent-dir "$repo_root"

# Build/package/install the extension from its tracked lockfile.
echo "==> Building pie VS Code extension"
vsix=""
if (
  # Root postinstall installs the locked extension/ and analysis/ trees too.
  cd "$repo_root"
  npm ci --include=dev
  cd "$repo_root/extension"
  npm run build
  npm run package
); then
  vsix="$(find "$repo_root/extension" -maxdepth 1 -name 'pie-*.vsix' -type f -print | sort | tail -1)"
else
  echo "WARN: Extension build failed. Close VS Code if it is using files under extension/node_modules, then re-run." >&2
fi
code_cli=""
if command -v code >/dev/null 2>&1; then code_cli="$(command -v code)";
elif command -v code-insiders >/dev/null 2>&1; then code_cli="$(command -v code-insiders)"; fi
if [[ -n "$code_cli" && -n "$vsix" ]]; then
  "$code_cli" --install-extension "$vsix" --force || echo "WARN: VS Code extension install failed; install $vsix manually" >&2
elif [[ -n "$vsix" ]]; then
  echo "WARN: VS Code CLI unavailable; install $vsix manually" >&2
fi

cat <<EOM

==> Done.

Resolved storage paths:
    Auth:     ${PI_CODING_AGENT_AUTH_DIR:-$repo_root}/auth.json
    Sessions: $repo_root/data/outcomes/sessions

Next steps:
  - Open a new shell (or 'source' your shell rc) so environment variables take effect.
  - Read SECURITY.md before sharing this checkout with anyone.
  - Run npm run doctor to verify machine-local paths and pinned versions.
  - Session transcripts stay on this machine and must not be cloud-synced.
EOM

# ── Post-install readiness check ─────────────────────────────────────
# The app will start but cannot talk to any model without auth/provider keys.
# Detect the gap and tell the user exactly what to do next.
# Shared with install.bat via scripts/install/run.mjs readiness (auth content,
# provider env, and split-brain checks with platform-appropriate advice).
auth_dir_resolved="${PI_CODING_AGENT_AUTH_DIR:-$repo_root}"
backend_auth_path="$auth_dir_resolved/auth.json"

echo ""
echo "==> Post-install verification:"
node "$repo_root/scripts/install/run.mjs" readiness \
  --auth "$backend_auth_path" \
  --in-tree-auth "$repo_root/auth.json" \
  --auth-dir "$auth_dir_resolved" \
  --repo-root "$repo_root"

echo ""
echo "==> Next steps:"
echo "  1. Reload VS Code (Developer: Reload Window) to activate the pie panel."
echo "  2. Open a new shell so env vars take effect before running 'pi'."
echo "  3. If models don't appear or you get 401, see README.md → Troubleshooting."
