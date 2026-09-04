@echo off
REM ============================================================================
REM  install.bat -- Bootstrap the pie portable coding-agent config on Windows.
REM
REM  Native Windows (cmd.exe) port of the former install.ps1. It does NOT require
REM  PowerShell, WSL, Git Bash, or any Unix tools: only cmd built-ins, node/npm,
REM  and the shared Node runner (scripts/install/run.mjs) which holds the
REM  cross-platform business logic. winget/icacls/reg/where are native Windows
REM  utilities used only where a cmd built-in cannot do the job.
REM
REM  Run once after cloning:
REM    install.bat            (full install)
REM    install.bat --check    (dry run: verify toolchain + readiness, mutate nothing)
REM    install.bat --help
REM
REM  Double-clickable: pauses before exiting so the window stays open.
REM ============================================================================

setlocal enableextensions

REM Repo root = this script's directory, trailing backslash stripped.
set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "RUNNER=%REPO_ROOT%\scripts\install\run.mjs"

REM --- parse arguments -------------------------------------------------------
set "MODE=install"
:parse_args
if "%~1"=="" goto :args_done
if /i "%~1"=="--help" goto :pa_help
if /i "%~1"=="-h" goto :pa_help
if /i "%~1"=="--check" goto :pa_check
if /i "%~1"=="--no-pause" goto :pa_nopause
echo Unknown argument: %~1 1>&2
shift
goto :parse_args
:pa_help
set "MODE=help" & shift & goto :parse_args
:pa_check
set "MODE=check" & shift & goto :parse_args
:pa_nopause
set "NO_PAUSE=1" & shift & goto :parse_args
:args_done

if "%MODE%"=="help" goto :help

REM --- detect a double-click launch so we can pause before the window closes --
REM  When launched by double-click, a fresh cmd /c runs this script, so
REM  %CMDCMDLINE% contains the script name. An existing terminal's %CMDCMDLINE%
REM  is just its cmd.exe path. CI runs and --no-pause skip the pause entirely.
set "INTERACTIVE=0"
if defined CI goto :detect_done
if defined NO_PAUSE goto :detect_done
echo %CMDCMDLINE% | find /i "%~nx0" >nul && set "INTERACTIVE=1"
:detect_done

if "%MODE%"=="check" goto :check

REM ===========================================================================
REM  FULL INSTALL
REM ===========================================================================

echo ==^> Setting PI_CODING_AGENT_DIR to '%REPO_ROOT%'
call :setx_user PI_CODING_AGENT_DIR "%REPO_ROOT%" || goto :error
set "PI_CODING_AGENT_DIR=%REPO_ROOT%"

REM --- migrate auth.json from the old default location if needed -------------
set "OLD_AUTH=%USERPROFILE%\.pi\agent\auth.json"
set "NEW_AUTH=%REPO_ROOT%\auth.json"
if exist "%OLD_AUTH%" (
  if not exist "%NEW_AUTH%" (
    echo ==^> Migrating auth.json from '%OLD_AUTH%'
    copy /y "%OLD_AUTH%" "%NEW_AUTH%" >nul || goto :error
  )
) else (
  if exist "%NEW_AUTH%" (
    echo ==^> auth.json already present in repo - skipping migration
  ) else (
    echo ==^> No existing auth.json found - you will need to authenticate PI on first run
  )
)

REM --- session store env var (User scope) + warn if it points elsewhere ------
REM Capture both authorities: an invoking shell may override the User value.
set "PROCESS_SESSION_DIR=%PI_CODING_AGENT_SESSION_DIR%"
set "NEW_SESSIONS=%REPO_ROOT%\data\outcomes\sessions"
call :read_user_env PI_CODING_AGENT_SESSION_DIR
set "EXISTING_SESSION_DIR=%USER_ENV_VALUE%"
if defined EXISTING_SESSION_DIR (
  if /i not "%EXISTING_SESSION_DIR%"=="%NEW_SESSIONS%" (
    echo ==^> WARN: PI_CODING_AGENT_SESSION_DIR is set to '%EXISTING_SESSION_DIR%'. Replacing it with this machine-local checkout store at '%NEW_SESSIONS%'.
  )
)
call :setx_user PI_CODING_AGENT_SESSION_DIR "%NEW_SESSIONS%" || goto :error
set "PI_CODING_AGENT_SESSION_DIR=%NEW_SESSIONS%"
echo ==^> PI_CODING_AGENT_SESSION_DIR uses the machine-local store at '%NEW_SESSIONS%'

REM --- validate prerequisites (Node first so a node-less box fails cleanly) --
call :check_node
if "%NODE_MISSING%"=="1" goto :no_node
where npm >nul 2>nul || goto :no_npm

