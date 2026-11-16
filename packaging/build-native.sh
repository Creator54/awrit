#!/bin/sh
# Run on the target host; never invoked by the installed application.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) suffix=linux-x64-gnu; library=libawrit_native_rs.so ;;
  Linux/aarch64|Linux/arm64) suffix=linux-arm64-gnu; library=libawrit_native_rs.so ;;
  Darwin/x86_64) suffix=darwin-x64; library=libawrit_native_rs.dylib ;;
  Darwin/arm64) suffix=darwin-arm64; library=libawrit_native_rs.dylib ;;
  *) printf '%s\n' 'Unsupported native build host' >&2; exit 1 ;;
esac
command -v cargo >/dev/null || { printf '%s\n' 'Native builds require Cargo on the build host.' >&2; exit 1; }
# An isolated target directory avoids silently reusing the Nix development library.
target=$(mktemp -d "${TMPDIR:-/tmp}/awrit-native-build.XXXXXX")
trap 'rm -rf -- "$target"' EXIT HUP INT TERM
cargo build --manifest-path "$root/awrit-native-rs/Cargo.toml" --target-dir "$target" --release --locked
source=$target/release/$library
if LC_ALL=C grep -a -q '/nix/store/' "$source"; then
  printf '%s\n' 'Native output references /nix/store; use a non-Nix target toolchain/sysroot for distribution.' >&2
  exit 1
fi
cp "$source" "$root/awrit-native-rs/awrit-native-rs.$suffix.node"
printf 'Built %s\n' "$root/awrit-native-rs/awrit-native-rs.$suffix.node"
