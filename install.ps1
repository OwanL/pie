#Requires -Version 5.1
<#
.SYNOPSIS
  Bootstraps the pie portable coding-agent configuration on a new machine.

.DESCRIPTION
  1. Sets PI_CODING_AGENT_DIR as a user-level environment variable pointing to this repo.
  2. Migrates auth.json from the old default location (~/.pi/agent/) if it exists and
     no auth.json is already present in this repo.
  3. Migrates or merges legacy session history from the old default location
     (~/.pi/agent/sessions/) into this checkout's local git-ignored data/outcomes/sessions store,
     preserving conflicting copies in backup files when the source and destination differ.
  4. Validates Node.js and npm, then installs `pi` (@earendil-works/pi-coding-agent)
     globally if it is not already on PATH, and restores PI packages via `pi update`.
  6. Builds and installs the pie VSCode extension from extension/.

.NOTES
  Run once after cloning the repo on a new machine:
    Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
    .\install.ps1
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# When launched via double-click / Run dialog / "Open With PowerShell", the
# console window closes the instant the script ends, so any error flashes by
# unreadable. Detect that non-interactive launch and pause before exiting so
# the message is visible. (Running inside an existing terminal is unaffected.)
$interactiveLaunch = $false
try {
  $host.UI.RawUI.WindowTitle | Out-Null
  # The Export-ModuleMember-less $Host.UI check works on Windows PowerShell 5.1
  # and pwsh 7+. A real terminal session has $host.UI.RawUI.KeyAvailable or a
  # non-default title; the ephemeral launcher console has neither, but the
  # most reliable signal is: the process has no parent console pipe (i.e. it
  # was spawned fresh by Explorer/the shell host).
} catch {}
# Heuristic: if stdin is NOT redirected and there is no $CI / -NonInteractive
# flag, we were likely launched interactively. The simplest robust test on
# Windows: check whether the console was created for this process (_launcher)
# vs inherited. We approximate by checking the window title we just set.
if (-not [System.Console]::IsInputRedirected -and -not $env:CI) {
  $interactiveLaunch = $true
}

trap {
  Write-Host ""
  Write-Host "==> INSTALL FAILED: $_" -ForegroundColor Red
  if ($interactiveLaunch) {
    Write-Host ""
    Write-Host "Press Enter to close..." -ForegroundColor Yellow
    Read-Host
  }
  exit 1
}

$repoRoot = $PSScriptRoot

Write-Host "==> Setting PI_CODING_AGENT_DIR to '$repoRoot'"
[System.Environment]::SetEnvironmentVariable(
  'PI_CODING_AGENT_DIR',
  $repoRoot,
  [System.EnvironmentVariableTarget]::User
)
# Apply immediately for the current process too
$env:PI_CODING_AGENT_DIR = $repoRoot

function Assert-Command($name, $installHint) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "$name is required but was not found on PATH. $installHint"
  }

  return $cmd
}

function Write-Utf8NoBomFile($path, $content) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $content, $utf8NoBom)
}

# Windows PowerShell 5.1 lacks ConvertFrom-Json -AsHashtable. Keep the
# installer compatible with its declared minimum by converting the top-level
# PSCustomObject explicitly.
function Read-JsonHashtable($path) {
  $value = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -ErrorAction Stop
  $result = @{}
  if ($null -ne $value) {
    foreach ($property in $value.PSObject.Properties) {
      $result[$property.Name] = $property.Value
    }
  }
  return $result
}

