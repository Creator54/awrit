# Build inputs are explicit; no downloads or user configuration changes on launch.
set positional-arguments

out := env('AWRIT_BUILD_DIR', 'out')
node := env('NODE_DIST', '')
electron := env('ELECTRON_DIST', 'node_modules/electron/dist')

# List available commands.
default:
    @just --list

# Check the source without building an artifact.
check:
    bun run verify

# Build the native binding on the target host (rejects Nix-linked output).
native:
    sh packaging/build-native.sh

# Build and verify a standalone payload. Output must not already exist.
payload destination=(out / 'awrit'):
    python3 packaging/commands.py build "$1" "{{node}}" "{{electron}}"

# Verify an existing standalone payload.
verify payload=(out / 'awrit'):
    python3 packaging/verify.py "$1"

# Archive an already verified payload (Linux/macOS).
archive payload=(out / 'awrit') destination=(out / 'awrit.tar.gz'):
    python3 packaging/archive.py "$1" "$2"

# Run the exact artifact, not another awrit on PATH. Extra arguments pass through.
run artifact=(out / 'awrit' / 'bin' / 'awrit') *args:
    python3 packaging/commands.py run "$@"

# Test the exact artifact's version and capabilities; no graphical windows.
test artifact=(out / 'awrit' / 'bin' / 'awrit'):
    python3 packaging/commands.py test "$1"