REM --- settings.json#sessionDir rewrite + global outcomes migration ----------
REM  Preserve reviews and run analytics alongside transcripts when repairing a
REM  displaced session authority. Derived exports/open checkpoints are rebuilt.
if defined PROCESS_SESSION_DIR (
  node "%REPO_ROOT%\scripts\migrate-outcomes-store.mjs" --source-session-dir "%PROCESS_SESSION_DIR%" --dest "%REPO_ROOT%\data\outcomes" || goto :error
)
if defined EXISTING_SESSION_DIR if /i not "%EXISTING_SESSION_DIR%"=="%PROCESS_SESSION_DIR%" (
  node "%REPO_ROOT%\scripts\migrate-outcomes-store.mjs" --source-session-dir "%EXISTING_SESSION_DIR%" --dest "%REPO_ROOT%\data\outcomes" || goto :error
)
REM  Batch cannot parse/rewrite JSON; the shared runner owns legacy transcript
REM  migration and the canonical settings.json rewrite.
node "%RUNNER%" configure-sessions "%REPO_ROOT%" || goto :error

REM --- pinned Node/npm/pi versions ------------------------------------------
for /f "delims=" %%L in ('node "%RUNNER%" pinned-versions 2^>nul') do if not defined PIN_NODE set "PIN_NODE=%%L"
for /f "skip=1 delims=" %%L in ('node "%RUNNER%" pinned-versions 2^>nul') do if not defined PIN_NPM set "PIN_NPM=%%L"
for /f "skip=2 delims=" %%L in ('node "%RUNNER%" pinned-versions 2^>nul') do if not defined PIN_PI set "PIN_PI=%%L"
if not defined PIN_NODE goto :pins_failed
if not defined PIN_NPM goto :pins_failed
if not defined PIN_PI goto :pins_failed

if /i not "%NODE_VERSION%"=="%PIN_NODE%" (
  echo ==^> Node.js %PIN_NODE% is required for reproducible installs; found %NODE_VERSION%. Use .nvmrc/.node-version.
  goto :error
)
for /f "delims=" %%V in ('npm --version 2^>nul') do set "ACTUAL_NPM=%%V"
if /i not "%ACTUAL_NPM%"=="%PIN_NPM%" (
  echo ==^> Installing pinned npm@%PIN_NPM% (found %ACTUAL_NPM%)
  call npm install -g "npm@%PIN_NPM%" || goto :error
)

REM --- resolve + pin the pi CLI ---------------------------------------------
set "PI_CMD="
for /f "delims=" %%P in ('node "%RUNNER%" resolve-pi 2^>nul') do set "PI_CMD=%%P"
if not defined PI_CMD goto :install_pi
call "%PI_CMD%" --version > "%TEMP%\pie_piver.txt" 2>&1
set "INSTALLED_PI="
set /p INSTALLED_PI=<"%TEMP%\pie_piver.txt"
del "%TEMP%\pie_piver.txt" >nul 2>nul
if /i not "%INSTALLED_PI%"=="%PIN_PI%" goto :install_pi
echo ==^> pi CLI is pinned at %PIN_PI%
goto :pi_done
:install_pi
echo ==^> Installing pinned @earendil-works/pi-coding-agent@%PIN_PI% (found '%INSTALLED_PI%')
call npm install -g "@earendil-works/pi-coding-agent@%PIN_PI%" || goto :error
set "PI_CMD="
for /f "delims=" %%P in ('node "%RUNNER%" resolve-pi 2^>nul') do set "PI_CMD=%%P"
if not defined PI_CMD (
  echo ==^> @earendil-works/pi-coding-agent installed but 'pi' could not be resolved on PATH or under the npm prefix. Open a new terminal and re-run.
  goto :error
)
echo ==^> Installed pi %PIN_PI% to '%PI_CMD%'
:pi_done

REM --- repair absolute extension paths in settings.json ---------------------
node "%RUNNER%" repair-settings "%REPO_ROOT%\settings.json" || goto :error

