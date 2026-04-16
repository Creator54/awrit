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
    xorg.libXcomposite
    xorg.libXdamage
    xorg.libXrandr
    xorg.libX11
    xorg.libXScrnSaver
    xorg.libXtst
    xorg.libXext
    xorg.libxcb
    xorg.libXi
    xorg.libXfixes
    xorg.libXrender
    xorg.libXcursor
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
    echo " awrit dev environment ready"
    echo " CDP available at: http://localhost:9222/json"
    bun install 2>/dev/null || true
  '';
}
