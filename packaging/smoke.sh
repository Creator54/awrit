#!/bin/sh
# Checks an installed awrit without opening a window: launcher, bundled Node,
# the native binding under Node and Electron, and the Electron binary itself.
set -eu
awrit=$1
"$awrit" --version
"$awrit" --help >/dev/null
"$awrit" context --claude >/dev/null
app=$(dirname "$(realpath "$awrit")")/../lib/awrit
native=$app/node_modules/awrit-native-rs
"$app/runtime/node/bin/node" -e 'require(process.argv[1])' "$native"
case $(uname -s) in
  Darwin) electron=$app/runtime/electron/Electron.app/Contents/MacOS/Electron ;;
  *) electron=$app/runtime/electron/electron ;;
esac
ELECTRON_RUN_AS_NODE=1 "$electron" -e 'require(process.argv[1])' "$native"
echo "smoke ok: $awrit"
