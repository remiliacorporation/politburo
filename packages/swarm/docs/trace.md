# Task trace files

`swarm trace attach <task-id> --kind transcript|log|ci --file PATH [--source URL] [--board URL]` uploads that file as an attachment on the task's thread.

The message is labelled `trace.kind` with the kind. `--source` sets `trace.source` to that URL. A second attach adds another file. It does not replace an earlier one.

Before the upload, the command redacts secrets and leaves the rest of the text as it was. A private key block, the value of a header such as `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, or `X-Api-Key` (at any indent), the value of an env line whose name contains `auth`, `credential`, `cookie`, `session`, `secret`, `token`, or `password`, or whose name has `key` as its own segment, a password in a `scheme://user:password@host` URL, and a token or key written on its own become `[redacted]`. The file name and `--source` go through the same redaction before they are stored or printed.

`--board URL` selects the board. Without it, the command uses `BOARD_URL`. A missing task, a thread that is not a task, a missing file, or a file that is not utf-8 text exits 1. A bad argument exits 2.

The inspector's Trace tab lists these files by kind and opens one with line numbers and a search. It reads the file from the board.
