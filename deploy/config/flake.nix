{
  description = "Homelab deployment manifest tool";

  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.2605";

  outputs = {nixpkgs, ...}: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};
    deploymentConfig = pkgs.buildGoModule {
      pname = "deployment-config";
      version = "1.0.0";
      src = ./.;
      vendorHash = "sha256-QE/EwVzMqUO24ZAl0WBibGx6x0kNo1AUTZtfnQvX50k=";
      postInstall = ''
        mv "$out/bin/config" "$out/bin/deployment-config"
      '';
    };
  in {
    packages.${system}.default = deploymentConfig;
    checks.${system}.default = deploymentConfig;
    apps.${system}.default = {
      type = "app";
      program = "${deploymentConfig}/bin/deployment-config";
    };
    formatter.${system} = pkgs.alejandra;
    devShells.${system}.default = pkgs.mkShell {packages = [pkgs.go];};
  };
}
