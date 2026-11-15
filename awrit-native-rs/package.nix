{ lib, rustPlatform, nodejs, stdenv }:

let
  target = {
    x86_64-linux = "linux-x64-gnu";
    aarch64-linux = "linux-arm64-gnu";
  }.${stdenv.hostPlatform.system};
  bindingFile = "awrit-native-rs.${target}.node";
  src = lib.cleanSourceWith {
    src = ./.;
    filter = path: type:
      let base = baseNameOf path; in
      !(builtins.elem base [ "target" "node_modules" ])
      && !(lib.hasSuffix ".node" base)
      && lib.cleanSourceFilter path type;
  };
in rustPlatform.buildRustPackage {
  pname = "awrit-native-rs";
  version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
  inherit src;
  cargoLock.lockFile = src + "/Cargo.lock";
  passthru = {
    inherit bindingFile;
    devShellHook = native: ''
      if [ -e .git ] && [ -f package.json ] && cmp -s package.json "${../package.json}"; then
        for native_dir in awrit-native-rs node_modules/awrit-native-rs; do
          if [ -d "$native_dir" ]; then
            native_temp="$(mktemp --suffix=.node "$native_dir/.awrit-native.XXXXXX")" || exit 1
            if ! cp "${native}/lib/${bindingFile}" "$native_temp" \
              || ! mv -f "$native_temp" "$native_dir/${bindingFile}"; then
              rm -f "$native_temp"
              echo "awrit: could not install the native renderer" >&2
              exit 1
            fi
          fi
        done
      fi
    '';
  };
  # The N-API library is checked in a Node host after installation.
  doCheck = false;
  doInstallCheck = true;
  nativeInstallCheckInputs = [ nodejs ];
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib
    cp target/${stdenv.hostPlatform.rust.rustcTarget}/release/libawrit_native_rs.so \
      $out/lib/${bindingFile}
    runHook postInstall
  '';
  installCheckPhase = ''
    node tests/shared-memory.cjs $out/lib/${bindingFile}
  '';
}
