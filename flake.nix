{
  description = "Deno + Three.js multiplayer WebGPU game dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

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
          build = runBuild;
          server = runServer;
          proxy = runProxy;
          lan = runLan;
          live = runLive;
          default = runServer;
        };

        apps = {
          build = flake-utils.lib.mkApp { drv = runBuild; };
          server = flake-utils.lib.mkApp { drv = runServer; };
          proxy = flake-utils.lib.mkApp { drv = runProxy; };
          lan = flake-utils.lib.mkApp { drv = runLan; };
          live = flake-utils.lib.mkApp { drv = runLive; };
          default = flake-utils.lib.mkApp { drv = runServer; };
        };

        devShells.default = pkgs.mkShell {
          packages = runtimeTools;

          shellHook = ''
            echo "webgpu-mp-game dev shell"
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
      });
}
