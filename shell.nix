# Pinned to flake.lock, so the environment changes only with the repo.
{ pkgs ? let
    lock = (builtins.fromJSON (builtins.readFile ./flake.lock)).nodes.nixpkgs.locked;
  in import (fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/${lock.rev}.tar.gz";
    sha256 = lock.narHash;
  }) {} }:

let
  native = pkgs.callPackage ./awrit-native-rs/package.nix {};
  electronDeps = with pkgs; [
    glib
    gtk3
    cairo
    pango
    gdk-pixbuf
    at-spi2-core
    at-spi2-atk
    libxcomposite
    libxdamage
    libxrandr
    libx11
    libxscrnsaver
    libxtst
    libxext
    libxcb
    libxi
    libxfixes
    libxrender
    libxcursor
    libxkbcommon
    nspr
    nss
    dbus
    cups
    libsecret
    alsa-lib
    libnotify
    libdrm
    libgbm
    mesa
    libglvnd
    gsettings-desktop-schemas
    libpng
    libjpeg_turbo
    expat
    fontconfig
    freetype
    harfbuzz
    zlib
    libuuid
    libxshmfence
    libva
    systemd
  ];

  libPath = pkgs.lib.makeLibraryPath electronDeps;
in

pkgs.mkShell {
  name = "awrit";
  buildInputs = with pkgs; [
    bun
    electron
    android-tools
    ffmpeg-headless
    podman
    fzf
    gsettings-desktop-schemas
    adwaita-icon-theme
  ] ++ electronDeps;

  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  ELECTRON_OVERRIDE_DIST_PATH = "${pkgs.electron}/bin";
  LD_LIBRARY_PATH = libPath;
  XDG_DATA_DIRS = "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:${pkgs.adwaita-icon-theme}/share";

  shellHook = ''
    if [ ! -d "node_modules" ]; then
      bun install 2>/dev/null || true
    fi
  '' + native.devShellHook native;
}
