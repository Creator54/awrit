#!/usr/bin/env bash
# awrit-runner - wrapper that sets up library paths for Electron
# Usage: ./awrit-runner [args...]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check if node_modules exists
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  bun install
fi

# Try to find and set library paths from nix store
NIX_PATHS=$(echo /nix/store/*-glib-2.86*/lib /nix/store/*-gtk+3-3.24*/lib /nix/store/*-cairo-1.18*/lib /nix/store/*-pango-1.57*/lib /nix/store/*-gdk-pixbuf-2.44*/lib /nix/store/*-libnotify-0.8*/lib /nix/store/*-alsa-lib-1.2*/lib /nix/store/*-at-spi2-core-2.58*/lib /nix/store/*-libx11-1.8*/lib /nix/store/*-nss-3.112*/lib /nix/store/*-nspr-4.38*/lib /nix/store/*-dbus-1.14*/lib 2>/dev/null | tr ' ' '\n' | grep -v '^$' | tr '\n' ':')

if [ -n "$NIX_PATHS" ]; then
  export LD_LIBRARY_PATH="${NIX_PATHS}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# Run awrit
exec ./awrit "$@"