# Host runbook

Nothing in this document has been run on the Mac Studio. This runbook covers
installing, supervising, backing up, and recovering the board host without a
login. It separates Linux VM evidence from the Mac acceptance checks.

The tools and templates are still under `tools/host` and `design/ops-templates`. They move to `packages/swarm/host/` in a later change.

## 1. Status and legend

**[host: not run]** marks a procedure to check on the Mac, not a passed check.
The installed macOS version, accounts, and host settings are unknown. Confirm
them before using these examples. Substitute every `{{PLACEHOLDER}}` first.

The Linux VM evidence is limited to these four items:

1. **[VM: verified]** This starts a board. SIGTERM stops it with exit 0 and
   releases the directory lock.

   ```bash
   node packages/board/dist/cli.mjs serve --swarm --no-inspect --dir '{{DIR}}' --port '{{PORT}}'
   ```

2. **[VM: verified]** Backup and restore scripts:
   `tools/host/test/backup-restore.test.mjs`.
3. **[VM: verified]** Env wrapper and log rotation:
   `tools/host/test/run-with-env.test.mjs` and `tools/host/test/rotate-logs.test.mjs`.
4. **[VM: verified]** Plist templates render to well-formed XML:
   `tools/host/test/templates.test.mjs`, using `xmllint`, not `plutil`.

VM evidence does not cover launchd, accounts, filesystem permissions across
users, sleep, power recovery, or FileVault. Nothing is installed by this runbook.

## 2. The services

**[host: not run]** This is a proposed layout, not a host inventory. Register
one stable deployment ID, directory, and port per board. Each board runs one
foreground `vb serve --swarm --no-inspect` process. Keep it on loopback and do not
expose the inspector. Tunnel and identity setup are separate work.

In the table, data paths are relative to `/var/lib/politburo`, and env files to
`/etc/politburo`. User and port placeholders are [template value names](ops-templates/README.md),
not existing host accounts or port assignments.

| Service | What it is | User | Port | Data dir | Env file | Template | Installable now? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Party board | Core mail and party state, one per party | `{{BOARD_PARTY_USER}}` | `{{PORT_PARTY}}` | `board-party` | `board-party.env` | `board-party` | Yes, pending host acceptance |
| Repo board | Intake and work, one per repo | `{{BOARD_REPO_USER}}` | `{{PORT_REPO}}`, distinct | `board-repo` | `board-repo.env` | `board-repo` | Yes, pending host acceptance |
| Relay | Delivers mail across boards | `{{RELAY_USER}}` | Unknown | `relay` | `relay.env` | relay | No, placeholder |
| Secretary | Routes mail, one per spawner | `{{SECRETARY_USER}}` per tag | Unknown | `secretary-{{TAG}}` | `secretary-{{TAG}}.env` | secretary, render per tag | No, placeholder |
| Ledger | Append-only spend authority | `{{LEDGER_USER}}` | Unknown | `ledger` | `ledger.env` | ledger | No, placeholder |
| Mirror | Posts Git and PR status | `{{MIRROR_USER}}` | Unknown | `mirror` | `mirror.env` | mirror | No, placeholder |
| Watch | Hosts watcher polling | `{{WATCH_USER}}` | Unknown | `watch` | `watch.env` | watch | No, placeholder |
| Backup | Nightly job per board | `{{BACKUP_USER}}`, that board's user | None | Board dir in; `/var/backups/politburo/board-{{BOARD_ID}}` out | None | backup, render per board | Yes, pending host acceptance |
| Rotate logs | Daily copy-truncate job | `{{LOG_USER}}` | None | `/var/log/politburo` | None | rotate-logs | Yes, pending host acceptance |

The `swarm` CLI does not exist yet. Do not load placeholder jobs.

| Path | Owner and mode |
| --- | --- |
| `/opt/politburo`, `releases`, `bin` | `root:wheel`, dirs `0755`; executable files `0755`, other deployed files `0644`. Root also owns the `current` symlink. |
| `/var/lib/politburo` | `root:wheel`, `0755`; each service's data dir is owned by its account, `0700`. The installer creates them before first boot. |
| `/var/lib/politburo-home` (`{{HOME_ROOT}}`) | `root:wheel`, `0755`; each service's home is owned by its account, `0700`, and is never inside a backed-up directory. |
| `/var/log/politburo` | `{{LOG_USER}}`, `0700`; precreate logs and keep archives private to that account, `0600`. Do not give daemons write access to the directory. |
| `/etc/politburo` | `root:wheel`, `0711`; each env file belongs to its service user, `0600`. |
| `/var/backups/politburo` | `root:wheel`, `0711`; each board's backup dir belongs to its board user, `0700`. |
| `/Library/LaunchDaemons` | Install rendered plists as `root:wheel`, `0644`. |

