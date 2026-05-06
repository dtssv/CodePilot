@echo off
REM codePilot-reset — external reset helper for Windows (run when IDE is frozen)
REM Usage: codePilot-reset.cmd [soft|hard|factory]

set ROOT=%USERPROFILE%\.codePilot
set FLAGS=%ROOT%\flags
if not exist "%FLAGS%" mkdir "%FLAGS%"

if "%~1"=="" goto soft
if /I "%~1"=="soft" goto soft
if /I "%~1"=="hard" goto hard
if /I "%~1"=="factory" goto factory
echo Usage: %~nx0 [soft^|hard^|factory]
exit /b 1

:soft
echo Writing soft-reset sentinel...
type nul > "%FLAGS%\reset_soft"
echo Done. Restart the IDE; credentials will be cleared.
goto end

:hard
echo Writing hard-local reset sentinel...
type nul > "%FLAGS%\reset_hard_local"
echo Done. Next IDE start will rename .codePilot to .codePilot.broken-xxx and start clean.
goto end

:factory
echo Writing factory-reset sentinel...
type nul > "%FLAGS%\reset_factory"
echo Done. Next IDE start will move .codePilot, clear PasswordSafe credentials, and start fresh.
goto end

:end