# Review record

`swarm review record <task-id> <pass|blocked> --head <sha>` posts a reply on that task and sets `review.verdict` and `review.head` to the verdict and the full commit.

`<task-id>` is the board task's message id. `--head` is 40 or 64 hex characters. The reply is the attestation:

```text
review pass
head aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
BLOCKING the deny list is dropped
```

`--finding TEXT` may repeat. Each finding is one line. With `--follow-up`, a finding that starts with `BLOCKING` or `FOLLOW-UP` becomes a new task in `plb/work`. That task waits for nothing and its text and `review.source` label name the source task. Other findings stay on the reply only.

`--board URL` selects the board. Otherwise the command uses `BOARD_URL`.
