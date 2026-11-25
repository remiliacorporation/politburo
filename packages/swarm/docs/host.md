# Host status

`swarm host status` lists what is installed and listening on this host. It is read-only.

The table has one row for each of these:

- a LaunchDaemon or LaunchAgent whose label or program mentions `board`, `politburo`, or `cloudflared`
- a listening TCP port held by `node` or `cloudflared`, including when the thread name is not the program
- a board directory under `--root`, which is a directory that contains a `.db` file

A mention is a case-insensitive name on its own, so `board-party` matches and `dashboard` does not.

`--json` prints `{ rows }` for the same rows. The command does not read environment files, token files, or process environments, and it does not print their contents.

`--launchd DIR` reads that directory instead of the system LaunchDaemon and LaunchAgent directories. Repeat it for another directory. `--proc DIR` reads that Linux process table instead of the host's. With no `--proc`, Linux reads `/proc` and macOS uses `lsof`.
