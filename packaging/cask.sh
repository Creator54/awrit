#!/bin/sh
# Prints the Homebrew cask. A cask installs the archive as built; a formula
# would rewrite Mach-O install names and break the native binding and Electron.
# Usage: cask.sh VERSION HOMEPAGE ARM64_URL ARM64_SHA256 X64_URL X64_SHA256
set -eu
cat <<RUBY
cask "awrit" do
  version "$1"
  on_arm do
    url "$3"
    sha256 "$4"
  end
  on_intel do
    url "$5"
    sha256 "$6"
  end
  name "awrit"
  desc "Chromium in your Kitty terminal, for you and your coding agents"
  homepage "$2"
  binary "awrit/bin/awrit"
  # The build is not notarized; clear the download quarantine so it can run.
  postflight do
    system_command "/usr/bin/xattr", args: ["-cr", "#{staged_path}/awrit"]
  end
end
RUBY
