{ pkgs ? import <nixpkgs> { config = { permittedInsecurePackages = [ "electron-37.10.3" ]; }; } }:

let
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
    electron_37
    gsettings-desktop-schemas
  ] ++ electronDeps;

  LD_LIBRARY_PATH = libPath;
  XDG_DATA_DIRS = "${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:${pkgs.adwaita-icon-theme}/share";

  shellHook = ''
    if [ ! -d "node_modules" ]; then
      bun install 2>/dev/null || true
    fi
  '';
}
