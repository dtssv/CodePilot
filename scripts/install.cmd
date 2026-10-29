@echo off
setlocal enabledelayedexpansion
rem CodePilot installer (legacy Windows cmd.exe)
rem
rem   install.cmd [version]
rem   install.cmd v1.0.0
rem
rem Installs @codepilot/core + protocol + tui into %USERPROFILE%\.codepilot.
rem Requires Node.js >= 20 and npm. Mirrors scripts/install.sh / install.ps1.
rem Prefer install.ps1 on modern Windows; this exists for older systems.

if "%CODEPILOT_REPO%"=="" (set "REPO=dtssv/CodePilot") else (set "REPO=%CODEPILOT_REPO%")
if "%CODEPILOT_INSTALL_DIR%"=="" (set "PREFIX=%USERPROFILE%\.codepilot") else (set "PREFIX=%CODEPILOT_INSTALL_DIR%")
if "%GITHUB_API%"=="" (set "GH_API=https://api.github.com") else (set "GH_API=%GITHUB_API%")
if "%GITHUB_DL%"=="" (set "GH_DL=https://github.com") else (set "GH_DL=%GITHUB_DL%")

set "REQ_VERSION=%~1"

where node >nul 2>nul || (echo Missing required command: node & exit /b 1)
where npm  >nul 2>nul || (echo Missing required command: npm & exit /b 1)

rem --- Node >= 20 ---
for /f "delims=" %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 (
  echo Node.js ^>= 20 required.
  exit /b 1
)

rem --- Resolve tag (via node; batch can't parse JSON) ---
if not "%REQ_VERSION%"=="" (
  set "TAG=%REQ_VERSION%"
  if not "!TAG:~0,1!"=="v" set "TAG=v!TAG!"
) else (
  for /f "delims=" %%t in ('node -e "const https=require('https');https.get('%GH_API%/repos/%REPO%/releases/latest',{headers:{'User-Agent':'codepilot-install'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{process.stdout.write(JSON.parse(d).tag_name||'')}catch{process.exit(1)}})}).on('error',()=>process.exit(1))"') do set "TAG=%%t"
)
if "%TAG%"=="" (echo Failed to resolve release tag for %REPO% & exit /b 1)

set "VER=%TAG:v=%"
set "TMPDIR=%TEMP%\codepilot-install-%RANDOM%"
mkdir "%TMPDIR%" 2>nul

echo Installing CodePilot %TAG% -^> %PREFIX%

call :download codepilot-core-%VER%.tgz     || goto :fail
call :download codepilot-protocol-%VER%.tgz  || goto :fail
call :download codepilot-tui-%VER%.tgz       || goto :fail

if not exist "%PREFIX%" mkdir "%PREFIX%"
call npm install -g --prefix "%PREFIX%" "%TMPDIR%\codepilot-core-%VER%.tgz" "%TMPDIR%\codepilot-protocol-%VER%.tgz" "%TMPDIR%\codepilot-tui-%VER%.tgz"
if errorlevel 1 (echo npm install failed & goto :fail)

if not exist "%PREFIX%\codepilot-tui.cmd" (
  echo Install finished but %PREFIX%\codepilot-tui.cmd is missing.
  goto :fail
)

rem --- Add to user PATH if absent ---
echo %PATH% | find /i "%PREFIX%" >nul
if errorlevel 1 (
  for /f "tokens=2,*" %%a in ('reg query HKCU\Environment /v Path 2^>nul ^| find /i "Path"') do set "USERPATH=%%b"
  if defined USERPATH (
    setx Path "!USERPATH!;%PREFIX%" >nul
  ) else (
    setx Path "%PREFIX%" >nul
  )
  echo Added %PREFIX% to your user PATH ^(restart the terminal to pick it up^).
)

rmdir /s /q "%TMPDIR%" 2>nul
echo.
echo Done. Start with:
echo   codepilot-tui
echo   codepilot --help
exit /b 0

:download
set "NAME=%~1"
echo   downloading %NAME%
call node -e "const https=require('https');const fs=require('fs');const u='%GH_DL%/%REPO%/releases/download/%TAG%/%NAME%';function get(url){https.get(url,r=>{if(r.statusCode>=300&&r.statusCode<400&&r.headers.location)return get(r.headers.location);if(r.statusCode!==200){console.error('HTTP '+r.statusCode);process.exit(1)}const f=fs.createWriteStream(process.argv[1]);r.pipe(f);f.on('finish',()=>f.close())}).on('error',e=>{console.error(e.message);process.exit(1)})}get(u)" "%TMPDIR%\%NAME%"
if errorlevel 1 (echo Download failed: %NAME% & exit /b 1)
exit /b 0

:fail
rmdir /s /q "%TMPDIR%" 2>nul
exit /b 1
