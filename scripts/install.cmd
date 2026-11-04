@echo off
setlocal
rem CodePilot installer (legacy Windows cmd.exe shim)
rem
rem   install.cmd [version]
rem   install.cmd v1.0.0
rem
rem The installer logic lives in install.ps1 (downloads self-contained binaries,
rem no Node.js required). This shim just hands off to PowerShell, which ships on
rem every supported Windows version. Prefer running install.ps1 directly.

set "HERE=%~dp0"
set "PS1=%HERE%install.ps1"

if not exist "%PS1%" (
  echo Could not find install.ps1 next to this script.
  echo Run the PowerShell installer directly:
  echo   irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1 ^| iex
  exit /b 1
)

where powershell >nul 2>nul || (
  echo Missing required command: powershell
  exit /b 1
)

if "%~1"=="" (
  powershell -ExecutionPolicy Bypass -NoProfile -File "%PS1%"
) else (
  powershell -ExecutionPolicy Bypass -NoProfile -File "%PS1%" -Version "%~1"
)
exit /b %ERRORLEVEL%