A service gets no write access to code, plists, shared parent directories, or
another service's data. Its env file and backup output are scoped to that
service. Use absolute paths and pin Node 22.18 or later.

1. **[host: not run]** The installer confirms the macOS version and account
   inventory. Check the on-host `dscl` manual and local account policy. Create a
   dedicated non-admin local service account per board and per daemon, with a
   unique ID and private home, no interactive login, and no admin membership.
2. **[host: not run]** Render each plist with the confirmed `UserName` and
   paths. For the layout here, point `HOST_BIN` and `BOARD_CLI` into `current`.
   The templates set `HOME` to `{{HOME_ROOT}}/<service>`, outside the data
   dir, because a backup copies the whole board directory and a home inside it
   would carry CLI credentials into every backup. In each board env file set
   `XDG_CONFIG_HOME` to a private directory under that home before first boot.

   Backup reuses the board account. Rotation runs as the log owner. Confirm
   launchd can open each private log. If needed, grant a daemon only traversal
   to the log and append to its own file by ACL. Verify this on the host.

## 3. Boot without a login

**[host: not run]** System LaunchDaemons start without a GUI login. LaunchAgents
are tied to a login session. Use the system domain and foreground processes.

1. **[host: not run]** Lint the rendered plist on macOS. Place it in
   `/Library/LaunchDaemons` with the ownership and mode above, then load it.

   ```bash
   plutil -lint '{{STAGED_PLIST}}'
   ```

   ```bash
   sudo launchctl bootstrap system '/Library/LaunchDaemons/{{LABEL}}.plist'
   ```

2. **[host: not run]** Verify that the job is loaded, with the expected state
   and last exit status. Do not paste the full job dump into logs or tickets.

   ```bash
   sudo launchctl print 'system/{{LABEL}}'
   ```

3. **[host: not run]** Force a restart when needed. For a planned restart,
   prefer bootout, verify exit, then bootstrap. A forced restart can interrupt
   requests and skip the board's clean close, including releasing SQLite
   connections in order. Committed WAL data is not a substitute for saved jobs.

   ```bash
   sudo launchctl kickstart -k 'system/{{LABEL}}'
   ```

4. **[host: not run]** Stop and unload the job. Bootout alone does not persist
   a disable across boot. Do not unlink `.lock` to speed up a restart.

   ```bash
   sudo launchctl bootout 'system/{{LABEL}}'
   ```

5. **[host: not run]** Disable to keep the job from loading. Boot it out as
   above if still loaded.

   ```bash
   sudo launchctl disable 'system/{{LABEL}}'
   ```

6. **[host: not run]** Enable before bootstrapping a disabled job again.

   ```bash
   sudo launchctl enable 'system/{{LABEL}}'
   ```

