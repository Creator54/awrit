#!/bin/sh
# Awrit install/uninstall script.
#   Install:   curl -fsSL https://raw.githubusercontent.com/Creator54/awrit/electron/install.sh | sh
#   Uninstall (NixOS): nix profile remove awrit
#   Uninstall (tarball): curl -fsSL https://raw.githubusercontent.com/Creator54/awrit/electron/install.sh | sh -s -- --uninstall
#
# Environment:
#   AWRIT_VERSION  release tag to install, e.g. v2.1.0 (default: latest)
#   AWRIT_PREFIX   tarball install root (default: ~/.local; NixOS uses the Nix profile)
#   NO_COLOR       disable colors
#   AWRIT_BASE_URL override the download location (for testing)
set -eu

REPO=Creator54/awrit
PREFIX=${AWRIT_PREFIX:-$HOME/.local}
LIB=$PREFIX/lib/awrit
BIN=$PREFIX/bin

# --- output ------------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf '\033[1m') D=$(printf '\033[2m') R=$(printf '\033[31m')
  G=$(printf '\033[32m') Y=$(printf '\033[33m') Z=$(printf '\033[0m')
else
  B= D= R= G= Y= Z=
fi

step() { printf '%s›%s %s\n' "$B" "$Z" "$1"; }
ok() { printf '%s✓%s %s\n' "$G" "$Z" "$1"; }
note() { printf '%s  %s%s\n' "$D" "$1" "$Z"; }
warn() { printf '%s!%s %s\n' "$Y" "$Z" "$1" >&2; }
die() { printf '%s✗%s %s\n' "$R" "$Z" "$1" >&2; exit 1; }

# --- helpers -----------------------------------------------------------
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."; }

detect_target() {
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) echo linux-x64 ;;
    Linux-aarch64 | Linux-arm64) echo linux-arm64 ;;
    Darwin-arm64) echo macos-arm64 ;;
    Darwin-x86_64) echo macos-x64 ;;
    *) die "Unsupported system: $(uname -s) $(uname -m). Awrit supports Linux and macOS (x86_64, arm64)." ;;
  esac
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

fetch() { # url dest
  if [ -t 1 ]; then
    curl -fL --progress-bar "$1" -o "$2" || die "Download failed: $1"
  else
    curl -fsSL "$1" -o "$2" || die "Download failed: $1"
  fi
}

# --- uninstall ---------------------------------------------------------
do_uninstall() {
  printf '\n%sAwrit uninstaller%s\n\n' "$B" "$Z"
  note "prefix  $PREFIX"
  printf '\n'
  if [ -x "$BIN/awrit" ]; then
    step "Removing agent configs"
    "$BIN/awrit" setup --uninstall --yes 2>/dev/null || true
  fi
  step "Removing files"
  rm -f "$BIN/awrit"
  rm -rf "$LIB"
  ok "Removed $LIB and $BIN/awrit"
  printf '\n%sAwrit uninstalled.%s\n\n' "$G$B" "$Z"
}

# --- parse args --------------------------------------------------------
UNINSTALL=
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=1 ;;
    *) die "Unknown argument: $arg. Usage: install.sh [--uninstall]" ;;
  esac
done

if [ -n "$UNINSTALL" ]; then
  if [ -e /etc/NIXOS ]; then
    note "For a Nix profile install, run: nix profile remove awrit"
  fi
  do_uninstall
  exit 0
fi

# --- install -----------------------------------------------------------
if [ "$(uname -s)" = Linux ] && [ -e /etc/NIXOS ]; then
  need nix
  ref=github:$REPO
  if [ -n "${AWRIT_VERSION:-}" ]; then
    ref=$ref/$AWRIT_VERSION
  fi
  step "Installing Awrit into your Nix profile"
  exec nix --extra-experimental-features 'nix-command flakes' profile add "$ref"
fi

need curl
need tar
need uname

target=$(detect_target)
name=awrit-$target.tar.gz
if [ -n "${AWRIT_VERSION:-}" ]; then
  base=${AWRIT_BASE_URL:-https://github.com/$REPO/releases/download/$AWRIT_VERSION}
else
  base=${AWRIT_BASE_URL:-https://github.com/$REPO/releases/latest/download}
fi

printf '\n%sAwrit installer%s\n\n' "$B" "$Z"
note "platform  $target"
note "location  $LIB"
printf '\n'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

step "Downloading $name"
fetch "$base/$name" "$tmp/$name"
fetch "$base/$name.sha256" "$tmp/$name.sha256"

step "Verifying checksum"
want=$(cut -d' ' -f1 "$tmp/$name.sha256")
got=$(sha256_of "$tmp/$name")
[ "$want" = "$got" ] || die "Checksum mismatch for $name. Nothing was installed."
ok "sha256 ${got%"${got#????????????}"}…"

step "Installing"
tar -xzf "$tmp/$name" -C "$tmp" || die "Could not unpack $name."
[ -x "$tmp/awrit/bin/awrit" ] || die "The archive does not contain awrit/bin/awrit."
mkdir -p "$PREFIX/lib" "$BIN"
rm -rf "$LIB"
mv "$tmp/awrit" "$LIB"
if [ "$(uname -s)" = Darwin ]; then
  # The build is not notarized; clear the download quarantine so it can run.
  xattr -cr "$LIB"
fi
ln -sf "$LIB/bin/awrit" "$BIN/awrit"
ok "Installed $BIN/awrit"

if [ "$(uname -s)" = Linux ]; then
  missing=$(ldd "$LIB/lib/awrit/runtime/electron/electron" 2>/dev/null | awk '/not found/ {print $1}' | tr '\n' ' ')
  if [ -n "$missing" ]; then
    warn "Missing system libraries: $missing"
    note "Debian/Ubuntu: sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1"
  fi
fi

step "Connecting your coding agents"
# Under curl | sh, stdin is this script; use the terminal for setup's questions.
if [ -t 0 ]; then
  "$BIN/awrit" setup || warn "Setup did not finish. Run 'awrit setup' again."
elif (: </dev/tty) 2>/dev/null; then
  "$BIN/awrit" setup </dev/tty || warn "Setup did not finish. Run 'awrit setup' again."
else
  note "No terminal available. Run 'awrit setup' to connect your agents."
fi

printf '\n%sAwrit is installed.%s\n' "$G$B" "$Z"
case ":$PATH:" in
  *":$BIN:"*) note "Try: awrit https://example.com" ;;
  *)
    warn "$BIN is not on your PATH. Add it to your shell profile:"
    note "export PATH=\"$BIN:\$PATH\""
    ;;
esac
printf '\n'
