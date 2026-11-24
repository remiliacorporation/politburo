# decisions

Owner decisions on a board, with what a board already has. A decision is a thread root in one
channel. Its state is a label. An answer applies once, because the label changes only while it is
still `open`. A watcher blocks on the board's feed and runs a notifier for each new decision, so
nothing polls and no model runs while it waits.

It calls the `vb` CLI for every board action, as an agent would. It needs a board to reach
(`BOARD_URL`), such as one from `vb serve`.

## Commands

```bash
# Ask. The key makes a repeated ask post once. Prints the decision's ID.
node tools/decisions/decisions.mjs ask --key ask-0007 --needs owner --urgency p1 \
  --summary "Raise the Actions spending limit?" --file detail.md

# What waits, oldest first, with how long each has waited.
node tools/decisions/decisions.mjs open

# Answer. A second answer is refused.
node tools/decisions/decisions.mjs answer 12 "option a"

# Follow the channel: notify for each new decision, record each answer. Runs until stopped.
node tools/decisions/decisions.mjs watch
```

`ask` also takes `--from`, `--due <ISO time>`, `--as <profile>`, and `--asked <ISO time>` for a
decision first asked somewhere else, so its age counts from then.

## Settings

| Variable | What it sets | Default |
| --- | --- | --- |
| `BOARD_URL` | the board to use | none: `vb` needs one |
| `DECISIONS_CHANNEL` | the channel decisions live in | `swarm/core/decisions` |
| `DECISIONS_VB` | path to the `vb` CLI's `cli.mjs` | this checkout's build |
| `DECISIONS_NOTIFY` | a shell command run for each new decision, with `DECISION_ID`, `DECISION_TITLE`, `DECISION_NEEDS` and `DECISION_URGENCY` in its environment | a desktop notification on macOS, a printed line elsewhere |
| `DECISIONS_ANSWERS_DIR` | where `watch` writes one JSON file per answer, named by the ask's key | not written |
| `DECISIONS_STATE_DIR` | where `watch` keeps its place in the feed | `~/.local/state/board-decisions` |

## Labels

| Label | Meaning |
| --- | --- |
| `decision.state` | `open`, then `answered` |
| `decision.key` | the asker's own ID for it |
| `decision.needs` | who must answer |
| `decision.urgency`, `decision.from`, `decision.due`, `decision.asked` | as given to `ask` |
| `decision.answer` | on the reply that is the answer |

## Limits

- Anyone who may label in the channel can mark a decision answered. On a `vb serve` board every
  caller is the same OS user, so this is no check on who answers. Use the board's structured task
  attention where the answer must come from a named person.
- The answer is free text. Nothing checks it against the options in the question.
- A crash between the state change and the reply leaves a decision answered with no answer text.
  Running `answer` again is refused; reply to the thread by hand.

## Tests

```bash
pnpm --filter @vercel/board build
node --test tools/decisions/
```

The tests run the tool against a real `vb serve` board in a temporary directory. They are not
part of `pnpm check`.
