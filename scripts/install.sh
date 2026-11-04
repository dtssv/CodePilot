#!/usr/bin/env bash
# CodePilot installer (macOS / Linux / Windows Git Bash / WSL)
#
#   curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash -s -- --version v1.0.0
#
# Installs self-contained CodePilot binaries (TUI + CLI) into ~/.codepilot/bin.
# No Node.js or npm required — the binaries embed their own runtime.
#
# Install from a local build (for testing a release before it is published):
#   PACKAGE_TARGETS=mac corepack pnpm package:cli && corepack pnpm package:tui
#   CODEPILOT_DIST_DIR=dist/release scripts/install.sh
#
set -euo pipefail

REPO="${CODEPILOT_REPO:-dtssv/CodePilot}"
PREFIX="${CODEPILOT_INSTALL_DIR:-$HOME/.codepilot}"
BIN_DIR="$PREFIX/bin"
GITHUB_API="${GITHUB_API:-https://api.github.com}"
GITHUB_DL="${GITHUB_DL:-https://github.com}"
# Point at a local `dist/release` tree to install from a local build instead of
# a GitHub release (no network). Expects dist/release/{cli,tui}/… layout.
DIST_DIR="${CODEPILOT_DIST_DIR:-}"

RED='\033[0;31m'
MUTED='\033[0;2m'
NC='\033[0m'

usage() {
  cat <<EOF
Install CodePilot (self-contained TUI + CLI binaries — no Node.js required)

Usage:
  curl -fsSL …/install.sh | bash
  curl -fsSL …/install.sh | bash -s -- [options]

Options:
  -v, --version <tag>   Install a specific release (e.g. v1.0.0). Default: latest
  --no-modify-path      Do not edit shell rc files
  -h, --help            Show this help

Environment:
  CODEPILOT_REPO          GitHub owner/repo (default: dtssv/CodePilot)
  CODEPILOT_INSTALL_DIR   Install prefix (default: ~/.codepilot)
  CODEPILOT_DIST_DIR      Install from a local dist/release tree instead of a
                          GitHub release (for testing an unpublished build)
EOF
}

requested_version="${VERSION:-}"
no_modify_path=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    -v|--version)
      [[ -n "${2:-}" ]] || { echo -e "${RED}Error: --version needs a value${NC}" >&2; exit 1; }
      requested_version="$2"; shift 2 ;;
    --no-modify-path) no_modify_path=true; shift ;;
    *) echo -e "${MUTED}Warning: unknown option '$1'${NC}" >&2; shift ;;
  esac
done

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo -e "${RED}Missing required command: $1${NC}" >&2
    exit 1
  fi
}

# Map `uname` output to CodePilot's binary suffix (matches scripts/package
# _util.mjs binaryNameSuffix): darwin-<arch> / linux-<arch> / win-<arch>.exe.
detect_target() {
  local os arch
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin) OS_FAMILY="mac" ;;
    Linux) OS_FAMILY="linux" ;;
    MINGW*|MSYS*|CYGWIN*) OS_FAMILY="win" ;;
    *) echo -e "${RED}Unsupported OS: ${os}${NC}" >&2; exit 1 ;;
  esac
  case "$arch" in
    arm64|aarch64) CPU_ARCH="arm64" ;;
    x86_64|amd64) CPU_ARCH="x64" ;;
    *) echo -e "${RED}Unsupported architecture: ${arch}${NC}" >&2; exit 1 ;;
  esac
  case "$OS_FAMILY" in
    mac) TARGET="darwin-${CPU_ARCH}"; EXE="" ;;
    linux) TARGET="linux-${CPU_ARCH}"; EXE="" ;;
    win) TARGET="win-${CPU_ARCH}"; EXE=".exe" ;;
  esac
}

resolve_tag() {
  if [[ -n "$requested_version" ]]; then
    [[ "$requested_version" == v* ]] && TAG="$requested_version" || TAG="v$requested_version"
    return
  fi
  local json
  json=$(curl -fsSL "${GITHUB_API}/repos/${REPO}/releases/latest")
  TAG=$(printf '%s' "$json" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)
  if [[ -z "$TAG" ]]; then
    echo -e "${RED}Failed to resolve latest release for ${REPO}${NC}" >&2
    exit 1
  fi
}

download() {
  local url="$1" out="$2"
  echo -e "${MUTED}↓ ${NC}$(basename "$out")"
  if ! curl -fL --progress-bar -o "$out" "$url"; then
    echo -e "${RED}Download failed: ${url}${NC}" >&2
    echo -e "${MUTED}See ${GITHUB_DL}/${REPO}/releases${NC}" >&2
    exit 1
  fi
}

