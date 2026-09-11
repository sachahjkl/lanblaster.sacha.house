{
  description = "Deno + Three.js multiplayer WebGPU game dev environment";

  nixConfig = {
    extra-substituters = [ "https://nix-community.cachix.org" ];
    extra-trusted-public-keys = [
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.2605";
    flake-utils.url = "github:numtide/flake-utils";
    git-hooks = {
      url = "https://flakehub.com/f/cachix/git-hooks.nix/0.1";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
      git-hooks,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = package: nixpkgs.lib.getName package == "nomad";
        };
        lib = pkgs.lib;

        source = lib.cleanSourceWith {
          src = ./.;
          filter =
            path: _type:
            let
              rel = lib.removePrefix ((toString ./.) + "/") (toString path);
            in
            rel == ""
            || rel == "build.ts"
            || rel == "deno.json"
            || rel == "deno.lock"
            || rel == "public"
            || rel == "src"
            || lib.hasPrefix "public/" rel
            || lib.hasPrefix "src/" rel;
        };

        runtimeTools = with pkgs; [
          deno
          caddy
          git
          jq
          unzip
          curl
          oxlint
          oxfmt
        ];

        built = pkgs.stdenvNoCC.mkDerivation {
          pname = "lanblaster-built";
          version = "2026.06.22";
          src = source;
          nativeBuildInputs = [ pkgs.deno ];
          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
          outputHash = "sha256-8fLFpBaE9exrhm0VSX31t7zxxuvOddlwubBW6s0t9Es=";
          buildCommand = ''
            cp -r $src /build/project
            chmod -R u+w /build/project
            cd /build/project
            export DENO_DIR="$TMPDIR/deno-cache"
            mkdir -p "$DENO_DIR"
            deno install --node-modules-dir --lock=deno.lock
            deno task build
            mkdir -p "$out/share/lanblaster/dist" "$out/share/lanblaster/src"
            cp deno.json deno.lock "$out/share/lanblaster/"
            cp -r dist/client "$out/share/lanblaster/dist/"
            cp -r src/server "$out/share/lanblaster/src/"
            cp -r src/shared "$out/share/lanblaster/src/"
          '';
        };

        lanblaster = pkgs.stdenvNoCC.mkDerivation {
          pname = "lanblaster";
          version = "2026.06.22";
          dontUnpack = true;
          nativeBuildInputs = [
            pkgs.deno
            pkgs.makeWrapper
          ];

          installPhase = ''
            runHook preInstall
            mkdir -p "$out/share/lanblaster"
            cp -r "${built}/share/lanblaster/." "$out/share/lanblaster/"
            makeWrapper ${pkgs.deno}/bin/deno "$out/bin/lanblaster-server" \
              --set DENO_DIR "/var/lib/lanblaster/deno-cache" \
              --set DENO_NO_UPDATE_CHECK "1" \
              --chdir "$out/share/lanblaster" \
              --add-flags "run --allow-net --allow-read --allow-env src/server/server.ts"
            runHook postInstall
          '';

          meta.mainProgram = "lanblaster-server";
        };

        dockerImage = pkgs.dockerTools.buildLayeredImage {
          name = "lanblaster.sacha.house";
          tag = "2026.06.22";
          contents = [ lanblaster ];
          fakeRootCommands = ''
            mkdir -p var/lib/lanblaster/deno-cache
            chmod 0777 var/lib/lanblaster/deno-cache
          '';
          config = {
            Cmd = [ "${lanblaster}/bin/lanblaster-server" ];
            Env = [
              "HOST=0.0.0.0"
              "PORT=8000"
            ];
            ExposedPorts."8000/tcp" = { };
          };
        };

        preCommitCheck = git-hooks.lib.${system}.run {
          package = pkgs.prek;
          src = ./.;
          hooks = {
            actionlint.enable = true;
            check-added-large-files.enable = true;
            check-json.enable = true;
            check-merge-conflicts.enable = true;
            end-of-file-fixer = {
              enable = true;
              excludes = [ "^public/assets/" ];
            };
            nixfmt.enable = true;
            trim-trailing-whitespace = {
              enable = true;
              excludes = [ "^public/assets/" ];
            };
          };
        };

        nomadJobs = pkgs.runCommand "lanblaster-nomad-jobs" { nativeBuildInputs = [ pkgs.nomad ]; } ''
          image="ghcr.io/sachahjkl/lanblaster.sacha.house@sha256:0000000000000000000000000000000000000000000000000000000000000000"
          nomad job validate -var "image=$image" ${./deploy/nomad/staging.nomad.hcl}
          nomad job validate -var "image=$image" ${./deploy/nomad/production.nomad.hcl}
          touch "$out"
        '';

        runBuild = pkgs.writeShellApplication {
          name = "webgpu-mp-build";
          runtimeInputs = runtimeTools;
          text = ''
            deno task build
          '';
        };

        runServer = pkgs.writeShellApplication {
          name = "webgpu-mp-server";
          runtimeInputs = runtimeTools;
          text = ''
            export HOST="''${HOST:-0.0.0.0}"
            export PORT="''${PORT:-8000}"
            deno task build
            deno task start
          '';
        };

        runProxy = pkgs.writeShellApplication {
          name = "webgpu-mp-proxy";
          runtimeInputs = runtimeTools;
          text = ''
            export GAME_HOSTNAME="''${GAME_HOSTNAME:-localhost}"
            export GAME_PORT="''${GAME_PORT:-8000}"
            caddy run --config reverse-proxy/Caddyfile.example
          '';
        };

        runLan = pkgs.writeShellApplication {
          name = "webgpu-mp-lan";
          runtimeInputs = runtimeTools;
          text = ''
            export HOST="''${HOST:-0.0.0.0}"
            export PORT="''${PORT:-8000}"
            export GAME_PORT="$PORT"
            deno task build
            echo "Starting game server on $HOST:$PORT"
            echo "Open directly from LAN: http://<your-hostname>:$PORT"
            deno task start
          '';
        };

        runLive = pkgs.writeShellApplication {
          name = "webgpu-mp-live";
          runtimeInputs = runtimeTools;
          text = ''
            export HOST="''${HOST:-0.0.0.0}"
            export PORT="''${PORT:-8000}"
            export GAME_PORT="$PORT"
            deno task live
          '';
        };
      in
      {
        packages = {
          inherit dockerImage lanblaster;
          build = runBuild;
          server = runServer;
          proxy = runProxy;
          lan = runLan;
          live = runLive;
          default = lanblaster;
        };

        checks = {
          build = lanblaster;
          inherit dockerImage nomadJobs;
          pre-commit = preCommitCheck;
        };

        apps = {
          build = flake-utils.lib.mkApp { drv = runBuild; };
          server = flake-utils.lib.mkApp {
            drv = lanblaster;
            exePath = "/bin/lanblaster-server";
          };
          proxy = flake-utils.lib.mkApp { drv = runProxy; };
          lan = flake-utils.lib.mkApp { drv = runLan; };
          live = flake-utils.lib.mkApp { drv = runLive; };
          default = flake-utils.lib.mkApp { drv = runLan; };
        };

        devShells.default = pkgs.mkShell {
          packages = runtimeTools ++ preCommitCheck.enabledPackages;

          shellHook = ''
            echo "webgpu-mp-game dev shell"
            ${preCommitCheck.shellHook}
            echo ""
            echo "Commands:"
            echo "  deno task build                         Build client"
            echo "  deno task fmt                           Format source"
            echo "  deno task lint                          Lint source"
            echo "  HOST=0.0.0.0 PORT=8000 deno task start  Start LAN server"
            echo "  nix run .#lan                           Build + start LAN server"
            echo "  nix run .#live                          Watch + rebuild + restart LAN server"
            echo "  nix run .#proxy                         Run Caddy reverse proxy"
            echo ""
            echo "Proxy env:"
            echo "  GAME_HOSTNAME=your-hostname.local GAME_PORT=8000 nix run .#proxy"
            echo ""
          '';
        };

        formatter = pkgs.nixfmt;
      }
    );
}