`KeepAlive` restarts exited daemons, not wedged listeners. `ThrottleInterval`
spaces out repeated starts. `ExitTimeOut` gives the board 30 seconds after
SIGTERM to close its listener and backend before launchd can force the stop.
Scheduled jobs run on a schedule, not with `KeepAlive`. See [Health](#10-health).

## 4. Power and boot

1. **[host: not run]** Confirm wired Ethernet, a DHCP reservation, and UPS
   coverage for the Mac and network gear. Use a maintenance window for tests.
2. **[host: not run]** Set AC system sleep off and restart after power loss on.
   Display sleep is fine.

   ```bash
   sudo pmset -c sleep 0 autorestart 1
   ```

3. **[host: not run]** Read back the AC settings.

   ```bash
   pmset -g custom
   ```

4. **[host: not run]** Check FileVault and decide how a cold boot is handled.
   Follow [Power loss and FileVault](#power-loss-and-filevault).
5. **[host: not run]** Confirm a current backup. With approval and services
   running, pull AC to the Mac downstream of the UPS. Confirm it loses power,
   reconnect AC, and observe restart from another machine. Record any FileVault
   prompt, when services become healthy, and whether anyone must log in.

## Power loss and FileVault

**[host: not run]** Whether FileVault is on or off on this Mac Studio is
**UNKNOWN**. bonklek does not know yet. This runbook assumes neither. The
installer finds out before go-live.

1. **[host: not run]** Run the check on the Mac Studio.

   ```bash
   fdesetup status
   ```

   The output says whether FileVault is on or off. Expect a line like
   `FileVault is On.` or `FileVault is Off.`; the exact wording is to be
   confirmed on the host. Record the answer in the acceptance table.

**Case 1, FileVault off.** The data volume is not locked at boot. After a power
loss, with `autorestart` set as in section 4, the Mac starts and LaunchDaemons
start with no login. The services come back on their own. Afterwards, check
that each service is up and that each board answers on its port
([Health](#10-health)).

**Case 2, FileVault on.** A boot without a login cannot unlock the disk. After
a power loss the Mac stops at the unlock screen. No service comes back until a
person unlocks it. Someone enters an authorized account's password at the
machine, or the disk is unlocked remotely. Whether this hardware and macOS
version support a remote unlock is **UNKNOWN**; the installer checks Apple's
documentation for this exact model and OS. This runbook does not claim any
remote-unlock method works. Until the unlock, the boards, the relay and every
other service are down, mail to them is not delivered, and backups do not run.
A planned restart can skip the unlock once with `sudo fdesetup authrestart`.
That is for planned restarts, not for power loss, and is to be confirmed on this
macOS version.

What to do:

1. **[host: not run]** Run `fdesetup status` and record the answer.
2. **[host: not run]** Decide with bonklek, who owns the risk, one of:
   - Turn FileVault off. This leaves an unencrypted disk in the office. Do not
     do it for uptime alone.
   - Keep FileVault on. Name the unlock owner, how to reach them, and the
     downtime the swarm tolerates until they unlock the machine.
3. A UPS makes power-loss events rarer. It does not remove Case 2.
4. **[host: not run]** Write the choice and the unlock owner into
   [section 11](#11-what-needs-a-person) and the acceptance table.
5. **[host: not run]** With approval, pull power as in section 4 item 5. Record
   whether the services returned unaided (FileVault off) or waited at the unlock
   screen (FileVault on).

## 5. Environment through files

**[host: not run]** One `/etc/politburo/{{SERVICE}}.env` per daemon, read only
by [run-with-env.sh](../tools/host/run-with-env.sh). It parses strict
`KEY=VALUE`. It refuses looser modes than `0600` and files not owned by the
running user. It never sources the file or echoes values.

Never put a secret in a plist, a renderer values file, or the repo. For a Node board
handle, `BOARD_URL` selects the board API. `BOARD_TOKEN` is the documented
explicit credential input, not a value to write here; use a separately
provisioned, scoped `vb join` identity where applicable. The Node handle also
recognizes `VERCEL_AUTH_TOKEN` for Vercel login, not for this setup.

The serving board gets port and directory from flags, not `BOARD_URL` or
`BOARD_TOKEN`. `XDG_CONFIG_HOME` keeps CLI access state outside board data. See
[the CLI reference](../packages/board/docs/04-reference/01-cli.md). Future swarm
credential names are unknown. Do not set the Jev key or Cloudflare inputs here.

1. **[host: not run]** As installer, set umask `077` before creating a new temp
   file in `/etc/politburo`. Write only non-secret settings, or use an empty file
   if none are needed. Set owner to the service user, confirm mode `0600`, then
   rename the temp file over the final name in that directory. Never edit the
   live file in place or print its contents.

## 6. Logs

**[host: not run]** `StandardOutPath` and `StandardErrorPath` use files under
`/var/log/politburo` scoped to each service. The daily job uses
[rotate-logs.mjs](../tools/host/rotate-logs.mjs), default 10 MB per file and
seven copies. Copy-truncate can lose a few lines between copy and truncate.

Copy-truncate relies on launchd opening logs for append. That behavior is
**UNVERIFIED** on macOS. Rotate a test log while the daemon is writing and
check that output resumes correctly in the same file. A rename alone does not
redirect an open writer.

Service authors log board ID, envelope ID, latency, result, and reason class.
Never log bodies or auth headers. This runbook cannot enforce log content.

## 7. Backup

### 7.1 The lock

[PR 78](https://github.com/remiliacorporation/politburo/pull/78) adds the [directory lock](../packages/board/src/store/directory-lock.ts).
A running board holds an exclusive SQLite lock on `<dir>/.lock`, separate
from `<name>.db`. A second board is refused (`409 board_dir_locked`); reach the
existing board with `--url` instead. Do not remove the lock file.

A second process can read `<name>.db` in WAL mode while the board writes. It
sees a consistent SQLite snapshot. Backup never takes `.lock` or writes in
the live dir. Do not copy just the live `.db`: it can
miss committed data in the WAL.

Run backup as the board user. The reason is that even a read-only WAL
connection opens the `-shm` file. This is permission reasoning, tested only as
the same user on the VM, not across macOS users.

### 7.2 Contents and ordering

The script snapshots each SQLite file first with the online backup API. Then
it copies attachments, writes `MANIFEST.json` with SHA-256 hashes and a random
backup token, and atomically renames `.partial-...` to `backup-...`. The per-board
index `<out>/.backup-index.json` records each published backup's name, token,
and directory device and inode for retention. A blob is written before its
referencing message, so the later blob copy covers references in the earlier
DB snapshot.

Ordering, checked in the code: the CLI awaits an upload before it posts. The
upload awaits the blob and its metadata, and `fsBlob.put` awaits each file and
its `.type` sibling. The local post resolves that metadata before it commits
the message. So a message in a snapshot never references a blob that the later
copy lacks. A blob copied after the snapshot may belong to no message in it;
that is harmless. A client that wrote a blob and never posted leaves the same
orphan. This order is a property of today's write path, not of the backup
script: re-check it if the write path changes.

The script holds an exclusive publish lock for the whole run. It uses
`<out>/.publish.lock`, a separate SQLite file. The OS releases the lock if the
process dies. Never delete the file. Overlapping backups of the same board take
turns. A second run waits up to 10 minutes, then fails with
`another backup of this board is running` if the lock is still held.

The script also records the board directory's device and inode when it starts.
It checks them again after the database snapshots and just before publishing. If
the path no longer names the same directory, for example the directory was moved
aside and a fresh board started there, the backup fails with
`board directory changed during the backup; retry` and publishes nothing.

Do not start or stop a board while its backup runs. The script compares the
`-wal` and `-shm` files before and after the snapshot. If either disappears,
is replaced, or appears during the snapshot, the backup fails without
publishing. Although the script does not write to the live directory directly,
a read-only SQLite open can leave an empty `-wal` beside the database if the
board shuts down between the script's checks and its open. The script leaves
sidecars alone. SQLite reuses or discards the empty `-wal`; this race has not
been verified on macOS.

An upload in flight is copied wherever it is. Such a partial blob is not in
the snapshot's messages, so nothing references it.

A backup contains database snapshots, attachments, and the manifest, not
`.lock`, live WAL sidecars, env files, or separate access configuration. It is
not a coordinated snapshot across boards or services. Relay, ledger, secretary,
mirror, and watch state are unknown until those services exist. Use the same
script for their SQLite directories only after checking their storage layout.

Decide how to recover the deployment manifest, access configuration, and env
files separately. Store the recovery material encrypted under restricted
ownership. Restore it only to the intended account with private permissions.

### 7.3 Schedule and retention

**[host: not run]** Schedule the backup plist nightly for each board. Run a
manual backup before each upgrade. Nightly means up to a day of loss if jobs
succeed. Monitor time since the last successful published backup, not merely
the last job start.

`--keep N` keeps the newest N eligible backups. A candidate must be in the
index and match its manifest token and directory device and inode. Pruning never
deletes in place. The script first moves the candidate to a private
`.pruning-<random>` name inside `<out>` and verifies it completely: the files
under `files/` are exactly the manifest's files with matching sizes and SHA-256
hashes, and nothing else is in the directory. It deletes the directory only if
it verifies. If it does not, the script moves it back (or leaves it under its
`.pruning-` name if the original name is taken), prints a warning, and deletes
nothing. A `.pruning-*` directory left by a crash is never deleted by the
script; a person removes it. A copied, recreated or edited directory stays even
at the original name. Unindexed backups and older entries without directory
identity require manual removal. Without `--keep`, nothing is pruned.

The index and the verification protect against stray and stale directories. They
do not protect against someone with write access to `<out>`, who can delete
backups directly.

The script syncs the new backup tree, index, and `<out>` before pruning older
backups. If a sync fails, the backup is published, the script warns on stderr
and exits 0, and nothing is pruned. If the index is unreadable, the script also
publishes without pruning and leaves the index for a person to inspect.
See `tools/host/test/backup-retention.test.mjs` for test coverage.

Choose an independent disk or existing NAS for encrypted copies, plus an
offline copy. The target and owner are open decisions. An on-machine copy
does not cover loss of the host disk.

### 7.4 Commands

1. **[host: not run]** Use the pinned Node and [backup script](../tools/host/board-backup.mjs)
   as the board user. Use this before an upgrade too. Here `BOARD_ID` is `party`
   or `repo` for the stock templates. Check exit status and the new directory.
   See [host tools](../tools/host/README.md) for the script interface.

   ```bash
   sudo -u '{{BOARD_USER}}' /opt/politburo/bin/node /opt/politburo/current/tools/host/board-backup.mjs --dir '/var/lib/politburo/board-{{BOARD_ID}}' --out '/var/backups/politburo/board-{{BOARD_ID}}' --keep 7
   ```

## 8. Restore

[board-restore.mjs](../tools/host/board-restore.mjs) takes `--backup` and `--dir`.
It copies each entry into a fresh stage with exclusive creation and checks its
hash. It refuses entries that differ only by case on every platform. Those
entries would overwrite each other on the usual case-insensitive Mac volumes.
After all copies and hash checks, it runs `integrity_check` on every database
in the completed stage. This is the last check before it touches the target.

Use an absent dir for drills. An existing empty target needs no `--replace`.
The script removes it with `rmdir`, which fails safely if it is no longer empty.
A successful restore into an empty target leaves nothing beside it. A non-empty
target needs `--replace`, which moves the old directory aside as `.replaced-...`
instead of deleting it. A running board is refused even with `--replace`.

To install, the script creates the target directory exclusively and renames
the stage onto that empty directory. If a directory appears at the target after
the checks, the script reports that it appeared, leaves it alone, keeps any old
directory aside under `.replaced-...`, and exits 1.
See `tools/host/test/restore-install.test.mjs` for test coverage.

### Restore drill

- [ ] **[host: not run]** Pick the newest published backup. Restore it into an
  absent second dir under a private scratch parent writable by the drill user.
  Backup directories are `0700` and owned by the board user: run the drill as
  that user, or as root and then hand the tree to the drill user.

  ```bash
  /opt/politburo/bin/node /opt/politburo/current/tools/host/board-restore.mjs --backup '{{BACKUP_DIR}}' --dir '{{DRILL_DIR}}'
  ```

- [ ] **[host: not run]** After restore, `ls -a` in the target's parent shows no `.restoring-*` directory.

- [ ] **[host: not run]** As the drill user, start a second board on an unused
  loopback port. Use the same disposable `XDG_CONFIG_HOME` for the server and
  its CLI reads, with no inherited `BOARD_TOKEN`. Use no proxy, relay, or workers.
  Check for due schedules and other external effects before starting a replica.

  ```bash
  /opt/politburo/bin/node /opt/politburo/current/packages/board/dist/cli.mjs serve --swarm --no-inspect --dir '{{DRILL_DIR}}' --port '{{DRILL_PORT}}'
  ```

- [ ] **[host: not run]** Compare message counts against the snapshot baseline,
  not a live board that can change. Page through the same known channels and
  threads. Read a known message as the drill identity and take its attachment
  ID from the CLI output. Download it and compare with the expected file.

  ```bash
  /opt/politburo/bin/node /opt/politburo/current/packages/board/dist/cli.mjs --url 'http://127.0.0.1:{{DRILL_PORT}}/api/board' read '{{MESSAGE_ID}}'
  ```

  ```bash
  /opt/politburo/bin/node /opt/politburo/current/packages/board/dist/cli.mjs --url 'http://127.0.0.1:{{DRILL_PORT}}/api/board' download '{{ATTACHMENT_ID}}' '{{DRILL_DOWNLOAD}}'
  ```

- [ ] **[host: not run]** Stop the foreground board with SIGTERM and confirm
  exit. Optionally confirm integrity yourself on each restored DB. Remove only
  the drill directory, downloaded file, and disposable drill home after checking.

  ```bash
  sqlite3 -readonly '{{RESTORED_DB}}' 'PRAGMA integrity_check;'
  ```

### Production restore

1. **[host: not run]** Block writes and pause clients and jobs that trigger
   external effects. Disable and boot out the target service. Confirm it exits
   and pause its scheduled backup until recovery is complete.
2. **[host: not run]** Restore with `--replace`, as root, because the target's
   parent is root-owned. The restored files then belong to root: hand the tree
   to the board user (next block) before starting the board. If the target was
   non-empty, the old directory is kept beside it as `.replaced-...`. Renaming
   does not change its owner. Use `chown` if the old data should be out of the
   board user's reach.

   ```bash
   sudo /opt/politburo/bin/node /opt/politburo/current/tools/host/board-restore.mjs --backup '{{BACKUP_DIR}}' --dir '/var/lib/politburo/board-{{BOARD_ID}}' --replace
   ```

   ```bash
   sudo chown -R '{{BOARD_USER}}' '/var/lib/politburo/board-{{BOARD_ID}}'
   ```

3. **[host: not run]** Enable and bootstrap the board with writes still blocked.
   Check the listener, authenticated reads, and an attachment. Reconcile the
   point-in-time state before enabling writes and backups. Do not replay
   external effects or previously approved jobs.

Restore recovers the database snapshots and attachments. It does not recover
env files, separate access setup, external effects, or work since the snapshot.
Relay and secretary owners must reconcile their state before resuming. The
procedure for those services is unknown until they exist.

## 9. Upgrades

1. **[host: not run]** Pin each build under `/opt/politburo/releases/{{VERSION}}`
   and use the root-owned `/opt/politburo/current` symlink. Back up first. Canary
   the new build on a replica with restored data and a different port.
2. **[host: not run]** Point `current` at the approved build. Restart and check
   one board at a time. Retain the previous release and a compatible snapshot.
   Do not downgrade in place after a storage change.

A restart drops pending [`local()` scheduler timers](../packages/board/docs/01-board/10-local.md).
Service authors must put critical deliveries and review deadlines in durable
jobs and reconcile them at startup.

## 10. Health

1. **[host: not run]** Check that each board answers on its port, then run an
   authenticated read against a known, restricted channel. `KeepAlive` does not
   detect a stuck listener or prove the read succeeded.
2. **[host: not run]** Check time since the last successful backup, free space,
   DB and WAL growth, and log sizes. Record a baseline and watch trends. An
   independent health job is later work. This repo does not build one here.

## 11. What needs a person

**[host: not run]** Plan section 10 item 4 needs access for core or a named
installer on the Mac Studio. Confirm the service user names and pick the
encrypted off-machine and offline backup targets. FileVault is **UNKNOWN**:
run `fdesetup status`, then record the choice and, if it is on, the unlock
owner, how to reach them, and the tolerated downtime, as in
[Power loss and FileVault](#power-loss-and-filevault).

This repo supplies tools and templates only. CI starts no host service. The
backup tests start disposable loopback boards as test fixtures, like the
existing CLI end-to-end tests; they install and load nothing. This
work does not install anything or perform a cutover.

## Acceptance on the Mac Studio

Date:

By:

| Check | How | Result |
| --- | --- | --- |
| Boot with nobody logged in | **[host: not run]** From another machine, use the approved remote admin path to probe loopback before any desktop login. Record any preboot unlock separately. | not run |
| Every installed service survives reboot | **[host: not run]** Reboot. Check each daemon's status and function and each scheduled job's next run and output. | not run |
| Power-loss restart | **[host: not run]** Pull power and restore it as in section 4. Observe power-on and service health. | not run |
| FileVault state and cold boot | **[host: not run]** Run `fdesetup status` (state is unknown). If on, observe the unlock gate and record the unlock owner and tolerated downtime; if off, confirm the services return unaided. See [Power loss and FileVault](#power-loss-and-filevault). | not run |
| Host restore drill | **[host: not run]** Restore to a second directory. Compare message counts and read an attachment on a different port. | not run |
| launchd log truncation | **[host: not run]** Copy-truncate a growing log. Confirm the writer stays healthy and new lines append to the live file without gaps from a stale offset. | not run |
| Live backup as board user | **[host: not run]** While the board writes, run its backup as that account. Check the published snapshot and verify it restores. | not run |
| Health after SIGKILL | **[host: not run]** Kill a pilot board with SIGKILL. Confirm KeepAlive restarts it, the new process retakes the lock, and an authenticated read succeeds. | not run |
| Disk and WAL growth | **[host: not run]** Track free space, DB and WAL sizes, log sizes, and backup age during ordinary load and a backup. | not run |
