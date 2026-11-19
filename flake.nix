{
  description = "Actual Web Rendering in Terminal";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
  let
    version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
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
      alsa-lib libpulseaudio pipewire udev libnotify libdrm libgbm mesa libglvnd
      gsettings-desktop-schemas libpng libjpeg_turbo
      expat fontconfig freetype harfbuzz zlib libuuid libxshmfence libva
    ];

    # Per-platform dep hashes — update when bun.lock changes
    depHashes = {
      "x86_64-linux" = "sha256-UyM9p9vLlpvvcekUZctISVv2mwv/WGMppz1ypeXkkXQ=";
      "aarch64-linux" = "sha256-ceeHZVQFtg44VLWYozVvxMdqmLctdA/lSLAOfc3po/k=";
    };

    mkAwrit = system: let
      pkgs = pkgsFor system;
      libPath = pkgs.lib.makeLibraryPath (electronDeps pkgs);

      src = pkgs.lib.cleanSourceWith {
        src = ./.;
        filter = path: type:
          let base = baseNameOf path; in
          !(builtins.elem base [ "node_modules" "dist" "result" ".git" ".kiro" "out" ".bun" ]);
      };

      bunDeps = pkgs.stdenvNoCC.mkDerivation {
        pname = "awrit-deps";
        inherit version;
        inherit src;
        nativeBuildInputs = [ pkgs.bun ];
        dontConfigure = true;
        dontFixup = true;
        outputHashAlgo = "sha256";
        outputHashMode = "recursive";
        outputHash = depHashes.${system};
        ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
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
          rm -rf $out/node_modules/awrit-native-rs
        '';
      };

      native = pkgs.callPackage ./awrit-native-rs/package.nix {};

      # Keep the install input outside the source tree to avoid recursive archives.
      remoteSource = pkgs.runCommand "awrit-remote-source-${version}" {
        nativeBuildInputs = [ pkgs.gnutar pkgs.coreutils ];
      } ''
        mkdir -p $out
        tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
          --format=gnu -cf $out/source.tar -C ${src} .
        sha256=$(sha256sum $out/source.tar | cut -d ' ' -f 1)
        size=$(stat -c %s $out/source.tar)
        printf '{"format":1,"version":"%s","sha256":"%s","size":%s}\n' \
          '${version}' "$sha256" "$size" > $out/manifest.json
      '';

    in pkgs.stdenv.mkDerivation {
      pname = "awrit";
      inherit version;
      inherit src;

      passthru = { inherit native remoteSource; };

      nativeBuildInputs = with pkgs; [ bun nodejs makeWrapper ];
      buildInputs = electronDeps pkgs;

      dontConfigure = true;
      dontFixup = true;

      buildPhase = ''
        export HOME=$TMPDIR
        export LD_LIBRARY_PATH=${libPath}

        cp -r ${bunDeps}/node_modules node_modules
        chmod -R +w node_modules
        mkdir -p node_modules/awrit-native-rs
        cp awrit-native-rs/{package.json,index.js,index.d.ts} node_modules/awrit-native-rs/
        patchShebangs node_modules

        bun build src/browserOwner/main.ts src/remote/androidOwner.ts src/remote/pickerMain.ts src/terminal/main.ts src/preload.js src/content-preload.js \
          --outdir dist --root src \
          --target node --format cjs \
          --external electron --external '../config.js' --external '*.node'

        bun build src/adb/androidMain.ts --outfile dist/android-cli.js \
          --target node --format cjs --external awrit-native-rs
        bun build src/presentation/main.ts --outfile dist/presentation-cli.js \
          --target node --format cjs --external awrit-native-rs
        bun build src/presentation/captureMain.ts --outfile dist/captureMain.js \
          --target node --format cjs --external electron

        mkdir -p dist
        touch dist/kitty.css

        node node_modules/vite/bin/vite.js build --config src/runner/vite.config.ts
      '';

      installPhase = ''
        mkdir -p $out/lib/awrit $out/bin

        cp -r dist config.js package.json $out/lib/awrit/
        cp -r ${remoteSource} $out/lib/awrit/remote-install
        cp -r awrit-native-rs $out/lib/awrit/
        cp -r src $out/lib/awrit/
        cp -r containers skills kittens plugins .claude-plugin $out/lib/awrit/
        ln -s ${bunDeps}/node_modules $out/lib/awrit/node_modules

        # Copy the native binding into the packaged runtime.
        cp ${native}/lib/*.node $out/lib/awrit/dist/
        cp ${native}/lib/*.node $out/lib/awrit/awrit-native-rs/

        # Patch baked-in __dirname from build sandbox to nix store
        substituteInPlace $out/lib/awrit/dist/android-cli.js \
          --replace-quiet 'import("awrit-native-rs")' 'import("../awrit-native-rs/index.js")' \
          --replace-quiet 'require("awrit-native-rs")' 'require("../awrit-native-rs/index.js")'

        substituteInPlace $out/lib/awrit/dist/presentation-cli.js \
          --replace-fail 'import("awrit-native-rs")' 'import("../awrit-native-rs/index.js")' \
          --replace-fail 'require("awrit-native-rs")' 'require("../awrit-native-rs/index.js")'

        for entry in browserOwner/main.js terminal/main.js remote/androidOwner.js; do
          substituteInPlace "$out/lib/awrit/dist/$entry" \
            --replace-quiet '/build/source/node_modules/awrit-native-rs' "$out/lib/awrit/awrit-native-rs" \
            --replace-quiet '/build/source/src' "$out/lib/awrit/src" \
            --replace-quiet '/build/source/node_modules' "$out/lib/awrit/node_modules" \
            --replace-quiet '/build/source/awrit-native-rs' "$out/lib/awrit/awrit-native-rs"
        done

        cat > $out/bin/awrit <<EOF
        #!/usr/bin/env bash
        export LD_LIBRARY_PATH="${libPath}\''${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
        export PATH="${pkgs.android-tools}/bin:${pkgs.ffmpeg-headless}/bin:${pkgs.podman}/bin:${pkgs.fzf}/bin:\$PATH"
        export AWRIT_LAUNCHER="$out/bin/awrit"
        export AWRIT_ELECTRON="${pkgs.electron}/bin/electron"
        export AWRIT_CAPTURE_ENTRY="$out/lib/awrit/dist/captureMain.js"
        export AWRIT_SKILL_PATH="$out/lib/awrit/skills/awrit/SKILL.md"
        export AWRIT_KITTEN_PATH="$out/lib/awrit/kittens/awrit.py"
        export AWRIT_PLUGIN_ROOT="$out/lib/awrit"
        export AWRIT_CHAT_PLUGIN_DIR="$out/lib/awrit/plugins/awrit-chat"

        case "\$1" in
          design)
            if [ "\$2" = --help ] || [ "\$2" = -h ]; then
              echo 'awrit design — comment on the current Kitty split (requires Kitty remote control)'
              exit 0
            fi
            if ! [[ "\$KITTY_WINDOW_ID" =~ ^[0-9]+$ ]]; then
              echo 'Run awrit design in the Kitty split you want to comment on.' >&2
              exit 1
            fi
            exec kitten @ kitten --match "id:\$KITTY_WINDOW_ID" "\$AWRIT_KITTEN_PATH" design "\$AWRIT_LAUNCHER";;
          capabilities|inline|show|snapshot|setup|context|overlay|capture|video|tool|status|remote-bridge)
            exec "${pkgs.nodejs}/bin/node" $out/lib/awrit/dist/presentation-cli.js "\$@";;
        esac

        # device subcommands run headless under node, without Electron. "view NAME" needs
        # the Electron viewer, so it falls through to the normal launch below.
        android_cmd=""
        is_remote=""
        is_view=""
        prev=""
        for arg in "\$@"; do
          case "\$arg" in
            device) android_cmd=1;;
            view) [ "\$prev" = device ] && is_view=1;;
            -h|--help|--pick) android_cmd=1;;
            --host|--host=*) is_remote=1;;
          esac
          prev="\$arg"
        done
        if [ -n "\$android_cmd" ]; then
          if [ -n "\$is_view" ] && [ -z "\$is_remote" ]; then
            : # fall through to the viewer launch
          else
            exec "${pkgs.nodejs}/bin/node" $out/lib/awrit/dist/android-cli.js "\$@"
          fi
        fi

        for arg in "\$@"; do
          case "\$arg" in
            -v|--version) echo "awrit ${version}"; exit 0;;
          esac
        done

        export AWRIT_ELECTRON="${pkgs.electron}/bin/electron"
        export AWRIT_OWNER_ENTRY="$out/lib/awrit/dist/browserOwner/main.js"
        exec "${pkgs.nodejs}/bin/node" $out/lib/awrit/dist/terminal/main.js "\$@"
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
    let
      pkgs = pkgsFor system;
      native = (mkAwrit system).native;
    in {
      default = pkgs.mkShell {
        name = "awrit";
        buildInputs = [ pkgs.bun pkgs.electron pkgs.android-tools pkgs.ffmpeg-headless pkgs.podman pkgs.fzf ] ++ (electronDeps pkgs);
        LD_LIBRARY_PATH = pkgs.lib.makeLibraryPath (electronDeps pkgs);
        shellHook = ''
          if [ ! -d "node_modules" ]; then
            bun install 2>/dev/null || true
          fi
        '' + native.devShellHook native;
      };
    });
  };
}
