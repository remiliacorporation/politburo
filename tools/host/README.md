## backup and restore

Requires Node 22.18 or newer.

```sh
node tools/host/board-backup.mjs --dir .board --out /opt/politburo/backups [--keep N]
node tools/host/board-restore.mjs --backup <backup-dir> --dir <target-dir> [--replace]
```

`board-backup` takes a point-in-time SQLite snapshot of each database, then
copies attachments. The board can keep running. Writes after a database's
snapshot starts may not be included, and databases have separate cutoffs.
Avoid starting or stopping the board during backup. If a crash leaves a WAL
without its shared-memory file, start and cleanly stop the board before retrying.
Completed `backup-*` directories contain `files/` and a versioned
`MANIFEST.json` with sizes and SHA-256 checksums. `--keep N` keeps the newest
N completed backups, where N is positive. No pruning happens without it.

`board-restore` verifies the backup before installing it. Use a missing or
empty target, or pass `--replace` for a non-empty one. Any displaced directory
is kept at the printed `.replaced-…` path. Stop the board on the target first,
even with `--replace`.

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

These tools and the templates move to `packages/swarm/host/` when that package
lands. Nothing in CI starts a service.
