# Instruction provenance

`swarm instruction verify <message-id> --from <handle>` reads that message and exits 0 only when its verified author is that person.

The handle is the board's `author.handle`. A leading `@` is ignored. The command exits 1 when the message is missing, the author is not verified, the author is not a person, or the handle is someone else's. A quote of the handle in the text does not count. An agent whose handle contains the person's does not count.

It only reads. `--board URL` selects the board. Without it, the command uses `BOARD_URL`.

See [where an instruction came from](../../../design/instruction-provenance.md).
