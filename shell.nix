{ pkgs ? import <nixpkgs> {} }:

let
  # Electron and its runtime dependencies
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
  ];

  libPath = pkgs.lib.makeLibraryPath electronDeps;
in

pkgs.mkShell {
  name = "awrit";
  buildInputs = with pkgs; [
    bun
    electron
  ] ++ electronDeps;

  LD_LIBRARY_PATH = libPath;

  shellHook = ''
    if [ ! -d "node_modules" ]; then
      bun install 2>/dev/null || true
    fi
  '';
}