function Resolve-CodeCli {
  # Resolve the VS Code CLI (code / code-insiders) for --install-extension.
  # Prefer `code` on PATH, then probe the common per-machine install dirs so a
  # fresh shell whose PATH hasn't picked up the VS Code bin dir still finds it.
  $onPath = Get-Command code -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd'),
    'C:\Program Files\Microsoft VS Code\bin\code.cmd',
    'C:\Program Files\Microsoft VS Code Insiders\bin\code-insiders.cmd'
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Repair-SettingsExtensionPaths($settingsPath) {
  # The committed settings.json may reference extension packages via absolute
  # paths into another machine's npm global node_modules tree (e.g.
  # C:/Users/<other-user>/AppData/Roaming/npm/node_modules/<pkg>). Rewrite each
  # such entry to THIS machine's `npm config get prefix` so pi can load them.
  if (-not (Test-Path $settingsPath)) { return }

  try {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -ErrorAction Stop
  } catch {
    Write-Warning "Could not parse settings.json for extension path repair: $_"
    return
  }

  $extensionsProperty = $settings.PSObject.Properties['extensions']
  if (-not $extensionsProperty) { return }
  $entries = @($extensionsProperty.Value)
  if ($entries.Count -eq 0) { return }

  $npmPrefix = $null
  try {
    $npmPrefix = (npm config get prefix 2>$null).Trim()
  } catch {}
  if (-not $npmPrefix) {
    Write-Warning "Could not resolve 'npm config get prefix'; skipping extension path repair in settings.json."
    return
  }

  $changed = $false
  $normalized = @()
  foreach ($entry in $entries) {
    $entryStr = [string]$entry
    if ([System.IO.Path]::IsPathRooted($entryStr) -and $entryStr -match 'node_modules[\\/]+([^\\/]+)$') {
      $pkgName = $matches[1]
      $candidate = Join-Path $npmPrefix "node_modules\$pkgName"
      # Normalize slash direction for the comparison so we don't rewrite just
      # to flip forward/back slashes (idempotent on the author's machine).
      $oldNorm = $entryStr -replace '/', '\'
      if ($oldNorm -ne $candidate) {
        Write-Host "==> Rewriting extension path '$entryStr' -> '$candidate'"
        $normalized += $candidate
        $changed = $true
        if (-not (Test-Path $candidate)) {
          Write-Warning "Extension package '$pkgName' is not installed under the npm global prefix. Install it with: npm i -g $pkgName"
        }
      } else {
        $normalized += $entryStr
      }
    } else {
      $normalized += $entryStr
    }
  }

  if ($changed) {
    $settingsBackupPath = "$settingsPath.extensions.$([guid]::NewGuid().ToString('N')).bak"
    Copy-Item -LiteralPath $settingsPath -Destination $settingsBackupPath
    $settings.extensions = $normalized
    Write-Utf8NoBomFile $settingsPath ($settings | ConvertTo-Json -Depth 100)
    Write-Host "==> Normalized extension paths in settings.json"
    Write-Host "==> Backed up the previous settings.json to '$settingsBackupPath'"
  }
}

function Test-DirectoryHasJsonlFiles($path, $recurse = $true) {
  if (-not (Test-Path $path -PathType Container)) {
    return $false
  }

  $files = if ($recurse) {
    Get-ChildItem -LiteralPath $path -Filter '*.jsonl' -File -Recurse -ErrorAction SilentlyContinue
  } else {
    Get-ChildItem -LiteralPath $path -Filter '*.jsonl' -File -ErrorAction SilentlyContinue
  }

  return $null -ne ($files | Select-Object -First 1)
}

function Resolve-ConfiguredSessionDir($value) {
  if (-not $value) {
    return $null
  }

  if ($value -eq '~') {
    return [Environment]::GetFolderPath('UserProfile')
  }

  # A single backslash in a single-quoted PowerShell string; '~\' matches a
  # normal Windows home-relative override like ~\foo (NOT the literal '~\\').
  if ($value.StartsWith('~/') -or $value.StartsWith('~\')) {
    return Join-Path ([Environment]::GetFolderPath('UserProfile')) $value.Substring(2)
  }

  if ([System.IO.Path]::IsPathRooted($value)) {
    return $value
  }

  return $null
}

function Get-DefaultSessionBucketName($cwd) {
  $trimmed = $cwd -replace '^[\\/]+', ''
  $safePath = $trimmed -replace '[/\\:]', '-'
  return "--$safePath--"
}

function Get-SessionHeaderCwd($path) {
  foreach ($line in Get-Content -LiteralPath $path -ErrorAction SilentlyContinue) {
    $trimmed = $line.Trim()
    if (-not $trimmed) {
      continue
    }

    try {
      $entry = $trimmed | ConvertFrom-Json -ErrorAction Stop
      if ($entry.type -eq 'session' -and $entry.cwd) {
        return [string]$entry.cwd
      }
    } catch {
      return $null
    }
  }

  return $null
}

function Get-SessionContentTimestamp($path) {
  $lastTimestamp = $null

  Get-Content -LiteralPath $path -ErrorAction SilentlyContinue |
    ForEach-Object {
      $line = $_.Trim()
      if ($line) {
        try {
          $entry = $line | ConvertFrom-Json -ErrorAction Stop
          if ($entry.timestamp) {
            $entryTimestamp = [DateTime]$entry.timestamp
            if (-not $lastTimestamp -or $entryTimestamp -gt $lastTimestamp) {
              $lastTimestamp = $entryTimestamp
            }
          }
        } catch {
        }
      }
    }

  if ($lastTimestamp) {
    return $lastTimestamp.ToUniversalTime()
  }

  return (Get-Item -LiteralPath $path).LastWriteTimeUtc
}

function Merge-LegacySessionFiles($sourceDir, $destinationDir, $recurse = $true) {
  $copied = 0
  $updated = 0
  $identical = 0
  $backedUpConflicts = 0

  $sourceFiles = if ($recurse) {
    Get-ChildItem -LiteralPath $sourceDir -Filter '*.jsonl' -File -Recurse -ErrorAction SilentlyContinue
  } else {
    Get-ChildItem -LiteralPath $sourceDir -Filter '*.jsonl' -File -ErrorAction SilentlyContinue
  }

  $sourceFiles |
    ForEach-Object {
      $sourcePath = $_.FullName
      $sessionCwd = Get-SessionHeaderCwd $sourcePath
      $bucketPath = if ($sessionCwd) {
        Get-DefaultSessionBucketName $sessionCwd
      } else {
        '--unknown--'
      }
      $destinationPath = Join-Path (Join-Path $destinationDir $bucketPath) (Split-Path -Leaf $sourcePath)
      $destinationParent = Split-Path -Parent $destinationPath
      if ($destinationParent) {
        New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
      }

      if (-not (Test-Path $destinationPath)) {
        Copy-Item -LiteralPath $sourcePath -Destination $destinationPath
        $copied++
      } else {
        $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
        $destinationHash = (Get-FileHash -LiteralPath $destinationPath -Algorithm SHA256).Hash
        if ($sourceHash -eq $destinationHash) {
          $identical++
        } else {
          $sourceTimestamp = Get-SessionContentTimestamp $sourcePath
          $destinationTimestamp = Get-SessionContentTimestamp $destinationPath
          if ($sourceTimestamp -gt $destinationTimestamp) {
            $backupPath = "$destinationPath.conflict.$([guid]::NewGuid().ToString('N')).bak"
            Copy-Item -LiteralPath $destinationPath -Destination $backupPath
            Copy-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
            $updated++
            $backedUpConflicts++
          } else {
            $backupPath = "$destinationPath.conflict.$([guid]::NewGuid().ToString('N')).incoming.bak"
            Copy-Item -LiteralPath $sourcePath -Destination $backupPath
            $backedUpConflicts++
          }
        }
      }
    }

  return @{
    copied = $copied
    updated = $updated
    identical = $identical
    backedUpConflicts = $backedUpConflicts
  }
}

# Migrate auth.json from the old default location if needed
$oldAuth = Join-Path $env:USERPROFILE '.pi\agent\auth.json'
$newAuth = Join-Path $repoRoot 'auth.json'
if ((Test-Path $oldAuth) -and -not (Test-Path $newAuth)) {
  Write-Host "==> Migrating auth.json from '$oldAuth'"
  Copy-Item $oldAuth $newAuth
} elseif (Test-Path $newAuth) {
  Write-Host "==> auth.json already present in repo - skipping migration"
} else {
  Write-Host "==> No existing auth.json found - you will need to authenticate PI on first run"
}

# Migrate local session history from legacy locations if needed
$outcomesRoot = Join-Path $repoRoot 'data\outcomes'
$newSessions = Join-Path $outcomesRoot 'sessions'
$legacySessionImports = @()
$desiredSessionDir = 'data/outcomes/sessions'
$defaultLegacySessions = Join-Path $env:USERPROFILE '.pi\agent\sessions'
$legacyRepoLocalSessions = Join-Path $repoRoot 'data\sessions'
if (Test-DirectoryHasJsonlFiles $defaultLegacySessions) {
  $legacySessionImports += @{ source = $defaultLegacySessions; recurse = $true }
}
if (Test-DirectoryHasJsonlFiles $legacyRepoLocalSessions) {
  $legacySessionImports += @{ source = $legacyRepoLocalSessions; recurse = $true }
}

$settingsPath = Join-Path $repoRoot 'settings.json'
if (Test-Path $settingsPath) {
  try {
    $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json -ErrorAction Stop
    $sessionDirProperty = $settings.PSObject.Properties['sessionDir']
    if ($sessionDirProperty) {
      $configuredSessionDir = [string]$sessionDirProperty.Value
      $resolvedConfiguredSessionDir = Resolve-ConfiguredSessionDir $configuredSessionDir
      $configuredSessionDirExists = $resolvedConfiguredSessionDir -and (Test-Path $resolvedConfiguredSessionDir -PathType Container)
      if ($configuredSessionDir -ne $desiredSessionDir) {
        $settingsBackupPath = "$settingsPath.session-dir.$([guid]::NewGuid().ToString('N')).bak"
        Copy-Item -LiteralPath $settingsPath -Destination $settingsBackupPath
        $settings.sessionDir = $desiredSessionDir
        Write-Utf8NoBomFile $settingsPath ($settings | ConvertTo-Json -Depth 100)
        Write-Host "==> Updated sessionDir in settings.json to '$desiredSessionDir'"
        Write-Host "==> Backed up the previous settings.json to '$settingsBackupPath'"
        if ($configuredSessionDirExists -and $resolvedConfiguredSessionDir -ne $newSessions) {
          $legacySessionImports += @{ source = $resolvedConfiguredSessionDir; recurse = $false }
          Write-Host "==> Will import legacy session history from configured sessionDir '$resolvedConfiguredSessionDir'"
        } elseif ($resolvedConfiguredSessionDir -and $resolvedConfiguredSessionDir -eq $newSessions) {
          Write-Host "==> sessionDir already points at '$desiredSessionDir'"
        } elseif (-not $resolvedConfiguredSessionDir) {
          Write-Warning "The previous sessionDir value '$configuredSessionDir' could not be resolved safely, so it was replaced with '$desiredSessionDir'."
        } else {
          Write-Host "==> configured sessionDir '$resolvedConfiguredSessionDir' has no session files to import"
        }
      }
    } else {
      $settingsBackupPath = "$settingsPath.session-dir.$([guid]::NewGuid().ToString('N')).bak"
      Copy-Item -LiteralPath $settingsPath -Destination $settingsBackupPath
      $settings | Add-Member -NotePropertyName 'sessionDir' -NotePropertyValue $desiredSessionDir
      Write-Utf8NoBomFile $settingsPath ($settings | ConvertTo-Json -Depth 100)
      Write-Host "==> Added sessionDir to settings.json so PI uses '$desiredSessionDir'"
      Write-Host "==> Backed up the previous settings.json to '$settingsBackupPath'"
    }
  } catch {
    Write-Warning "Failed to inspect settings.json for sessionDir overrides: $_"
  }
}

$sessionDirOverride = [System.Environment]::GetEnvironmentVariable('PI_CODING_AGENT_SESSION_DIR', [System.EnvironmentVariableTarget]::User)
if (-not $sessionDirOverride) {
  $sessionDirOverride = $env:PI_CODING_AGENT_SESSION_DIR
}
if ($sessionDirOverride -and ([System.IO.Path]::GetFullPath($sessionDirOverride) -ne [System.IO.Path]::GetFullPath($newSessions))) {
  Write-Warning "PI_CODING_AGENT_SESSION_DIR is set to '$sessionDirOverride'. Replacing it with this machine-local checkout store at '$newSessions'."
}
[System.Environment]::SetEnvironmentVariable(
  'PI_CODING_AGENT_SESSION_DIR',
  $newSessions,
  [System.EnvironmentVariableTarget]::User
)
$env:PI_CODING_AGENT_SESSION_DIR = $newSessions
$sessionDirOverride = $newSessions
Write-Host "==> PI_CODING_AGENT_SESSION_DIR uses the machine-local store at '$newSessions'"

$hasRepoSessions = Test-DirectoryHasJsonlFiles $newSessions
$resolvedNewSessions = if (Test-Path $newSessions -PathType Container) {
  (Resolve-Path $newSessions).Path
} else {
  [System.IO.Path]::GetFullPath($newSessions)
}
$normalizedLegacyImports = @()
$seenLegacyImports = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($legacyImport in $legacySessionImports) {
  $sourcePath = $legacyImport['source']
  $recurse = [bool]$legacyImport['recurse']
  if (-not (Test-Path $sourcePath -PathType Container)) {
    continue
  }

  $resolvedSourcePath = (Resolve-Path $sourcePath).Path
  $key = "$resolvedSourcePath|$recurse"
  if ($seenLegacyImports.Add($key)) {
    $normalizedLegacyImports += @{ source = $resolvedSourcePath; recurse = $recurse }
  }
}

if ($normalizedLegacyImports.Count -gt 0) {
  New-Item -ItemType Directory -Path $outcomesRoot -Force | Out-Null
  foreach ($legacyImport in $normalizedLegacyImports) {
    $legacySource = $legacyImport['source']
    $legacyRecurse = [bool]$legacyImport['recurse']
    if ($legacySource -eq $resolvedNewSessions) {
      Write-Host "==> session history already points at '$newSessions' - skipping migration"
      continue
    }

    $migrationVerb = if ($hasRepoSessions) { 'Merging' } else { 'Migrating' }
    Write-Host "==> $migrationVerb session history from '$legacySource' into '$newSessions'"
    New-Item -ItemType Directory -Path $newSessions -Force | Out-Null
    $importResult = Merge-LegacySessionFiles $legacySource $newSessions $legacyRecurse
    Write-Host (
      "==> Imported $($importResult.copied) new session file(s); refreshed $($importResult.updated) newer file(s); " +
      "preserved $($importResult.backedUpConflicts) conflicting backup file(s); skipped $($importResult.identical) identical file(s)"
    )
    $hasRepoSessions = Test-DirectoryHasJsonlFiles $newSessions
  }
} elseif ($hasRepoSessions) {
  Write-Host "==> session history already present in the local data/outcomes/sessions directory - no legacy migration needed"
} else {
  Write-Host "==> No existing session history found to migrate"
}

Write-Host "==> Validating prerequisites"
Assert-Command 'node' 'Install the version in .node-version first: https://nodejs.org/' | Out-Null
Assert-Command 'npm' 'Install npm together with Node.js: https://nodejs.org/' | Out-Null

$pinnedNodeVersion = (Get-Content (Join-Path $repoRoot '.node-version') -Raw).Trim().TrimStart('v')
$actualNodeVersion = (& node --version).Trim().TrimStart('v')
if ($actualNodeVersion -ne $pinnedNodeVersion) {
  throw "Node.js $pinnedNodeVersion is required for reproducible installs; found $actualNodeVersion. Use .nvmrc/.node-version."
}
$rootPackage = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$pinnedNpmVersion = ([string]$rootPackage.packageManager) -replace '^npm@', ''
$actualNpmVersion = (& npm --version).Trim()
if ($actualNpmVersion -ne $pinnedNpmVersion) {
  Write-Host "==> Installing pinned npm@$pinnedNpmVersion (found $actualNpmVersion)"
  npm install -g "npm@$pinnedNpmVersion"
  if ($LASTEXITCODE -ne 0) { throw "Failed to install npm@$pinnedNpmVersion" }
}
$pinnedPiVersion = (& node (Join-Path $repoRoot 'scripts\lib\sdk-version.mjs')).Trim()
if (-not $pinnedPiVersion) { throw 'Could not resolve the pi SDK version from extension/package-lock.json' }

function Resolve-PiBinary {
  # Find the `pi` executable: prefer PATH, then probe the npm global prefix
  # (a freshly `npm i -g` installed pi isn't on PATH until a new shell opens).
  $onPath = Get-Command pi -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  try { $prefix = (npm config get prefix 2>$null).Trim() } catch {}
  if ($prefix) {
    foreach ($name in 'pi.cmd','pi.ps1','pi') {
      $candidate = Join-Path $prefix $name
      if (Test-Path $candidate) { return $candidate }
    }
  }
  return $null
}

$piCmd = Resolve-PiBinary
$installedPiVersion = if ($piCmd) { ((& $piCmd --version) | Out-String).Trim() } else { '' }
if (-not $piCmd -or $installedPiVersion -ne $pinnedPiVersion) {
  Write-Host "==> Installing pinned @earendil-works/pi-coding-agent@$pinnedPiVersion (found '$installedPiVersion')"
  npm install -g "@earendil-works/pi-coding-agent@$pinnedPiVersion"
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to install @earendil-works/pi-coding-agent@$pinnedPiVersion globally."
  }
  $piCmd = Resolve-PiBinary
  if (-not $piCmd) {
    throw "@earendil-works/pi-coding-agent installed but 'pi' could not be resolved on PATH or under the npm prefix. Open a new terminal and re-run."
  }
  Write-Host "==> Installed pi $pinnedPiVersion to '$piCmd'"
} else {
  Write-Host "==> pi CLI is pinned at $pinnedPiVersion"
}

# Rewrite any absolute extension paths in settings.json that point at another
# machine's npm global node_modules tree (settings.json is git-tracked, so a
# committed C:/Users/<other-user>/... entry breaks pi update on a fresh box).
Repair-SettingsExtensionPaths $settingsPath

# -- Relocate auth.json out of the working tree ---------------------------------
# See docs/internal/SECRET_AND_STORAGE_RELOCATION_PLAN.md Phase 2.
$authDirEnv = [System.Environment]::GetEnvironmentVariable('PI_CODING_AGENT_AUTH_DIR', [System.EnvironmentVariableTarget]::User)
if (-not $authDirEnv) {
  $authDirEnv = $env:PI_CODING_AGENT_AUTH_DIR
}

$inTreeAuth = Join-Path $repoRoot 'auth.json'
$targetAuthDir = Join-Path $env:LOCALAPPDATA 'pie'
$targetAuth = Join-Path $targetAuthDir 'auth.json'

# Helper: safely parse auth.json into a hashtable (empty on error/missing).
function Read-AuthJson($p) {
  if (-not (Test-Path $p)) { return @{} }
  try { return Read-JsonHashtable $p } catch { return @{} }
}

function Write-AuthJson($p, $data) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($p, ($data | ConvertTo-Json -Depth 20), $utf8NoBom)
}

