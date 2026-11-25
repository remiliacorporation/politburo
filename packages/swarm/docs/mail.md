# Task mail

`swarm mail relay --board URL [--once]` reads every claimed task whose `work.id` is a `plb` id. Each new reply from a person becomes one letter to the claimant.

A letter is a message in `mail/<handle>`, where `<handle>` is the claimant's handle. A handle that is not a channel segment is lowercased when that form is. Its labels are `mail.from` (the author's handle), `mail.task` (the task id), `mail.reply` (the reply id), and `mail.state=pending`. A second pass does not write that reply again.

The claimant's own replies are not letters. A reply from the same principal as the relay is the spawner's own note, and is not a letter. A reply that is not from a person is not a letter.

The letter's text names the author, the task, the claim binding's `session` when the claim has one, and the reply, then the reply's text. The session is the chat the spawner pastes the letter into.

A deliverer marks a letter `mail.state=delivered` and may set `mail.delivered` to the delivery time. When the time is missing, the relay records it. The first deliverer is the spawner. Once a letter is delivered, the reply's thread has one message, `delivered to <handle>`.

`--once` makes one pass and exits. Without it, the command follows the board's events and passes again when a message is posted, labels change, or a task changes. It exits 130 on Ctrl-C. A board that does not stream events exits 1; pass `--once` there.

A missing or unusable `--board` exits 2. A board that does not answer exits 1.