REM --- relocate auth.json out of the working tree ---------------------------
set "IN_TREE_AUTH=%REPO_ROOT%\auth.json"
set "TARGET_AUTH_DIR=%LOCALAPPDATA%\pie"
set "TARGET_AUTH=%TARGET_AUTH_DIR%\auth.json"
if not exist "%IN_TREE_AUTH%" goto :after_relocate
call :read_user_env PI_CODING_AGENT_AUTH_DIR
set "AUTH_DIR_ENV=%USER_ENV_VALUE%"
if defined AUTH_DIR_ENV goto :merge_auth
echo.
echo ==^> SECURITY: auth.json is inside the working tree.
echo     Target location: %TARGET_AUTH%
set "MOVE_CHOICE="
if defined CI ( set "MOVE_CHOICE=Y" ) else set /p MOVE_CHOICE="    Move auth.json to the secure OS user-data directory? [Y/n] "
if /i "%MOVE_CHOICE%"=="Y" goto :do_relocate
if "%MOVE_CHOICE%"=="" goto :do_relocate
echo ==^> WARN: auth.json remains in the working tree. See SECURITY.md for recommended hardening.
goto :after_relocate
:do_relocate
node "%RUNNER%" relocate-auth "%IN_TREE_AUTH%" "%TARGET_AUTH%" || goto :error
icacls "%TARGET_AUTH%" /inheritance:r /grant:r "%USERDOMAIN%\%USERNAME%:F" >nul 2>&1
if errorlevel 1 echo ==^> WARN: could not restrict ACLs on '%TARGET_AUTH%' - continuing; LOCALAPPDATA is already user-private
call :setx_user PI_CODING_AGENT_AUTH_DIR "%TARGET_AUTH_DIR%" || goto :error
set "PI_CODING_AGENT_AUTH_DIR=%TARGET_AUTH_DIR%"
del "%IN_TREE_AUTH%" >nul 2>nul
> "%REPO_ROOT%\auth.json.removed" (
  echo Relocated to: %TARGET_AUTH%
  echo See: SECURITY.md
)
echo ==^> auth.json moved to '%TARGET_AUTH%' and PI_CODING_AGENT_AUTH_DIR set.
goto :after_relocate
:merge_auth
set "SECURE_AUTH=%AUTH_DIR_ENV%\auth.json"
node "%RUNNER%" merge-auth "%IN_TREE_AUTH%" "%SECURE_AUTH%" || goto :error
echo     in-tree auth.json removed to prevent future split-brain; backend reads from PI_CODING_AGENT_AUTH_DIR
:after_relocate

REM --- restore pi packages without self-updating the CLI --------------------
echo ==^> Running 'pi update --extensions' to restore packages from settings.json
call "%PI_CMD%" update --extensions
if errorlevel 1 echo ==^> WARN: 'pi update --extensions' exited non-zero; continue manually if needed

REM --- build, package, and install the pie VSCode extension ----------------
echo.
echo ==^> Building pie VSCode extension
set "EXTENSION_DIR=%REPO_ROOT%\extension"
set "EXT_FAILED=0"
pushd "%REPO_ROOT%"
call npm ci --include=dev || set "EXT_FAILED=1"
if "%EXT_FAILED%"=="1" ( popd & echo ==^> npm ci failed for the repository dependency trees & goto :ext_failed )
pushd "%EXTENSION_DIR%"
call npm run build || set "EXT_FAILED=1"
if "%EXT_FAILED%"=="1" ( popd & popd & echo ==^> build failed in extension/ & goto :ext_failed )
call npm run package || set "EXT_FAILED=1"
popd
popd
if "%EXT_FAILED%"=="1" ( echo ==^> vsce package failed in extension/ & goto :ext_failed )

set "VSIX="
set "VSIX_NAME="
for /f "delims=" %%F in ('dir /b /o-d "%EXTENSION_DIR%\pie-*.vsix" 2^>nul') do ( set "VSIX=%EXTENSION_DIR%\%%F" & set "VSIX_NAME=%%F" & goto :vsix_found )
:vsix_found
if not defined VSIX (
  echo ==^> WARN: No .vsix found after packaging - check vsce output above
  goto :ext_failed
)
call :resolve_code_cli
if not defined CODE_CLI (
  echo ==^> WARN: VS Code CLI not found on PATH or in standard install locations. Install manually: code --install-extension "%VSIX%"
  goto :ext_failed
)
call "%CODE_CLI%" --uninstall-extension pi-config.pi-assistant >nul 2>nul
echo ==^> Installing %VSIX_NAME% into VSCode
call "%CODE_CLI%" --install-extension "%VSIX%" || (
  echo ==^> WARN: code CLI failed - install manually: code --install-extension "%VSIX%"
  goto :ext_failed
)

REM --- write pie.agentDir to VS Code User settings --------------------------
node "%RUNNER%" write-vscode-agent-dir "%REPO_ROOT%" || goto :error

