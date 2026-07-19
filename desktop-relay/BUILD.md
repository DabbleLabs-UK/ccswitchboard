# Building the CCSwitchboard desktop relay (Windows)

Pure Go stdlib — no external modules. Cross-compiles from any OS.

1. Stage the board into the embed dir (the exe bundles the relay web app):
   webroot/ccswitchboard/board/  <- copy of ../board (the PHP relay), runtime files only
2. Build:
   GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "-H=windowsgui -s -w" -o ccsw-relay.exe .

Config (optional relay.config.json beside the exe): port, tunnelToken, publicUrl,
docroot, dataDir, basePath. With no config it self-extracts the bundled board,
serves it at /ccswitchboard/board behind a serializing-pool reverse proxy
(4 php workers), and opens a Cloudflare quick tunnel if cloudflared is present.
Requires php.exe next to the exe, in a php/ subfolder, or on PATH.
