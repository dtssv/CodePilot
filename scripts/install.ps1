# CodePilot installer (Windows PowerShell)
#
#   irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1))) -Version v1.0.0
#
# Installs self-contained CodePilot binaries (TUI + CLI) into %USERPROFILE%\.codepilot\bin.
# No Node.js or npm required — the binaries embed their own runtime. Mirrors scripts/install.sh.
#
# Install from a local build (for testing a release before it is published):
#   $env:PACKAGE_TARGETS="win"; corepack pnpm package:cli; corepack pnpm package:tui
#   $env:CODEPILOT_DIST_DIR="dist/release"; .\scripts\install.ps1

[CmdletBinding()]
param(
  [Alias('v')]
  [string]$Version = "",
  [switch]$NoModifyPath,
  [switch]$Help
)

$ErrorActionPreference = "Stop"

$Repo      = if ($env:CODEPILOT_REPO) { $env:CODEPILOT_REPO } else { "dtssv/CodePilot" }
$Prefix    = if ($env:CODEPILOT_INSTALL_DIR) { $env:CODEPILOT_INSTALL_DIR } else { Join-Path $HOME ".codepilot" }
$BinDir    = Join-Path $Prefix "bin"
$GithubApi = if ($env:GITHUB_API) { $env:GITHUB_API } else { "https://api.github.com" }
$GithubDl  = if ($env:GITHUB_DL) { $env:GITHUB_DL } else { "https://github.com" }
# Point at a local dist/release tree to install from a local build (no network).
$DistDir   = if ($env:CODEPILOT_DIST_DIR) { $env:CODEPILOT_DIST_DIR } else { "" }

function Show-Usage {
  @"
Install CodePilot (self-contained TUI + CLI binaries — no Node.js required)

Usage:
  irm .../install.ps1 | iex
  & ([scriptblock]::Create((irm .../install.ps1))) -Version v1.0.0

Options:
  -Version <tag>    Install a specific release (e.g. v1.0.0). Default: latest
  -NoModifyPath     Do not edit the user PATH
  -Help             Show this help

Environment:
  CODEPILOT_REPO          GitHub owner/repo (default: dtssv/CodePilot)
  CODEPILOT_INSTALL_DIR   Install prefix (default: %USERPROFILE%\.codepilot)
  CODEPILOT_DIST_DIR      Install from a local dist/release tree instead of a
                          GitHub release (for testing an unpublished build)
"@ | Write-Host
}

if ($Help) { Show-Usage; exit 0 }

function Fail($msg) { Write-Host "Error: $msg" -ForegroundColor Red; exit 1 }

# Map the host to CodePilot's binary suffix (matches scripts/package _util.mjs):
# win-<arch>.exe. Windows releases ship x64 and arm64 binaries.
function Resolve-Target {
  $arch = $env:PROCESSOR_ARCHITECTURE
  switch -Wildcard ($arch) {
    "ARM64" { return "win-arm64" }
    "AMD64" { return "win-x64" }
    "x86"   { return "win-x64" }  # 32-bit shell on 64-bit OS; ship x64
    default { Fail "Unsupported architecture: $arch" }
  }
}

function Resolve-Tag {
  if ($Version) {
    if ($Version.StartsWith("v")) { return $Version }
    return "v$Version"
  }
  $json = Invoke-RestMethod -Uri "$GithubApi/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "codepilot-install" }
  if (-not $json.tag_name) { Fail "Failed to resolve latest release for $Repo" }
  return $json.tag_name
}

function Install-FromDist {
  $target = Resolve-Target
  $cliSrc = Join-Path $DistDir "cli\codepilot-$target.exe"
  $tuiSrc = Join-Path $DistDir "tui\codepilot-tui-$target.exe"
  $webSrc = Join-Path $DistDir "cli\web"
  if (-not (Test-Path $tuiSrc)) { Fail "Missing $tuiSrc — run: corepack pnpm package:tui" }
  if (-not (Test-Path $cliSrc)) { Fail "Missing $cliSrc — run: corepack pnpm package:cli" }

  Write-Host "Installing CodePilot (local dist, $target) -> $Prefix"
  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  Copy-Item $tuiSrc (Join-Path $BinDir "codepilot-tui.exe") -Force
  Copy-Item $cliSrc (Join-Path $BinDir "codepilot.exe") -Force
  if (Test-Path $webSrc) {
    $webDst = Join-Path $BinDir "web"
    if (Test-Path $webDst) { Remove-Item -Recurse -Force $webDst }
    Copy-Item $webSrc $webDst -Recurse -Force
  }
}

function Install-FromRelease {
  $target = Resolve-Target
  $tag = Resolve-Tag
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("codepilot-install-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Write-Host "Installing CodePilot $tag ($target) -> $Prefix"
    $base = "$GithubDl/$Repo/releases/download/$tag"
    $assets = @{
      "$base/codepilot-tui-$target.exe"   = Join-Path $tmp "codepilot-tui.exe"
      "$base/codepilot-$target.exe"       = Join-Path $tmp "codepilot.exe"
      "$base/codepilot-web-$target.tar.gz" = Join-Path $tmp "web.tar.gz"
    }
    foreach ($url in $assets.Keys) {
      $out = $assets[$url]
      Write-Host "  downloading $(Split-Path $url -Leaf)"
      try {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
      } catch {
        Fail "Download failed: $url`nSee $GithubDl/$Repo/releases"
      }
    }

    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Copy-Item (Join-Path $tmp "codepilot-tui.exe") (Join-Path $BinDir "codepilot-tui.exe") -Force
    Copy-Item (Join-Path $tmp "codepilot.exe") (Join-Path $BinDir "codepilot.exe") -Force
    $webDst = Join-Path $BinDir "web"
    if (Test-Path $webDst) { Remove-Item -Recurse -Force $webDst }
    New-Item -ItemType Directory -Path $webDst -Force | Out-Null
    & tar -xzf (Join-Path $tmp "web.tar.gz") -C $webDst
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Confirm-Install {
  $tui = Join-Path $BinDir "codepilot-tui.exe"
  if (-not (Test-Path $tui)) {
    Fail "Install finished but $tui is missing"
  }
  Write-Host "Bins:"
  Get-ChildItem (Join-Path $BinDir "codepilot*") | ForEach-Object { Write-Host "  $($_.FullName)" }
}

function Add-ToUserPath {
  if ($NoModifyPath) { return }
  $target = $BinDir
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -and ($userPath.Split(';') -contains $target)) { return }
  $newPath = if ($userPath) { "$userPath;$target" } else { $target }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  $env:Path = "$env:Path;$target"
  Write-Host "Added $target to your user PATH (restart the terminal for it to take effect everywhere)."
}

if ($DistDir) { Install-FromDist } else { Install-FromRelease }
Confirm-Install
Add-ToUserPath

Write-Host ""
Write-Host "Done. Start with:"
Write-Host "  codepilot-tui"
Write-Host "  codepilot --help"
Write-Host ""
