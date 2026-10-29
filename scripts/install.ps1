# CodePilot installer (Windows PowerShell)
#
#   irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.ps1))) -Version v1.0.0
#
# Installs @codepilot/core + protocol + tui into %USERPROFILE%\.codepilot (npm prefix).
# Requires Node.js >= 20 and npm. Mirrors scripts/install.sh.

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

function Show-Usage {
  @"
Install CodePilot (CLI + TUI) on Windows

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
"@ | Write-Host
}

if ($Help) { Show-Usage; exit 0 }

function Fail($msg) { Write-Host "Error: $msg" -ForegroundColor Red; exit 1 }

function Test-Cmd($name) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    Fail "Missing required command: $name"
  }
}

function Test-Node {
  Test-Cmd node
  Test-Cmd npm
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 20) {
    Fail "Node.js >= 20 required (found $(& node -v))"
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

function Install-Packages {
  $tag = Resolve-Tag
  $ver = $tag -replace '^v', ''
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("codepilot-install-" + [System.Guid]::NewGuid().ToString("N").Substring(0, 8))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  try {
    Write-Host "Installing CodePilot $tag -> $Prefix"

    $names = @(
      "codepilot-core-$ver.tgz",
      "codepilot-protocol-$ver.tgz",
      "codepilot-tui-$ver.tgz"
    )
    $paths = @()
    foreach ($name in $names) {
      $url = "$GithubDl/$Repo/releases/download/$tag/$name"
      $out = Join-Path $tmp $name
      Write-Host "  downloading $name"
      try {
        Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
      } catch {
        Fail "Download failed: $url`nSee $GithubDl/$Repo/releases"
      }
      $paths += $out
    }

    New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
    & npm install -g --prefix "$Prefix" @paths
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)" }

    # On Windows, npm --prefix puts .cmd shims directly in $Prefix (not $Prefix\bin).
    $shim = $null
    foreach ($cand in @((Join-Path $Prefix "codepilot-tui.cmd"), (Join-Path $BinDir "codepilot-tui"))) {
      if (Test-Path $cand) { $shim = $cand; break }
    }
    if (-not $shim) {
      Fail "Install finished but codepilot-tui shim was not found under $Prefix"
    }
    Write-Host "Installed shims under $Prefix"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

function Add-ToUserPath {
  if ($NoModifyPath) { return }
  # npm global shims on Windows land in the prefix root.
  $target = $Prefix
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -and ($userPath.Split(';') -contains $target)) { return }
  $newPath = if ($userPath) { "$userPath;$target" } else { $target }
  [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  # Make it available in the current session too.
  $env:Path = "$env:Path;$target"
  Write-Host "Added $target to your user PATH (restart the terminal for it to take effect everywhere)."
}

Test-Node
Install-Packages
Add-ToUserPath

Write-Host ""
Write-Host "Done. Start with:"
Write-Host "  codepilot-tui"
Write-Host "  codepilot --help"
Write-Host ""
