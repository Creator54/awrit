{
  description = "Actual Web Rendering in Terminal";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
  let
    supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
    forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
    pkgsFor = system: nixpkgs.legacyPackages.${system};

    electronDeps = pkgs: with pkgs; [
      glib gtk3 cairo pango gdk-pixbuf
      at-spi2-core at-spi2-atk
      libxcomposite libxdamage libxrandr libx11
      libxscrnsaver libxtst libxext libxcb
      libxi libxfixes libxrender libxcursor
      libxkbcommon nspr nss dbus cups libsecret
      alsa-lib libnotify libdrm libgbm mesa libglvnd
      gsettings-desktop-schemas libpng libjpeg_turbo
      expat fontconfig freetype harfbuzz zlib libuuid libxshmfence libva
    ];

    # Map nix system to napi-rs target triple
    napiTarget = system: {
      "x86_64-linux" = "linux-x64-gnu";
      "aarch64-linux" = "linux-arm64-gnu";
    }.${system};

    # Per-platform dep hashes — update when bun.lock changes
    depHashes = {
      "x86_64-linux" = "sha256-xHJ+dmEs60pHQlbE0zSARwf47EUqL6g1aAyXF4Y6MPM=";
      "aarch64-linux" = "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; # build once on aarch64 to get hash
    };

    mkAwrit = system: let
      pkgs = pkgsFor system;
      libPath = pkgs.lib.makeLibraryPath (electronDeps pkgs);
      target = napiTarget system;

      src = pkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let base = baseNameOf path; in
          !(builtins.elem base [ "node_modules" "dist" "result" ".git" ".kiro" "out" ".bun" ]);
      };

      bunDeps = pkgs.stdenvNoCC.mkDerivation {
        pname = "awrit-deps";
        version = "2.0.3";
        inherit src;
        nativeBuildInputs = [ pkgs.bun ];
        dontConfigure = true;
        dontFixup = true;
        outputHashAlgo = "sha256";
        outputHashMode = "recursive";
        outputHash = depHashes.${system};
        SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
        __structuredAttrs = true;
        unsafeDiscardReferences.out = true;
        buildPhase = ''
          export HOME=$TMPDIR
          patchShebangs .
          bun install --frozen-lockfile
        '';
        installPhase = ''
          mkdir -p $out
          cp -r node_modules $out/
        '';
      };

    in pkgs.stdenv.mkDerivation {
      pname = "awrit";
      version = "2.0.3";
      inherit src;

      nativeBuildInputs = with pkgs; [ bun nodejs makeWrapper ];
      buildInputs = electronDeps pkgs;

      dontConfigure = true;
      dontFixup = true;

      buildPhase = ''
        export HOME=$TMPDIR
        export LD_LIBRARY_PATH=${libPath}

        cp -r ${bunDeps}/node_modules node_modules
        chmod -R +w node_modules
        patchShebangs node_modules

        bun build src/index.ts src/preload.js src/content-preload.js src/popup-preload.js \
          --outdir dist --root src \
          --target node --format cjs \
          --external electron --external '../config.js' --external '*.node'

        mkdir -p dist
        touch dist/kitty.css

        node node_modules/vite/bin/vite.js build --config src/runner/vite.config.ts
      '';

      installPhase = ''
        mkdir -p $out/lib/awrit $out/bin

        cp -r dist config.js package.json $out/lib/awrit/
        cp -r awrit-native-rs $out/lib/awrit/
        cp -r src $out/lib/awrit/
        ln -s ${bunDeps}/node_modules $out/lib/awrit/node_modules

        # Copy native binding next to dist/index.js
        cp ${bunDeps}/node_modules/awrit-native-rs/*.node $out/lib/awrit/dist/

        # Patch baked-in __dirname from build sandbox to nix store
        substituteInPlace $out/lib/awrit/dist/index.js \
          --replace-quiet '/build/source/src' "$out/lib/awrit/src" \
          --replace-quiet '/build/source/node_modules' "$out/lib/awrit/node_modules" \
          --replace-quiet '/build/source/awrit-native-rs' "$out/lib/awrit/awrit-native-rs"

        ELECTRON=$(find ${bunDeps}/node_modules/electron/dist -name electron -type f)

        cat > $out/bin/awrit <<EOF
        #!/usr/bin/env bash
        export LD_LIBRARY_PATH="${libPath}\''${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
        
        # Ensure log directory exists
        LOG_DIR="''${XDG_DATA_HOME:-\$HOME/.local/share}/awrit"
        mkdir -p "\$LOG_DIR"
        LOG_FILE="\$LOG_DIR/awrit.log"

        for arg in "\$@"; do
          case "\$arg" in
            -h|--help)
              echo "Usage: awrit [options] [url]"
              echo "Options:"
              echo "  -h, --help              Show help"
              echo "  -v, --version           Show version"
              echo "  -b, --toggle-url-bar    Hide URL bar on startup"
              echo "  -D, --debug-port=PORT   Remote debugging port (CDP)"
              exit 0;;
            -v|--version) echo "awrit 2.0.3"; exit 0;;
          esac
        done
        # Redirect stderr to log file to prevent TUI corruption from native logs (Electron, GTK, etc.)
        exec "$ELECTRON" $out/lib/awrit/dist/index.js --high-dpi-support=1 "\$@" 2> "\$LOG_FILE"
        EOF
        chmod +x $out/bin/awrit
      '';
    };
  in {
    packages = forAllSystems (system: {
      default = mkAwrit system;
      awrit = mkAwrit system;
    });

    devShells = forAllSystems (system:
    let pkgs = pkgsFor system;
    in {
      default = pkgs.mkShell {
        name = "awrit";
        buildInputs = [ pkgs.bun pkgs.electron ] ++ (electronDeps pkgs);
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (electronDeps pkgs);
        shellHook = ''
          if [ ! -d "node_modules" ]; then
            bun install 2>/dev/null || true
          fi
        '';
      };
    });
  };
}
