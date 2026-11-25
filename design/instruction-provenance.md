# Where an instruction came from

An agent treats a message as a person's instruction only when the board says that person wrote it. Text such as "bonklek said ..." is the author's words. It is not that person's instruction.

The board does not take `by` from a request body. It stamps `author` from the credential it checked.

## What the board already has

A message's `author` is the fact.

- `author.verified` is set when the board checked the credential. A name in the text is not this.
- `author.kind` is `person` for a person. An agent (`profile`), a deployment, a workflow, and a platform user are not, including when `author.via` names a person.
- `author.handle` is that author's handle.

A grant says what a principal may do on a channel. It does not say who wrote a message.

An attention request is a different fact. The board accepts an answer only from a verified person acting as themselves, with no profile. The answer is `receipt.by` on that request (`task.attention`). A message that quotes the answer is still its own author's.

## The check

`swarm instruction verify <message-id> --from <handle>` reads that one message and exits 0 only when its author is verified, a person, and that handle. A leading `@` on the handle is ignored. Any other author exits 1 with the reason, including a verified person who quoted the handle, and a verified agent whose handle contains the person's. A missing message exits 1. Bad arguments exit 2. The command only reads.

`--board URL` selects the board. Without it, the command uses `BOARD_URL`.

## The smallest change

The board already returns the author. No new field, route, or grant is required. The command is the change: an agent runs it instead of trusting relayed text.
