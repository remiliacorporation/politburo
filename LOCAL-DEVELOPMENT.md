# Local task and review loop

Use the CLI built from this checkout to rehearse a handoff with a fictional
repository (`acme/web`). This runs only a local board. The
[Factory template](./templates/factory/README.md) and the
[configure-factory-board skill](./skills/configure-factory-board/SKILL.md)
cover the hosted setup; neither is required here.

## Start a disposable board

From the checkout root, with the Node and pnpm versions in
[`package.json`](./package.json), build only `@vercel/board`:

```bash
pnpm install --frozen-lockfile
pnpm --filter @vercel/board build
```

Use an unused loopback port; if the example port is busy, choose another and
update the URL below. Run this in a dedicated terminal and leave it open:

```bash
umask 077
export BOARD_DEMO_DIR="$(mktemp -d)"
export XDG_CONFIG_HOME="$BOARD_DEMO_DIR/config"
printf 'Config directory: %s\n' "$XDG_CONFIG_HOME"
node packages/board/dist/cli.mjs serve --port 4180 --dir "$BOARD_DEMO_DIR/data" --no-inspect
```

`--dir` keeps SQLite and attachments out of the checkout. The CLI stores the
local login and claim receipts under `XDG_CONFIG_HOME`. This login has full
access to the disposable board; profiles distinguish writers, not permissions.
Use trusted processes under the same OS user. Do not expose the port or copy
credentials into worker prompts or the repo. See [Local boards](./packages/board/docs/01-board/10-local.md).

## Queue the fixture and hand it to a worker

Once the board reports that it is serving, open a second Bash terminal at the
checkout root and enter the config directory printed in the first terminal:

```bash
read -r -p 'Config directory: ' XDG_CONFIG_HOME
```

Clear inherited board name, token and profile settings before using the local
login:

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
export XDG_CONFIG_HOME
export BOARD_URL=http://127.0.0.1:4180/api/board
vb() { node packages/board/dist/cli.mjs "$@"; }
vb tasks create demo/acme/web 'For fictional acme/web, draft a wording-only README change. Fixture: `A sample app.` Replace it with `A sample app for local task handoffs.` Report the exact replacement and check; do not publish.' --no-sync
```

Start Pi separately on the same machine. Use the same checkout, board settings
and `vb` function in the worker's shell. Give it the task ID printed above, the
fixture scope, and authorization for this rehearsal only. The board does not
start or wake Pi. The worker sets `TASK_ID` to the printed ID and reads the
thread:

```bash
vb read "${TASK_ID:?Set TASK_ID to the printed task ID}"
```

Confirm the task is ready, then claim that exact task:

```bash
vb --as demo-worker tasks claim "$TASK_ID" --lease 15m
```

Stop if another worker owns it or the claim fails. Use the same URL, config
directory and profile for renewals and settlement. For real local changes,
work in a separate worktree, pin the base, and keep the patch and check results
outside Git. A lease fences task settlement, not filesystem writes. See
[Tasks](./packages/board/docs/01-board/11-tasks.md) and the
[CLI task reference](./packages/board/docs/04-reference/01-cli.md#tasks).

## Leave a review candidate and clean up

For this text-only fixture, compare the proposed replacement with the task
before posting. For a repository change, include the exact base, changed scope,
checks actually run, limitations, and the candidate patch or an accessible
private artifact reference with its digest. Keep the task body intact.

```bash
vb --as demo-worker reply "$TASK_ID" --no-sync --idempotency-key "demo-review-$TASK_ID-v1" \
  'Candidate: replace `A sample app.` with `A sample app for local task handoffs.` Checked against the fixture text. No repository or app tests run.'
vb --as demo-worker read "$TASK_ID"
```

Confirm the reply is present before completing the task. Reuse the reply key
only when retrying the same content. If you cannot finish, report why in the
thread and use the applicable task transition rather than claiming success.

```bash
vb --as demo-worker tasks complete "$TASK_ID" 'Candidate recorded for human review'
vb read "$TASK_ID"
```

Verify the reply and completed state. Completion hands off the candidate; it
does not approve or publish anything. Stop `serve` with Ctrl-C, confirm the
listener is gone, then remove the temporary directory from the first terminal
(`rm -rf -- "$BOARD_DEMO_DIR"`).
