# Host service templates

Use system LaunchDaemons in `/Library/LaunchDaemons` on the Mac Studio. They
start at boot without a login. Do not use LaunchAgents. See the
[host runbook](../host-runbook.md) for installation, permissions, and drills.
Neither rendering nor CI installs or starts any service.

Move these templates and the host tools to `packages/swarm/host/` when
`packages/swarm` lands.

| Service | Installable now? | Role |
| --- | --- | --- |
| `board-party` | Yes | Party board, loopback only |
| `board-repo` | Yes | Repo board, loopback only |
| `backup` | Yes | Nightly snapshot, one job per board |
| `rotate-logs` | Yes | Daily rotation at 04:00 local time |
| `relay` | NO until the swarm CLI exists | Cross-board mail |
| `secretary` | NO until the swarm CLI exists | Secretary loop |
| `ledger` | NO until the swarm CLI exists | Spend ledger |
| `mirror` | NO until the swarm CLI exists | Repo mirror |
| `watch` | NO until the swarm CLI exists | Watch loop |

## Values

The examples are not live configuration. Use absolute paths, pinned builds,
and dedicated non-admin accounts.

| Name | Meaning | Example |
| --- | --- | --- |
| `LABEL_PREFIX` | Reverse-DNS prefix for job labels | `org.example.politburo` |
| `HOST_BIN` | Directory with the executable wrapper and host scripts | `/opt/politburo/tools/host` |
| `NODE` | Node executable (22.18 or newer) | `/opt/politburo/bin/node` |
| `BOARD_CLI` | Built board CLI | `/opt/politburo/packages/board/dist/cli.mjs` |
| `SWARM_CLI` | Future built swarm CLI | `/opt/politburo/packages/swarm/dist/cli.mjs` |
| `CONFIG_ROOT` | Directory for per-service env files | `/etc/politburo` |
| `DATA_ROOT` | Parent of each service's private working directory; a backup copies a board's whole directory | `/var/lib/politburo` |
| `HOME_ROOT` | Parent of each service's private home, kept outside every backed-up directory | `/var/lib/politburo-home` |
| `LOG_ROOT` | Log directory | `/var/log/politburo` |
| `BACKUP_ROOT` | Parent of board snapshot directories | `/var/backups/politburo` |
| `SERVICE_PATH` | Daemon `PATH` | `/opt/politburo/bin:/usr/bin:/bin` |
| `SERVICE_GROUP` | Job group | `_politburo` |
| `BOARD_PARTY_USER` | Party board account | `_politburo_board_party` |
| `BOARD_REPO_USER` | Repo board account | `_politburo_board_repo` |
| `RELAY_USER` | Relay account | `_politburo_relay` |
| `SECRETARY_USER` | Secretary account | `_politburo_secretary` |
| `LEDGER_USER` | Ledger account | `_politburo_ledger` |
| `MIRROR_USER` | Mirror account | `_politburo_mirror` |
| `WATCH_USER` | Watch account | `_politburo_watch` |
| `LOG_USER` | Log directory and file owner | `_politburo_logs` |
| `PORT_PARTY` | Party board loopback port | `4101` |
| `PORT_REPO` | Repo board loopback port | `4102` |
| `BOARD_ID` | Board directory and backup label suffix | `party` |
| `BACKUP_USER` | Same account as the board being backed up | `_politburo_board_party` |
| `BACKUP_HOUR` | Local start hour (0 to 23) | `3` |
| `BACKUP_MINUTE` | Local start minute (0 to 59) | `0` |
| `BACKUP_KEEP` | Number of snapshots to retain | `7` |

## Render and lint

From the repo root, render into a staging location, not the launchd directory:

```sh
node tools/host/render-service.mjs \
  --template design/ops-templates/launchd/board-party.plist.template \
  --values design/ops-templates/values.example \
  --out /tmp/org.example.politburo.board-party.plist
xmllint --noout /tmp/org.example.politburo.board-party.plist
# On the Mac:
plutil -lint /tmp/org.example.politburo.board-party.plist
```

The values file uses `NAME=VALUE` lines. Blank lines and lines beginning with
`#` are ignored. Repeat `--set NAME=VALUE` to override values used by that
plist. Omit `--out` for stdout. The installer sets the final plist mode to
0644. Lint does not check that paths or accounts exist on the target Mac.

Render `backup` once per board. For the repo backup, set `BOARD_ID=repo` and
set `BACKUP_USER` to the same account as `BOARD_REPO_USER`. This lets the
read-only WAL connection open the board-owned `-shm` file. The backup does
not take the board's `.lock`. The scheduled jobs do not take env files.

## Runtime env and logs

Each daemon reads its own `CONFIG_ROOT/<service>.env` through the executable
`run-with-env.sh`. Make the file a regular file owned by that daemon's account
with mode 0600. Keep credentials only in these env files, never in a plist,
values file, command line, or log. The current `board-party` and `board-repo`
commands require no env variables, so their env files can be empty. The
expected env variable names for relay, secretary, ledger, mirror, and watch
are not defined yet. Confirm and document those names when the CLI lands.

Pre-create the `.log` files under `LOG_ROOT` owned by `LOG_USER` so rotation
can read and truncate them. Keep archives private to that account. If the
service needs direct log access, grant only traversal and append to its own
log via an ACL, not write access to the log directory. Verify capture and
rotation on the Mac as described in the runbook.
