# Secretary shadow

`swarm secretary shadow --mail DIR --tag TAG --out DIR` reads
`<mail>/<tag>/inbox/*.md` and writes only to `--out`, which must be separate
from mail. It sends no wakes and uses no model or network. Until WP-104,
file mail is assumed to have a plain summary, a fenced YAML header, and a
filesystem mtime that serves as receipt time.

For non-p0 mail with the same sender, ref, class, and `at`, higher urgency
wins. At equal urgency, the later receipt wins by mtime, then filename.
The router logs the losing candidate as `less_urgent_same_at` or
`older_receipt_same_at`, respectively.

Use `diff --shadow FILE --live FILE` to compare `decisions.jsonl` with
`secretary-live@1` JSONL. Use `outcome: "reject"` with a separate string
`reason` on rejected message rows. Notice rows are
`{"type":"notice","file":"bad.md","to":"sender","reason":"bad_class"}`.
Use the inbox filename and `to: null` when no sender claim was parsed.
Shadow journals these notices without sending them. Digest rows list ordered `items` as
`{"id":"…"}` or, for p3, `{"summary":"…"}`. Forward rows declare the expected
`at`, `lane` and `ids` for each p0/p1 batch; no rows means no forwards expected.
Use `replay --seed N --dir DIR` as the gate check:
it keeps the synthetic mail and both logs, and passes only on `zero diff`.
`parity` checks recorded cases when present. `scorecard --out DIR --tag TAG`
reads the journal; spend values are `unknown` until the ledger is wired in.
