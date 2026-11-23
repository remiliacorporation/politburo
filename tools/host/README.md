The tools and templates are still under `tools/host` and `design/ops-templates`. They move to `packages/swarm/host/` in a later change.

## backup and restore

Requires Node 22.18 or newer.

```sh
node tools/host/board-backup.mjs --dir .board --out /opt/politburo/backups [--keep N]
node tools/host/board-restore.mjs --backup <backup-dir> --dir <target-dir> [--replace]
```

`board-backup` takes a point-in-time SQLite snapshot of each database, then
copies attachments. The board can keep running. Writes after a database's
snapshot starts may not be included, and databases have separate cutoffs.
Avoid starting or stopping the board during backup. If `-wal` or `-shm` appears,
disappears, or is replaced during a snapshot, backup fails without publishing.
A read-only SQLite open can leave an empty `-wal` if the board stops just before
that open. Backup leaves it in place for SQLite to reuse or discard. If a crash
leaves a WAL without its shared-memory file, start and cleanly stop the board
before retrying.
Completed `backup-*` directories contain database snapshots and attachments
under `files/`, and a versioned `MANIFEST.json` with sizes, SHA-256 checksums,
and a random backup token. Backups contain no empty directories. The per-board
index `<out>/.backup-index.json` records each published backup's name, token,
directory device and inode, and SHA-256 digest of the exact manifest bytes.

`--keep N` keeps the newest N eligible backups, where N is positive. A
candidate must have a manifest digest in the index. Pruning moves it to a private
`.pruning-<random>` name and checks the manifest token, directory identity, and
digest against the index. It also checks that the files under `files/` match
the manifest's paths, sizes, and hashes, with nothing extra. If verification
fails, backup warns and tries to move the directory back without overwriting
anything at its original name. If the name is taken, the quarantine stays.

Pruning unlinks only verified files and removes verified directories from the
bottom up, never recursively. A file arriving after verification survives and
backup warns where the quarantine remains. A person removes leftover
`.pruning-*` directories. Copied, recreated or edited backups, unindexed backups,
and entries without directory identity or a manifest digest are not pruned.
No pruning happens without `--keep`.

The backup records the board directory's device and inode at the start. It
checks them and resolves the original `--dir` path again after the snapshots and
before publishing. If the directory was replaced or a symlink points somewhere
else, it fails with `board directory changed during the backup; retry` and
publishes nothing.

Backup syncs the new backup tree, index, and `<out>` before pruning older
backups. If a sync fails, backup publishes, warns on stderr, exits 0, and prunes
nothing. If the index is unreadable, backup also publishes without pruning and
leaves the index for a person to inspect.

Backup holds an exclusive lock on `<out>/.publish.lock`, a separate SQLite file,
for the whole run. The OS releases the lock if the process dies. Never delete
the file. Overlapping backups of one board take turns. A second run waits up to
10 minutes, then fails with `another backup of this board is running` if the
lock is still held. See `test/backup-retention.test.mjs` for test coverage.

`board-restore` copies entries into a fresh stage with exclusive creation and
checks their hashes. It refuses entries that differ only by case on every
platform. Those entries would overwrite each other on the usual case-insensitive
Mac volumes. After every copy and hash check is complete, it runs
`integrity_check` on each staged database. That is the last check before it
touches the target.

Use a missing or empty target. The script removes an empty target with `rmdir`,
which fails safely if it is no longer empty. An empty target needs no `--replace`
and leaves nothing beside it on success. A non-empty target needs `--replace`,
which keeps the old directory at the printed `.replaced-...` path. Stop the
board on the target first. A running board is refused even with `--replace`.

To install, restore creates the target directory exclusively, then renames the
stage onto that empty directory. If a directory appears at the target after the
checks, restore reports that it appeared, leaves it alone, keeps any old
directory aside under `.replaced-...`, and exits 1. Restore recovers the backed-up
files, not separate access setup or work since the snapshot.
See `test/restore-install.test.mjs` for test coverage.

Both commands exit 0 on success, 1 on failure, and 2 for invalid arguments.

## env wrapper

`run-with-env.sh <env-file> -- <command> [args...]` is the launchd program for
each service. Keep the env file outside the repo, owned by the service user,
mode `0600` or stricter. The wrapper reads literal `KEY=VALUE` lines without
running shell code, then replaces itself with the service, so launchd signals
the service directly. It exits 78 for a bad file and 64 for bad usage, and
never prints a value.

## log rotation

`node tools/host/rotate-logs.mjs --dir <log-dir> [--max-bytes N] [--keep N]`
copies each `*.log` over 10 MiB (default) to `.log.1`, shifts older copies up
to seven (default), then truncates the live file in place, so an append writer
keeps working. Lines written between the copy and the truncate can be lost.
Whether launchd's open log files behave this way on macOS is unverified; the
[runbook](../../design/host-runbook.md) drill checks it.

## service templates

`render-service.mjs --template <file> --values <file> [--set NAME=VALUE]
[--out <file>]` fills a plist template from
[design/ops-templates](../../design/ops-templates/README.md). It fails on a
placeholder with no value.

Nothing in CI starts a service.
