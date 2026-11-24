---
title: Local contributor walkthrough
description: Start a local board, define a party, finish a task, and run the swarm tests.
---

## 1. Install and build

Use a Mac or Linux laptop with Bash, Git, Node 22.18 or later, and pnpm
11.23.0. The pnpm pin is in [package.json](../package.json). If you need to
install pnpm and have Corepack, use `corepack enable pnpm` to let it select
that version in this checkout. Otherwise, install that pnpm version directly.

macOS opens zsh by default. Run `bash` first in each terminal in this
walkthrough. The `read -p` prompts below work in Bash, not in zsh.

If you already have a fresh checkout, stay on your branch and run the
remaining commands from the checkout root. Otherwise, clone `main` into a
new directory and enter it:

```bash
git clone --branch main https://github.com/remiliacorporation/politburo.git
```

```bash
cd politburo
```

```bash
node --version
```

```bash
pnpm --version
```

```bash
git --version
```

```bash
pnpm install
```

Build the swarm package and its workspace dependencies. This also builds the
board CLI and inspector. The swarm tests use built dependencies and a built
swarm CLI.

```bash
pnpm --filter @remilia/politburo-swarm... build
```

## 2. Start the board

In a dedicated Bash terminal at the checkout root, create a private directory
outside the checkout. Keep the printed path for the other terminals.

```bash
umask 077
```

```bash
demo_dir=$(mktemp -d /tmp/politburo.XXXXXX)
```

```bash
printf '%s\n' "$demo_dir"
```

```bash
XDG_CONFIG_HOME="${demo_dir:?}/config" node packages/board/dist/cli.mjs serve --swarm --port 0 --dir "$demo_dir/data" --no-inspect
```

Leave this terminal running. Port `0` asks the OS for an unused loopback
port. Copy the API URL from the `serving a local board` line, including
`/api/board`. The board keeps its data and local login in the temporary
directory. Keep the board and inspector on loopback. See
[Local boards](../packages/board/docs/01-board/10-local.md) and
[Local development](../LOCAL-DEVELOPMENT.md).

## 3. Define your party offline

A party has a stable ID and its own names and policy. See the
[party config design](../design/swarm-party-config.md). This checkout accepts
a local party file through `swarm config`. It does not register the file on
the board or load it into the inspector. The local board login is separate.

In a second Bash terminal at the checkout root, paste the path from step 2
when prompted.

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```bash
cat > "${demo_dir:?}/party.yaml" <<'YAML'
party:
  id: local-demo
  name: Local Demo
  colour: '#356a8a'
YAML
```

```bash
node packages/swarm/dist/cli.js config validate --party "$demo_dir/party.yaml"
```

Look for `valid`. The file overrides the party ID, name, and colour. Other
settings use defaults. This command needs no network or credentials.

## 4. Open the work board and finish a task

Read [Work items and outcomes](../design/swarm-work-items.md) and the status
section of [Work lifecycle](../design/work-lifecycle.md). This exercise uses
one native board task, not dispatcher claims or outcome validation.

In both the second terminal and a third Bash terminal at the checkout root,
run the blocks below. Use the same temporary directory and API URL in both.

```bash
read -r -p 'Temporary directory: ' demo_dir
```

```bash
read -r -p 'Board API URL: ' board_url
```

```bash
unset BOARD_NAME BOARD_TOKEN BOARD_PROFILE BOARD_AVATAR
```

```bash
export XDG_CONFIG_HOME="${demo_dir:?}/config"
```

```bash
vb() { node packages/board/dist/cli.mjs --url "${board_url:?}" "$@"; }
```

In the third terminal, start the inspector. Open the inspector URL it prints
in your browser, not the API URL. Click **Work** in the sidebar.

```bash
vb inspect --port 0 --no-open
```

> [!NOTE]
> **Work** shows live open tasks, but it has no create, claim, or complete
> controls or history view in this checkout. Use the CLI for the writes and
> the inspector to verify each state. Do not turn on fixture mode.

In the second terminal, create a task. Copy its printed task ID. In the
browser, check that **Confirm the local work board** appears under
**Ready to pull**.

```bash
vb tasks create work/acme/web 'Confirm the local work board' --no-sync
```

```bash
read -r -p 'Task ID: ' task_id
```

Claim the task. Check that it moves to **Running now**. Seeing the row in
the browser is the work for this exercise.

```bash
vb tasks claim "${task_id:?}" --lease 15m
```

Complete the task before the lease expires. Check that the row leaves
**Work**. Then click **tasks** in the sidebar and select **completed**.
Confirm that the same task appears with the result `UI verified`.

```bash
vb tasks complete "${task_id:?}" 'UI verified'
```

## 5. Run the swarm tests

In the second terminal, run the suite and check that it reports no failures.

```bash
pnpm --filter @remilia/politburo-swarm test
```

## 6. Stop and clean up

Close the browser tab. Press Ctrl+C in the third terminal to stop the
inspector, then Ctrl+C in the first terminal to stop the board. When the first
terminal returns to its prompt, remove the temporary data, login, and party
file there.

```bash
rm -rf -- "${demo_dir:?}"
```

This walkthrough does not use a hosted board, an identity service, agent
launches, mail, skills, overlap reconciliation, spend capture, or tracker
integrations. `swarm watch run`, `swarm check run`, and `swarm check retire`
need GitHub access beyond cloning the repo and are not part of this loop.

For how the swarm layer fits together, read the
[swarm overview](../design/swarm-overview.md).
