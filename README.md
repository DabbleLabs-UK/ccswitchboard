# CCSwitchboard

Orchestrate Claude Code jobs across your browser threads. CCSwitchboard gives you
a self-hosted relay - a small PHP job queue you run yourself - that sits between
the Claude threads open in your browser and the machines that actually do the
work. A browser extension submits jobs from any thread, a worker agent on your
VM or PC picks them up and runs them, and results flow back to the board. Nothing
routes through a third-party service: the relay is yours, the agent is yours, and
the queue lives in a SQLite file you own.

## Components

- **`board/`** - the PHP relay. A no-framework job-queue API over SQLite
  (`job.php`, `poll.php`, `result.php`, `jobs.php`) plus the web dashboard used to
  submit work, watch jobs, and manage machines. See `board/README.md` for the
  endpoint reference.
- **`browser-extension/`** - the browser side. Submits jobs from your Claude
  threads and picks up results, with automatic failover across multiple
  configured relays.
- **`agent/`** - the C# worker. A tray application that polls the relay for
  pending jobs, runs them on the host machine, and reports results back.
- **`desktop-relay/`** - the Windows tray app (Go, standard library only). Bundles
  the board and a PHP runtime so you can run your own relay by launching an exe,
  optionally exposing it through a Cloudflare quick tunnel. Build instructions in
  `desktop-relay/BUILD.md`.

Also included: `popup/` (a lightweight C# result-notification tray app),
`autostart/` (scheduled-task registration scripts), and `ccsw-curl.sh` (a curl
wrapper for hitting the relay by hand).

## Quickstart

> **Docs hardening in progress.** This is a skeleton of the intended path, not a
> finished install guide. Several steps still assume knowledge from the project's
> development history, and the exact commands are being tightened up.

1. Download the relay app from Releases.
2. Run it. You get a tray icon and your own board.
3. Load the browser extension.
4. In the board, go to Machines, add your PC, and run the installer it gives you.

## Protocol

`RELAY-PROTOCOL.md` documents the wire protocol between the relay, the agent, and
the extension.

## License

MIT - see `LICENSE`.
