#!/usr/bin/env bash
# CodePilot installer (macOS / Linux / Windows Git Bash / WSL)
#
#   curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/dtssv/CodePilot/main/scripts/install.sh | bash -s -- --version v1.0.0
#
# Installs @codepilot/core + protocol + tui into ~/.codepilot (npm prefix).
# Requires Node.js >= 20 and npm.
#
set -euo pipefail

REPO="${CODEPILOT_REPO:-dtssv/CodePilot}"
PREFIX="${CODEPILOT_INSTALL_DIR:-$HOME/.codepilot}"
BIN_DIR="$PREFIX/bin"
GITHUB_API="${GITHUB_API:-https://api.github.com}"
GITHUB_DL="${GITHUB_DL:-https://github.com}"

RED='\033[0;31m'
MUTED='\033[0;2m'
NC='\033[0m'

usage() {
  cat <<EOF
Install CodePilot (CLI + TUI)

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

check_node() {
  need_cmd node
  need_cmd npm
  need_cmd curl
  local major
  major=$(node -p "process.versions.node.split('.')[0]")
  if [[ "$major" -lt 20 ]]; then
    echo -e "${RED}Node.js >= 20 required (found $(node -v))${NC}" >&2
    exit 1
  fi
}

resolve_tag() {
  if [[ -n "$requested_version" ]]; then
    if [[ "$requested_version" == v* ]]; then
      TAG="$requested_version"
    else
      TAG="v$requested_version"
    fi
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

# Strip leading v → 1.0.0 for asset filenames codepilot-*-1.0.0.tgz
version_number() {
  echo "${TAG#v}"
}

download_tarball() {
  local name="$1"
  local url="${GITHUB_DL}/${REPO}/releases/download/${TAG}/${name}"
  local out="$2/${name}"
  echo -e "${MUTED}↓ ${NC}${name}"
  if ! curl -fL --progress-bar -o "$out" "$url"; then
    echo -e "${RED}Download failed: ${url}${NC}" >&2
    echo -e "${MUTED}See ${GITHUB_DL}/${REPO}/releases${NC}" >&2
    exit 1
  fi
}

install_packages() {
  resolve_tag
  local ver tmp
  ver=$(version_number)
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/codepilot-install.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$tmp'" EXIT

  echo -e "${MUTED}Installing CodePilot ${NC}${TAG} ${MUTED}→ ${NC}${PREFIX}"

  download_tarball "codepilot-core-${ver}.tgz" "$tmp"
  download_tarball "codepilot-protocol-${ver}.tgz" "$tmp"
  download_tarball "codepilot-tui-${ver}.tgz" "$tmp"

  mkdir -p "$PREFIX"
  npm install -g --prefix "$PREFIX" \
    "$tmp/codepilot-core-${ver}.tgz" \
    "$tmp/codepilot-protocol-${ver}.tgz" \
    "$tmp/codepilot-tui-${ver}.tgz"

  if [[ ! -x "$BIN_DIR/codepilot-tui" && ! -L "$BIN_DIR/codepilot-tui" ]]; then
    echo -e "${RED}Install finished but ${BIN_DIR}/codepilot-tui is missing${NC}" >&2
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

check_node
install_packages
ensure_path

echo ""
echo -e "${MUTED}Done. Start with:${NC}"
if [[ "${PATH_ADDED:-false}" == "true" ]]; then
  echo "  exec \$SHELL   # reload PATH"
fi
echo "  codepilot-tui"
echo "  codepilot --help"
echo ""