if ((Test-Path $inTreeAuth) -and -not $authDirEnv) {
  Write-Host ""
  Write-Host "==> SECURITY: auth.json is inside the working tree."
  Write-Host "    Target location: $targetAuth"
  $moveChoice = Read-Host "    Move auth.json to the secure OS user-data directory? [Y/n]"
  if ($moveChoice -eq '' -or $moveChoice -match '^[Yy]') {
    New-Item -ItemType Directory -Path $targetAuthDir -Force | Out-Null
    Copy-Item -LiteralPath $inTreeAuth -Destination $targetAuth -Force

    # Verify the copy
    $sourceHash = (Get-FileHash -LiteralPath $inTreeAuth -Algorithm SHA256).Hash
    $destHash = (Get-FileHash -LiteralPath $targetAuth -Algorithm SHA256).Hash
    if ($sourceHash -ne $destHash) {
      Remove-Item -LiteralPath $targetAuth -Force -ErrorAction SilentlyContinue
      Write-Warning "Hash verification failed after copy. auth.json was NOT moved."
    } else {
      # Restrict ACLs on the target file
      $acl = Get-Acl -LiteralPath $targetAuth
      $acl.SetAccessRuleProtection($true, $false)
      $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) } | Out-Null
      $userRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        [System.Security.Principal.WindowsIdentity]::GetCurrent().Name,
        'FullControl',
        'Allow'
      )
      $acl.AddAccessRule($userRule)
      Set-Acl -LiteralPath $targetAuth -AclObject $acl

      # Set the environment variable persistently
      [System.Environment]::SetEnvironmentVariable(
        'PI_CODING_AGENT_AUTH_DIR',
        $targetAuthDir,
        [System.EnvironmentVariableTarget]::User
      )
      $env:PI_CODING_AGENT_AUTH_DIR = $targetAuthDir

      # Remove the in-tree file and leave a breadcrumb
      Remove-Item -LiteralPath $inTreeAuth -Force
      Write-Utf8NoBomFile (Join-Path $repoRoot 'auth.json.removed') "Relocated to: $targetAuth`nSee: docs/internal/SECRET_AND_STORAGE_RELOCATION_PLAN.md"
      Write-Host "==> auth.json moved to '$targetAuth' and PI_CODING_AGENT_AUTH_DIR set."
    }
  } else {
    Write-Warning "auth.json remains in the working tree. See SECURITY.md for recommended hardening."
  }
} elseif ((Test-Path $inTreeAuth) -and $authDirEnv) {
  # -- Merge split-brain auth.json ----------------------------------------------
  # This is the "401" painpoint: PI_CODING_AGENT_AUTH_DIR is already set to a
  # secure location, but a *new* in-tree auth.json appeared (typically because
  # `pi` was run in a shell that didn't inherit PI_CODING_AGENT_AUTH_DIR, so it
  # wrote fresh creds back to the repo root). The backend reads from the secure
  # location, which is often empty {} -> 401 "invalid api key".
  # Fix: merge the in-tree creds into the secure location (in-tree wins on
  # conflict), then remove the in-tree copy.
  $secureAuthPath = Join-Path $authDirEnv 'auth.json'
  if (-not (Test-Path $secureAuthPath) -or ((Get-Item $secureAuthPath).Length -le 2)) {
    # Secure location missing or empty {} - just copy the in-tree file.
    New-Item -ItemType Directory -Path $authDirEnv -Force | Out-Null
    Copy-Item -LiteralPath $inTreeAuth -Destination $secureAuthPath -Force
    Write-Host "==> auth.json copied from working tree to secure location '$secureAuthPath' (was empty/missing)"
    Remove-Item -LiteralPath $inTreeAuth -Force
  } else {
    # Both have content - deep-merge.
    $inTreeData = Read-AuthJson $inTreeAuth
    $secureData = Read-AuthJson $secureAuthPath
    $mergedCount = 0
    foreach ($provider in $inTreeData.Keys) {
      if (-not $secureData.ContainsKey($provider) -or (Compare-Object $inTreeData[$provider] $secureData[$provider] -SyncWindow 0)) {
        $secureData[$provider] = $inTreeData[$provider]
        $mergedCount++
      }
    }
    if ($mergedCount -gt 0) {
      Write-AuthJson $secureAuthPath $secureData
      Write-Host "==> Merged $mergedCount provider(s) from working-tree auth.json into secure location '$secureAuthPath'"
      Remove-Item -LiteralPath $inTreeAuth -Force
    } else {
      Write-Host "==> Working-tree auth.json is a subset of secure auth.json; removing redundant in-tree copy"
      Remove-Item -LiteralPath $inTreeAuth -Force
    }
  }
  Write-Host "    (in-tree auth.json removed to prevent future split-brain; backend reads from PI_CODING_AGENT_AUTH_DIR)"
}