# Copy a required binary + the shared web/ SPA from a local dist/release tree.
install_from_dist() {
  detect_target
  local cli_src tui_src web_src
  cli_src="$DIST_DIR/cli/codepilot-${TARGET}${EXE}"
  tui_src="$DIST_DIR/tui/codepilot-tui-${TARGET}${EXE}"
  web_src="$DIST_DIR/cli/web"
  [[ -f "$tui_src" ]] || { echo -e "${RED}Missing ${tui_src} — run: corepack pnpm package:tui${NC}" >&2; exit 1; }
  [[ -f "$cli_src" ]] || { echo -e "${RED}Missing ${cli_src} — run: corepack pnpm package:cli${NC}" >&2; exit 1; }

  echo -e "${MUTED}Installing CodePilot ${NC}(local dist, ${TARGET}) ${MUTED}→ ${NC}${PREFIX}"
  mkdir -p "$BIN_DIR"
  cp "$tui_src" "$BIN_DIR/codepilot-tui${EXE}"
  cp "$cli_src" "$BIN_DIR/codepilot${EXE}"
  chmod +x "$BIN_DIR/codepilot-tui${EXE}" "$BIN_DIR/codepilot${EXE}" 2>/dev/null || true
  if [[ -d "$web_src" ]]; then
    rm -rf "$BIN_DIR/web"
    cp -R "$web_src" "$BIN_DIR/web"
  fi
}

# Download the platform binaries + shared web/ SPA from a GitHub release.
install_from_release() {
  detect_target
  resolve_tag
  local tmp
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/codepilot-install.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  echo -e "${MUTED}Installing CodePilot ${NC}${TAG} ${MUTED}(${TARGET}) → ${NC}${PREFIX}"
  local base="${GITHUB_DL}/${REPO}/releases/download/${TAG}"
  download "${base}/codepilot-tui-${TARGET}${EXE}" "$tmp/codepilot-tui${EXE}"
  download "${base}/codepilot-${TARGET}${EXE}" "$tmp/codepilot${EXE}"
  download "${base}/codepilot-web-${TARGET}.tar.gz" "$tmp/web.tar.gz"

  mkdir -p "$BIN_DIR"
  cp "$tmp/codepilot-tui${EXE}" "$BIN_DIR/codepilot-tui${EXE}"
  cp "$tmp/codepilot${EXE}" "$BIN_DIR/codepilot${EXE}"
  chmod +x "$BIN_DIR/codepilot-tui${EXE}" "$BIN_DIR/codepilot${EXE}" 2>/dev/null || true
  rm -rf "$BIN_DIR/web"
  mkdir -p "$BIN_DIR/web"
  tar -xzf "$tmp/web.tar.gz" -C "$BIN_DIR/web"
}

verify_install() {
  if [[ ! -x "$BIN_DIR/codepilot-tui${EXE}" ]]; then
    echo -e "${RED}Install finished but ${BIN_DIR}/codepilot-tui${EXE} is missing or not executable${NC}" >&2
    exit 1
  fi
  echo -e "${MUTED}Bins:${NC}"
  ls -la "$BIN_DIR"/codepilot* 2>/dev/null || true
}

add_to_path() {
  local config_file=$1
  local command=$2
  if grep -Fxq "$command" "$config_file" 2>/dev/null; then
    return
  fi
  if [[ -w "$config_file" ]] || [[ ! -e "$config_file" && -w "$(dirname "$config_file")" ]]; then
    {
      echo ""
      echo "# CodePilot"
      echo "$command"
    } >> "$config_file"
    PATH_ADDED=true
    echo -e "${MUTED}Added to PATH in ${NC}${config_file}"
  fi
}

ensure_path() {
  PATH_ADDED=false
  if [[ "$no_modify_path" == "true" ]]; then
    return
  fi
  if [[ ":$PATH:" == *":$BIN_DIR:"* ]]; then
    return
  fi

  local current_shell config_file new_config
  current_shell=$(basename "${SHELL:-bash}")
  config_file=""
  case "$current_shell" in
    fish)
      for f in "$HOME/.config/fish/config.fish"; do
        [[ -f "$f" ]] && config_file=$f && break
      done
      new_config="$HOME/.config/fish/config.fish"
      ;;
    zsh)
      for f in "${ZDOTDIR:-$HOME}/.zshrc" "${ZDOTDIR:-$HOME}/.zshenv"; do
        [[ -f "$f" ]] && config_file=$f && break
      done
      new_config="${ZDOTDIR:-$HOME}/.zshrc"
      ;;
    *)
      for f in "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        [[ -f "$f" ]] && config_file=$f && break
      done
      new_config="$HOME/.bashrc"
      ;;
  esac

  if [[ -z "$config_file" ]]; then
    mkdir -p "$(dirname "$new_config")" 2>/dev/null || true
    touch "$new_config" 2>/dev/null || true
    config_file=$new_config
  fi

  if [[ -z "$config_file" || ! -e "$config_file" ]]; then
    echo -e "${MUTED}Add to PATH manually:${NC}"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    return
  fi

  case "$current_shell" in
    fish) add_to_path "$config_file" "fish_add_path $BIN_DIR" ;;
    *) add_to_path "$config_file" "export PATH=\"$BIN_DIR:\$PATH\"" ;;
  esac
}

need_cmd curl
if [[ -n "$DIST_DIR" ]]; then
  install_from_dist
else
  install_from_release
fi
verify_install
ensure_path

echo ""
echo -e "${MUTED}Done. Start with:${NC}"
if [[ "${PATH_ADDED:-false}" == "true" ]]; then
  echo "  exec \$SHELL   # reload PATH"
fi
echo "  codepilot-tui"
echo "  codepilot --help"
echo ""
