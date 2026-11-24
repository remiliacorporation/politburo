# Allocate serials and names

`swarm alloc serial` claims the next mob serial as an exclusive file under `serials/` in `--dir`, or in `SWARM_SERIAL_DIR`. `mob-serial.txt` is a best-effort mirror of the highest claim and can lag. Pass `--json` for `{ "serial": N }`. A serial is never reused.

`swarm alloc name` takes the next free name from the party config pools:

```text
swarm alloc name <spawner|secretary|species|item> [JOB]
  --in-use NAME [--in-use NAME ...] [--json] [--party FILE] [--repo FILE]
```

`species` and `item` take one job. `spawner` and `secretary` take none. Repeat `--in-use` for each live name. One empty `--in-use` means none are in use.