# Restore packages without updating the pinned pi CLI itself.
Write-Host "==> Running 'pi update --extensions' to restore packages from settings.json"
& $piCmd update --extensions
if ($LASTEXITCODE -ne 0) {
  Write-Warning "'pi update --extensions' exited non-zero; continue manually if needed"
}

Write-Host ""
Write-Host "Done. Open a new terminal so PI_CODING_AGENT_DIR takes effect, then run: pi"
Write-Host "Session history is stored in local '$newSessions' (git-ignored)."

# Final summary of resolved paths
Write-Host ""
Write-Host "==> Resolved storage paths:"
$resolvedAuthDir = if ($env:PI_CODING_AGENT_AUTH_DIR) { $env:PI_CODING_AGENT_AUTH_DIR } else { $repoRoot }
Write-Host "    Auth:     $(Join-Path $resolvedAuthDir 'auth.json')"
Write-Host "    Sessions: $resolvedNewSessions"
Write-Host "Session JSONL contains raw transcripts, so treat it as sensitive local data rather than something to sync/commit by default."

# Build and install the pie VSCode extension
Write-Host ""
Write-Host "==> Building pie VSCode extension"
$extensionDir = Join-Path $repoRoot 'extension'

Push-Location $repoRoot
$extensionBuildFailed = $false
try {
  # Root postinstall installs the locked extension/ and analysis/ trees too.
  npm ci --include=dev
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed for the repository dependency trees" }

  Push-Location $extensionDir
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed in extension/" }

    npm run package
    if ($LASTEXITCODE -ne 0) { throw "vsce package failed in extension/" }
  } finally {
    Pop-Location
  }

  $packageManifest = Get-Content (Join-Path $extensionDir 'package.json') -Raw | ConvertFrom-Json
  $vsixPattern = "$($packageManifest.name)-*.vsix"
  $vsix = Get-ChildItem -Path $extensionDir -Filter $vsixPattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($vsix) {
    # Resolve the VS Code CLI (code / code-insiders), probing common install
    # locations so a fresh machine without `code` on PATH still works.
    $codeCli = Resolve-CodeCli
    if (-not $codeCli) {
      Write-Warning "VS Code CLI not found on PATH or in standard install locations. Install manually: code --install-extension $($vsix.FullName)"
      $extensionBuildFailed = $true
    } else {
      $legacyExtensionId = 'pi-config.pi-assistant'
      # Best-effort cleanup of the legacy extension ID; on a fresh machine it was
      # never installed, so `code --uninstall-extension` exits 1 and writes to
      # stderr. Under $ErrorActionPreference='Stop' that would abort the whole
      # install, so swallow it explicitly (stderr suppressed; exit code ignored).
      try {
        & $codeCli --uninstall-extension $legacyExtensionId 2>$null | Out-Null
      } catch {}
      Write-Host "==> Installing $($vsix.Name) into VSCode"
      & $codeCli --install-extension $vsix.FullName
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "code CLI failed - install manually: code --install-extension $($vsix.FullName)"
        $extensionBuildFailed = $true
      }
    }
  } else {
    Write-Warning "No .vsix found after packaging - check vsce output above"
    $extensionBuildFailed = $true
  }
} catch {
  Write-Warning "Extension build failed: $_"
  $extensionBuildFailed = $true
} finally {
  Pop-Location
}