REM The old backend may have remained alive during build/install with its stale
REM process environment. Reconcile displaced authorities once more; merging is
REM append-only and idempotent. Doctor detects any writes made after this pass.
if defined PROCESS_SESSION_DIR (
  echo ==^> Finalizing process-level displaced outcomes after extension installation
  node "%REPO_ROOT%\scripts\migrate-outcomes-store.mjs" --source-session-dir "%PROCESS_SESSION_DIR%" --dest "%REPO_ROOT%\data\outcomes" || goto :error
)
if defined EXISTING_SESSION_DIR if /i not "%EXISTING_SESSION_DIR%"=="%PROCESS_SESSION_DIR%" (
  echo ==^> Finalizing user-level displaced outcomes after extension installation
  node "%REPO_ROOT%\scripts\migrate-outcomes-store.mjs" --source-session-dir "%EXISTING_SESSION_DIR%" --dest "%REPO_ROOT%\data\outcomes" || goto :error
)

echo.
echo All done. Reload VSCode to activate the pie panel.

REM --- post-install readiness check ----------------------------------------
echo.
echo ==^> Post-install verification:
call :read_user_env PI_CODING_AGENT_DIR
set "USER_AGENT_DIR=%USER_ENV_VALUE%"
if /i "%USER_AGENT_DIR%"=="%REPO_ROOT%" (
  echo   [OK] PI_CODING_AGENT_DIR set at User scope -^> pi CLI reads repo config
) else (
  echo   [!] PI_CODING_AGENT_DIR not set at User scope. Open a new terminal after install.
)
call :readiness_check

echo.
echo ==^> Resolved storage paths:
set "RESOLVED_AUTH_DIR=%REPO_ROOT%"
if defined PI_CODING_AGENT_AUTH_DIR set "RESOLVED_AUTH_DIR=%PI_CODING_AGENT_AUTH_DIR%"
echo     Auth:     %RESOLVED_AUTH_DIR%\auth.json
echo     Sessions: %NEW_SESSIONS%
echo Session JSONL contains raw transcripts, so treat it as sensitive local data rather than something to sync/commit by default.

echo.
echo ==^> Next steps:
echo   1. Reload VS Code (Developer: Reload Window) to activate the pie panel.
echo   2. Open a new terminal so PI_CODING_AGENT_DIR / PI_CODING_AGENT_AUTH_DIR take effect before running pi.
echo   3. If models don't appear or you get 401, see README.md -^> Troubleshooting.

goto :done

REM ===========================================================================
REM  --check : dry run (read-only; never setx / install / build)
REM ===========================================================================
:check
echo ==^> install.bat --check - dry run: nothing will be installed or mutated
echo.
call :check_node
if "%NODE_MISSING%"=="1" ( call :node_hint & exit /b 1 )
where npm >nul 2>nul || ( echo ==^> npm not found on PATH; npm ships with Node.js - install Node.js first. & exit /b 1 )
echo ==^> Checking pinned toolchain...
node "%RUNNER%" verify-toolchain
set "TOOLCHAIN_RC=%ERRORLEVEL%"
echo.
echo ==^> Auth/readiness check...
call :readiness_check
echo.
echo ==^> Would-do - run install.bat without --check to perform these:
echo   - setx PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR at User scope
echo   - configure global outcomes: sessions + reviews + completed run analytics
echo   - repair extension paths in settings.json
echo   - relocate/merge auth.json if present
echo   - npm install -g pinned npm/pi if drifted
echo   - pi update --extensions
echo   - npm ci + build/package pie VSIX + code --install-extension
echo   - write pie.agentDir to VS Code User settings
exit /b %TOOLCHAIN_RC%

REM ===========================================================================
REM  labels / subroutines
REM ===========================================================================
:ext_failed
echo.
echo ==^> Extension step failed or incomplete - see warnings above. If a .vsix was built, install it manually with: code --install-extension PATH
echo.
echo ==^> INSTALL FAILED.
if "%INTERACTIVE%"=="1" if not defined NO_PAUSE (
  echo.
  pause
)
exit /b 1

:no_node
call :node_hint
goto :error

:no_npm
echo ==^> npm is required but was not found on PATH. npm ships with Node.js: https://nodejs.org/
goto :error

:pins_failed
echo ==^> Could not resolve the pinned toolchain versions - node/npm/pi.
goto :error

:node_hint
set "PIN_NODE_HINT="
if exist "%REPO_ROOT%\.node-version" for /f "delims=" %%V in ('type "%REPO_ROOT%\.node-version"') do set "PIN_NODE_HINT=%%V"
if "%PIN_NODE_HINT:~0,1%"=="v" set "PIN_NODE_HINT=%PIN_NODE_HINT:~1%"
echo.
echo ==^> Node.js is required but was not found on PATH.
if defined PIN_NODE_HINT (
  echo     Install Node.js %PIN_NODE_HINT%, pinned by .node-version:
  echo       winget install OpenJS.NodeJS.LTS --version %PIN_NODE_HINT%
  echo     or download it from https://nodejs.org/ and pick the exact %PIN_NODE_HINT% build.
) else (
  echo     Install Node.js - the version in .node-version - from https://nodejs.org/
)
echo     Then open a new terminal and re-run install.bat.
exit /b 0

