# Cutover

`swarm cutover rollback <tag> --execute` restores the service if the final
bridge drain is stale and the old loop is confirmed stopped. Add `--allow-stale`
to accept stale files and finish in files mode instead (exit 1, `rolled_back_stale`).