if ($extensionBuildFailed) {
  Write-Host ""
  Write-Host "==> Extension step failed or incomplete (see warnings above). If a .vsix was built, install it manually: code --install-extension <path-to-vsix>"
  if ($interactiveLaunch) {
    Write-Host ""
    Write-Host "Press Enter to close..." -ForegroundColor Yellow
    Read-Host
  }
  exit 1
}

# -- Write pie.agentDir to VS Code User settings -------------------------------
# The extension host reads pie.agentDir and forwards it to the backend as
# PI_CODING_AGENT_DIR. This is necessary because VS Code only picks up new
# User-scope env vars on a full restart (not on window reload), so relying
# on the OS env var alone means the backend falls back to ~/.pi/agent (where
# no models.json exists) until VS Code is fully restarted. Setting
# pie.agentDir in VS Code's own settings.json makes the backend use the
# correct agent dir on the very first reload after install.
$userSettingsDir = Join-Path $env:APPDATA 'Code\User'
$userSettingsPath = Join-Path $userSettingsDir 'settings.json'
if (-not (Test-Path $userSettingsDir)) {
  New-Item -ItemType Directory -Path $userSettingsDir -Force | Out-Null
}
$vsUserSettings = @{}
if (Test-Path $userSettingsPath) {
  try {
    $vsUserSettings = Read-JsonHashtable $userSettingsPath
  } catch {
    Write-Warning "Could not parse VS Code User settings.json ($userSettingsPath); will back up and recreate."
    Copy-Item $userSettingsPath "$userSettingsPath.bak.$(Get-Date -Format 'yyyyMMddHHmmss')" -Force -ErrorAction SilentlyContinue
    $vsUserSettings = @{}
  }
}
if ($vsUserSettings.'pie.agentDir' -ne $repoRoot) {
  $vsUserSettings.'pie.agentDir' = $repoRoot
  Write-Utf8NoBomFile $userSettingsPath ($vsUserSettings | ConvertTo-Json -Depth 20)
  Write-Host "==> Set pie.agentDir to '$repoRoot' in VS Code User settings ($userSettingsPath)"
} else {
  Write-Host "==> pie.agentDir already set to '$repoRoot' in VS Code User settings"
}