:check_node
REM Sets NODE_VERSION (leading 'v' stripped) and NODE_MISSING=1 if absent.
set "NODE_VERSION="
set "NODE_MISSING=0"
where node >nul 2>nul || ( set "NODE_MISSING=1" & exit /b 0 )
for /f "delims=" %%V in ('node --version 2^>nul') do set "NODE_VERSION=%%V"
if "%NODE_VERSION:~0,1%"=="v" set "NODE_VERSION=%NODE_VERSION:~1%"
exit /b 0

:resolve_code_cli
REM Sets CODE_CLI to the VS Code CLI (code / code-insiders), probing PATH then
REM the common per-machine install dirs. Empty if not found.
set "CODE_CLI="
where code >nul 2>nul && ( set "CODE_CLI=code" & exit /b 0 )
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" ( set "CODE_CLI=%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code.cmd" & exit /b 0 )
if exist "%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd" ( set "CODE_CLI=%LOCALAPPDATA%\Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd" & exit /b 0 )
if exist "C:\Program Files\Microsoft VS Code\bin\code.cmd" ( set "CODE_CLI=C:\Program Files\Microsoft VS Code\bin\code.cmd" & exit /b 0 )
if exist "C:\Program Files\Microsoft VS Code Insiders\bin\code-insiders.cmd" ( set "CODE_CLI=C:\Program Files\Microsoft VS Code Insiders\bin\code-insiders.cmd" & exit /b 0 )
exit /b 0

:readiness_check
REM Computes provider-env-present at Windows User scope (registry) and runs the
REM shared readiness check (auth content, split-brain, pie.agentDir). Read-only.
set "AUTH_DIR_RESOLVED=%REPO_ROOT%"
if defined PI_CODING_AGENT_AUTH_DIR set "AUTH_DIR_RESOLVED=%PI_CODING_AGENT_AUTH_DIR%"
set "BACKEND_AUTH=%AUTH_DIR_RESOLVED%\auth.json"
set "PROVIDER_ENV_PRESENT=0"
for %%P in (ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY) do call :check_provider %%P
node "%RUNNER%" readiness --auth "%BACKEND_AUTH%" --in-tree-auth "%REPO_ROOT%\auth.json" --auth-dir "%AUTH_DIR_RESOLVED%" --repo-root "%REPO_ROOT%" --provider-env-present %PROVIDER_ENV_PRESENT% --vscode-agent-dir-expected "%REPO_ROOT%"
exit /b %ERRORLEVEL%

:check_provider
call :read_user_env %1
if defined USER_ENV_VALUE set "PROVIDER_ENV_PRESENT=1"
exit /b 0

:setx_user
REM %1 = var name, %2 = value. Persists at User scope (setx) + current process.
REM Use `call` so a .cmd wrapper (or test shim) returns cleanly instead of
REM corrupting the subroutine call frame.
call setx %1 "%~2" >nul
if errorlevel 1 exit /b 1
set "%1=%~2"
exit /b 0

:read_user_env
REM %1 = var name. Sets USER_ENV_VALUE to its User-scope value, or unsets it.
set "USER_ENV_VALUE="
for /f "tokens=2,*" %%a in ('reg query "HKCU\Environment" /v %1 2^>nul ^| findstr /i "REG_SZ REG_EXPAND_SZ"') do set "USER_ENV_VALUE=%%b"
exit /b 0

:help
echo Usage: install.bat [--check] [--help] [--no-pause]
echo.
echo   no args    Full install: configure env/sessions, pin Node/npm/pi, relocate
echo              auth, restore packages, build and install the pie VS Code extension.
echo   --check    Dry run: verify the pinned toolchain and readiness without mutating
echo              anything - no setx, no installs, no builds.
echo   --help     Show this help and exit.
echo   --no-pause Do not pause before exiting - for scripted use.
echo.
echo Requires Node.js on PATH, pinned by .node-version. If Node is absent, --check
echo or a full run prints the exact winget/download command to install it.
exit /b 0

:done
if "%INTERACTIVE%"=="1" if not defined NO_PAUSE (
  echo.
  pause
)
exit /b 0

:error
echo.
echo ==^> INSTALL FAILED.
if "%INTERACTIVE%"=="1" if not defined NO_PAUSE (
  echo.
  pause
)
exit /b 1
