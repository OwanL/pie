@echo off
setlocal EnableExtensions DisableDelayedExpansion

rem Keep the supervisor in this console: Ctrl+C must be delivered to the Node
rem child as well as to the supervisor's containment handler.
set "PIE_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PIE_POWERSHELL%" (
  echo Pie standalone requires Windows PowerShell 5.1: "%PIE_POWERSHELL%" 1>&2
  endlocal & exit /b 1
)

"%PIE_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-pie-supervisor.ps1" %*
set "PIE_EXIT=%ERRORLEVEL%"
endlocal & exit /b %PIE_EXIT%