Write-Host ""
Write-Host "All done. Reload VSCode to activate the pie panel."

# -- Post-install readiness check --------------------------------------
# The app will start but cannot talk to any model without auth/provider keys.
# Detect the gap and tell the user exactly what to do next, so a fresh machine
# isn't left in a "starts but does nothing" state.
Write-Host ""
Write-Host "==> Post-install verification:"

# Check 1: pie.agentDir was written to VS Code User settings
$agentDirOk = $false
if ($vsUserSettings -and $vsUserSettings.'pie.agentDir' -eq $repoRoot) {
  $agentDirOk = $true
}
if ($agentDirOk) {
  Write-Host "  [OK] pie.agentDir set -> backend will read models.json from repo root"
} else {
  Write-Host "  [!] pie.agentDir not set -> models may not appear. Run the installer again or set it manually in VS Code settings."
}

# Check 2: PI_CODING_AGENT_DIR is set at User scope
$agentDirEnv = [System.Environment]::GetEnvironmentVariable('PI_CODING_AGENT_DIR', [System.EnvironmentVariableTarget]::User)
if ($agentDirEnv -eq $repoRoot) {
  Write-Host "  [OK] PI_CODING_AGENT_DIR set at User scope -> \`pi\` CLI reads repo config"
} else {
  Write-Host "  [!] PI_CODING_AGENT_DIR not set at User scope. Open a new terminal after install."
}

