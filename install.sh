#!/usr/bin/env bash
# Bootstrap the pie portable coding-agent configuration on macOS / Linux.
#
# Mirrors install.ps1: pins the toolchain and CLI, relocates credentials,
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

pinned_node="$(tr -d '[:space:]v' < "$repo_root/.node-version")"
actual_node="$(node -p 'process.versions.node')"
if [[ "$actual_node" != "$pinned_node" ]]; then
  echo "ERROR: Node.js $pinned_node required for reproducible installs, found $actual_node. Use .nvmrc/.node-version." >&2
  exit 1
fi
pinned_npm="$(node -p 'require(process.argv[1]).packageManager.replace(/^npm@/, "")' "$repo_root/package.json")"
actual_npm="$(npm --version)"
if [[ "$actual_npm" != "$pinned_npm" ]]; then
  echo "==> Installing pinned npm@$pinned_npm (found $actual_npm)"
  npm install -g "npm@$pinned_npm"
fi
pinned_pi="$(node "$repo_root/scripts/lib/sdk-version.mjs")"

# Keep session history local to this checkout and migrate legacy stores safely.
session_dir="$repo_root/data/outcomes/sessions"
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
repair_settings_extension_paths() {
  local settings="$1"
  [[ -f "$settings" ]] || return 0

  npm prefix >/dev/null 2>&1 || { echo "WARN: 'npm prefix' failed; skipping settings.json extension path repair." >&2; return 0; }

  node - "$settings" <<'NODE_SCRIPT'
const fs = require('fs');
const { execSync } = require('child_process');
const p = process.argv[1];
let src; try { src = fs.readFileSync(p, 'utf8'); } catch { process.exit(0); }
let s; try { s = JSON.parse(src); } catch (e) { console.warn(`WARN: could not parse ${p}: ${e.message}`); process.exit(0); }
if (!Array.isArray(s.extensions) || s.extensions.length === 0) process.exit(0);
let prefix; try { prefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim(); } catch { process.exit(0); }
if (!prefix) process.exit(0);
let changed = false;
let missing = [];
const norm = s.extensions.map((e) => {
  if (typeof e !== 'string') return e;
  const m = e.match(/[\\/]node_modules[\\/]+([^\\/]+)$/);
  if (!m || !require('path').isAbsolute(e.replace(/\//g, require('path').sep))) return e;
  // Only rewrite absolute paths that resolve into a node_modules tree.
  const sep = process.platform === 'win32' ? '\\' : '/';
  const candidate = `${prefix}${sep}node_modules${sep}${m[1]}`;
  if (e.replace(/\\/g, '/').toLowerCase() === candidate.replace(/\\/g, '/').toLowerCase()) return e;
  changed = true;
  if (!fs.existsSync(candidate)) missing.push(m[1]);
  return candidate;
});
if (!changed) process.exit(0);
fs.copyFileSync(p, `${p}.extensions.${Date.now()}.bak`);
s.extensions = norm;
fs.writeFileSync(p, JSON.stringify(s, null, 2));
console.log('==> Normalized extension paths in settings.json');
console.log(`==> Backed up the previous settings.json to ${p}.extensions.*.bak`);
missing.forEach((pkg) => console.warn(`WARN: extension package '${pkg}' not installed under the npm global prefix. Install with: npm i -g ${pkg}`));
NODE_SCRIPT
}

repair_settings_extension_paths "$repo_root/settings.json"

# Resolve the `pi` CLI: prefer PATH, then probe the npm global prefix/bin so a
# freshly `npm i -g` installed pi is found before a new shell opens.
resolve_pi() {
  if command -v pi >/dev/null 2>&1; then
    command -v pi
    return 0
  fi
  local prefix
  prefix="$(npm config get prefix 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$prefix" ]]; then
    for cand in "$prefix/bin/pi" "$prefix/pi"; do
      if [[ -x "$cand" ]]; then
        echo "$cand"
        return 0
      fi
    done
  fi
  return 1
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
    mkdir -p "$target_auth_dir"
    cp "$in_tree_auth" "$target_auth"

    # Verify the copy. Resolve a SHA-256 command portably: `shasum -a 256` is
    # macOS/BSD (a Perl script), `sha256sum` is the Linux coreutils default.
    # Under `set -euo pipefail`, calling `shasum` on a Linux box without it
    # would abort mid-flight (after the copy, before chmod/rm/breadcrumb), so
    # resolve the command first and degrade gracefully if neither exists.
    if command -v shasum >/dev/null 2>&1; then
      sha_cmd=(shasum -a 256)
    elif command -v sha256sum >/dev/null 2>&1; then
      sha_cmd=(sha256sum)
    else
      sha_cmd=()
    fi

    hash_verified=1
    if [[ ${#sha_cmd[@]} -gt 0 ]]; then
      source_hash="$("${sha_cmd[@]}" "$in_tree_auth" | cut -d' ' -f1)"
      dest_hash="$("${sha_cmd[@]}" "$target_auth" | cut -d' ' -f1)"
      if [[ "$source_hash" != "$dest_hash" ]]; then
        rm -f "$target_auth"
        echo "WARN: Hash verification failed after copy. auth.json was NOT moved." >&2
        hash_verified=0
      fi
    else
      echo "WARN: Neither shasum nor sha256sum found; proceeding with the move WITHOUT integrity verification." >&2
    fi

    if [[ "$hash_verified" != "0" ]]; then
      chmod 600 "$target_auth"

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
    fi
  else
    echo "WARN: auth.json remains in the working tree. See SECURITY.md for recommended hardening." >&2
  fi
elif [[ -f "$in_tree_auth" && -n "$auth_dir_env" ]]; then
  # ── Merge split-brain auth.json ────────────────────────────────────────────
  # This is the "401" painpoint: PI_CODING_AGENT_AUTH_DIR is already set to a
  # secure location, but a *new* in-tree auth.json appeared (typically because
  # `pi` was run in a shell that didn't inherit PI_CODING_AGENT_AUTH_DIR, so it
  # wrote fresh creds back to the repo root). The backend reads from the secure
  # location, which is often empty {} → 401 "invalid api key".
  # Fix: merge the in-tree creds into the secure location (deep merge, in-tree
  # wins on conflict), then remove the in-tree copy.
  secure_auth_path="$auth_dir_env/auth.json"
  if [[ ! -f "$secure_auth_path" ]] || [[ $(wc -c < "$secure_auth_path") -le 2 ]]; then
    # Secure location missing or empty {} — just copy the in-tree file.
    mkdir -p "$auth_dir_env"
    cp "$in_tree_auth" "$secure_auth_path"
    chmod 600 "$secure_auth_path"
    echo "==> auth.json copied from working tree to secure location '$secure_auth_path' (was empty/missing)"
    rm -f "$in_tree_auth"
  else
    # Both have content — deep-merge with node (handles JSON robustly).
    node -e '
      const fs = require("fs");
      const inTree = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const secure = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
      let merged = 0;
      for (const [provider, creds] of Object.entries(inTree)) {
        if (JSON.stringify(secure[provider]) !== JSON.stringify(creds)) {
          secure[provider] = creds;
          merged++;
        }
      }
      fs.writeFileSync(process.argv[2], JSON.stringify(secure, null, 2) + "\n", "utf8");
      console.log("==> Merged " + merged + " provider(s) from working-tree auth.json into secure location");
    ' "$in_tree_auth" "$secure_auth_path" && rm -f "$in_tree_auth"
  fi
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
vs_settings_dirs=(
  "$HOME/.config/Code/User"
  "$HOME/Library/Application Support/Code/User"
  "$HOME/.config/Code - OSS/User"
)
for vs_settings_dir in "${vs_settings_dirs[@]}"; do
  vs_settings_path="$vs_settings_dir/settings.json"
  if [[ -d "$vs_settings_dir" ]]; then
    # Use node to merge pie.agentDir into the JSON (handles existing files).
    # Pipe via heredoc to avoid fragile single-quote escaping in node -e.
    # With --input-type=module -e, process.argv is [node, arg1, ...] (no script
    # path), so use slice(1).
    node --input-type=module -e '
      import fs from "node:fs";
      const [settingsPath, repoRoot] = process.argv.slice(1);
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
      if (settings["pie.agentDir"] !== repoRoot) {
        settings["pie.agentDir"] = repoRoot;
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
        console.log(`==> Set pie.agentDir to ${repoRoot} in VS Code User settings (${settingsPath})`);
      } else {
        console.log(`==> pie.agentDir already set in VS Code User settings (${settingsPath})`);
      }
    ' "$vs_settings_path" "$repo_root" || echo "WARN: could not write pie.agentDir to $vs_settings_path"
  fi
done

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
auth_dir_resolved="${PI_CODING_AGENT_AUTH_DIR:-$repo_root}"
backend_auth_path="$auth_dir_resolved/auth.json"

# Check if auth.json has REAL content (not just {}) using node
auth_has_content=0
auth_providers=""
if [[ -f "$backend_auth_path" ]]; then
  read -r auth_has_content auth_providers <<< "$(node -e '
    const fs = require("fs");
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const keys = Object.keys(d).filter(k => k);
      console.log(keys.length > 0 ? "1" : "0", keys.join(","));
    } catch { console.log("0", ""); }
  ' "$backend_auth_path" 2>/dev/null)"
fi
provider_env_present=0
for var in ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY UMANS_API_KEY; do
  if [[ -n "${!var:-}" ]]; then provider_env_present=1; break; fi
done

echo ""
echo "==> Post-install verification:"

# Check: Auth content
if [[ "$auth_has_content" == "1" ]]; then
  echo "  [✓] Auth credentials found ($auth_providers) at $backend_auth_path"
elif [[ "$provider_env_present" == "1" ]]; then
  echo "  [✓] Provider API key env var detected — pi will use it automatically."
else
  echo "  [!] No auth.json content and no provider API key env vars found."
  echo "      The pie panel will start but will get 401 / 'invalid api key' until you authenticate."
  echo "      Pick ONE:"
  echo "        • Export a provider API key, e.g.:"
  echo "            export ANTHROPIC_API_KEY=\"sk-ant-...\"   (add to ~/.zshrc or ~/.bashrc)"
  echo "        • Or run pi once interactively (then re-run this installer to merge creds):"
  echo "            pi --provider umans --model umans-glm-5.2 \"hello\""
  echo "          (pi will prompt for an API key on first use and cache it in auth.json.)"
  echo "      See README.md → Authentication for the full list of supported providers."
fi

# Check: Split-brain warning
if [[ -f "$repo_root/auth.json" && "$auth_dir_resolved" != "$repo_root" ]]; then
  in_tree_has_content=$(node -e '
    const fs = require("fs");
    try { const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); console.log(Object.keys(d).length > 0 ? "1" : "0"); } catch { console.log("0"); }
  ' "$repo_root/auth.json" 2>/dev/null)
  if [[ "$in_tree_has_content" == "1" ]]; then
    echo "  [!] Split-brain: auth.json with real creds found in repo root, but backend reads from $auth_dir_resolved"
    echo "      Re-run this installer to auto-merge, or copy manually: cp '$repo_root/auth.json' '$backend_auth_path'"
  fi
fi

echo ""
echo "==> Next steps:"
echo "  1. Reload VS Code (Developer: Reload Window) to activate the pie panel."
echo "  2. Open a new shell so env vars take effect before running 'pi'."
echo "  3. If models don't appear or you get 401, see README.md → Troubleshooting."
