#!/usr/bin/env bash
set -euo pipefail

error() {
  echo "error: $*" >&2
  exit 1
}

info() {
  echo "$*"
}

BASE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE:-$0}")" &>/dev/null && pwd)

BUN_INSTALL_DIR=$BASE_DIR/.bun
BUN_BIN_DIR=$BUN_INSTALL_DIR/bin
BUN_EXE=$BUN_BIN_DIR/bun

if [ ! -d "$BUN_INSTALL_DIR" ]; then
  command -v unzip >/dev/null ||
    error 'unzip is required to install bun'

  echo "Installing bun"
  platform=$(uname -ms)
  case $platform in
  'Darwin x86_64')
    target=darwin-x64
    ;;
  'Darwin arm64')
    target=darwin-aarch64
    ;;
  'Linux aarch64' | 'Linux arm64')
    target=linux-aarch64
    ;;
  'Linux x86_64' | *)
    target=linux-x64
    ;;
  esac

  case "$target" in
  'linux'*)
    if [ -f /etc/alpine-release ]; then
      target="$target-musl"
    fi
    ;;
  esac

  if [[ $target = darwin-x64 ]]; then
    # Is this process running in Rosetta?
    # redirect stderr to devnull to avoid error message when not running in Rosetta
    if [[ $(sysctl -n sysctl.proc_translated 2>/dev/null) = 1 ]]; then
      target=darwin-aarch64
      info "Your shell is running in Rosetta 2. Downloading bun for $target instead"
    fi
  fi

  GITHUB=${GITHUB-"https://github.com"}

  github_repo="$GITHUB/oven-sh/bun"

  # If AVX2 isn't supported, use the -baseline build
  case "$target" in
  'darwin-x64'*)
    if [[ $(sysctl -a | grep machdep.cpu | grep AVX2) == '' ]]; then
      target="$target-baseline"
    fi
    ;;
  'linux-x64'*)
    # If AVX2 isn't supported, use the -baseline build
    if [[ $(cat /proc/cpuinfo | grep avx2) = '' ]]; then
      target="$target-baseline"
    fi
    ;;
  esac

  bun_uri=$github_repo/releases/latest/download/bun-$target.zip

  if [[ ! -d $BUN_BIN_DIR ]]; then
    mkdir -p "$BUN_BIN_DIR" ||
      error "Failed to create install directory \"$BUN_BIN_DIR\""
  fi

  curl --fail --location --progress-bar --output "$BUN_EXE.zip" "$bun_uri" ||
    error "Failed to download bun from \"$bun_uri\""

  unzip -oqd "$BUN_BIN_DIR" "$BUN_EXE.zip" ||
    error 'Failed to extract bun'

  mv "$BUN_BIN_DIR/bun-$target/bun" "$BUN_EXE" ||
    error 'Failed to move extracted bun to destination'

  chmod +x "$BUN_EXE" ||
    error 'Failed to set permissions on bun executable'

  rm -r "$BUN_BIN_DIR/bun-$target" "$BUN_EXE.zip"
fi

if [ ! -d "$BASE_DIR/node_modules" ]; then
  (cd awrit-native-rs && "$BUN_EXE" scripts/download-binary.js)
  "$BUN_EXE" install

  # Patch Electron.app to not display in the Dock, because it seems odd
  if [ "$(uname -s)" = "Darwin" ]; then
    sed -i '' 's/<\/dict>/    <key>LSUIElement<\/key>\n    <true\/>\n<\/dict>/' "$BASE_DIR/node_modules/electron/dist/Electron.app/Contents/Info.plist" || true
  fi
fi