# Check 3: Auth - check the file the BACKEND actually reads (PI_CODING_AGENT_AUTH_DIR first)
$authDirResolved = if ($env:PI_CODING_AGENT_AUTH_DIR) { $env:PI_CODING_AGENT_AUTH_DIR } else { $repoRoot }
$backendAuthPath = Join-Path $authDirResolved 'auth.json'
$authHasContent = $false
$authProviders = @()
if (Test-Path $backendAuthPath) {
  try {
    $authJson = Read-JsonHashtable $backendAuthPath
    if ($authJson -and $authJson.Count -gt 0) {
      $authHasContent = $true
      $authProviders = $authJson.Keys
    }
  } catch {}
}
$providerEnvVars = @('ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','UMANS_API_KEY')
$providerEnvPresent = $false
foreach ($var in $providerEnvVars) {
  if ([System.Environment]::GetEnvironmentVariable($var, [System.EnvironmentVariableTarget]::User)) { $providerEnvPresent = $true; break }
}
if ($authHasContent) {
  Write-Host "  [OK] Auth credentials found ($($authProviders -join ', ')) at $backendAuthPath"
} elseif ($providerEnvPresent) {
  Write-Host "  [OK] Provider API key env var detected - pi will use it automatically."
} else {
  Write-Host "  [!] No auth.json content and no provider API key env vars found."
  Write-Host "      The pie panel will start but will get 401 / 'invalid api key' until you authenticate."
  Write-Host "      Pick ONE:"
  Write-Host "        - Set a provider API key as a User env var, e.g.:"
  Write-Host "            setx ANTHROPIC_API_KEY ``\"sk-ant-...``\"   (then open a new terminal)"
  Write-Host "        - Or run pi once interactively (then re-run this installer to merge creds):"
  Write-Host "            pi --provider umans --model umans-glm-5.2 ``\"hello``\""
  Write-Host "          (pi will prompt for an API key on first use and cache it in auth.json.)"
  Write-Host "      See README.md -> Authentication for the full list of supported providers."
}

# Check 4: Split-brain warning - in-tree auth.json with real creds but backend reads elsewhere
$inTreeAuthCheck = Join-Path $repoRoot 'auth.json'
if ((Test-Path $inTreeAuthCheck) -and $authDirResolved -ne $repoRoot) {
  try {
    $inTreeJson = Read-JsonHashtable $inTreeAuthCheck
    if ($inTreeJson -and $inTreeJson.Count -gt 0) {
      Write-Host "  [!] Split-brain: auth.json with real creds found in repo root, but backend reads from $authDirResolved"
      Write-Host "      Re-run this installer to auto-merge, or copy manually:"
      Write-Host "        Copy-Item '$inTreeAuthCheck' '$backendAuthPath' -Force"
    }
  } catch {}
}

Write-Host ""
Write-Host "==> Next steps:"
Write-Host "  1. Reload VS Code (Developer: Reload Window) to activate the pie panel."
Write-Host "  2. Open a new terminal so PI_CODING_AGENT_DIR / PI_CODING_AGENT_AUTH_DIR take effect before running \`pi\`."
Write-Host "  3. If models don't appear or you get 401, see README.md -> Troubleshooting."
if ($interactiveLaunch) {
  Write-Host ""
  Write-Host "Press Enter to close..." -ForegroundColor Yellow
  Read-Host
}
