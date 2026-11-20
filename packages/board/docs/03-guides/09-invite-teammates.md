---
title: Invite teammates
description: Give someone access to a self-hosted board without asking them to sign in to Vercel.
---

## Make an invite

Invites work on self-hosted [`local()`](../01-board/10-local.md) boards, not
on Vercel's board. Use your existing OIDC credential with `manage` at `*`,
or the local owner credential on `vb serve`. A caller narrowed by
`x-board-can` or `as(..., { can })` cannot create, list, or revoke invites,
even if it keeps `manage` at `*`. Sandbox policies withhold all invite routes.

To rehearse on one machine, leave this running in a terminal:

```bash
vb serve --no-inspect
```

In another terminal, create an invite in a private directory using the URL
`vb serve` prints:

```bash
invite_dir=$(mktemp -d)
vb --url http://127.0.0.1:4100/api/board invite create ada \
  --out "$invite_dir/invite.txt"
```

The CLI creates a new file with mode `0600` and refuses to overwrite an
existing file. It never prints the invite secret, even with `--json`.
Send the file privately to the person named on the invite. Keep it out of
Git, chat logs, and other shared storage. Anyone with the file can redeem it
once before it expires. The default is 24 hours; `--expires-in` takes whole
seconds from 1 to 604800 (7 days).

Without `--can`, the invite grants `read`, `post`, `react`, and `label` in
all channels. For less access, pass explicit channel grants instead:

```bash
vb --url http://127.0.0.1:4100/api/board invite create sam \
  --out "$invite_dir/sam-invite.txt" --expires-in 3600 --can 'support/=read,post'
```

Repeat `--can` for more patterns. `sync` is opt-in and sharing does not
configure any integrations. Invites cannot grant `manage` or `all`.

## Join the board

Use the board URL the administrator gives you and read the invite from stdin.
This keeps the secret out of your shell history and process arguments:

```bash
vb join https://board.example.com/api/board - < invite.txt
vb --url https://board.example.com/api/board whoami
```

`join` does not require an existing credential. It saves the member's bearer
credential in `~/.config/board/joined/` (or under `$XDG_CONFIG_HOME`) for
that board URL and never prints it. Redeem at the exact public board URL,
including its mount path. `vb join` does not follow redirects, and the bearer
works only at that mount.

`whoami` shows the active identity and its grants. `BOARD_TOKEN` and a saved
`vb serve` owner credential take precedence over the saved join credential,
which comes before OIDC fallback.

The board names your principal from the invite. You can still use a
[profile](../01-board/03-identity.md#profiles), for example with `--as`.
A profile cannot edit or delete posts you wrote as your principal.

For the loopback rehearsal, use a separate config directory to keep the owner
credential from taking precedence:

```bash
member_config=$(mktemp -d)
env -u BOARD_TOKEN XDG_CONFIG_HOME="$member_config" \
  vb join http://127.0.0.1:4100/api/board - < "$invite_dir/invite.txt"
env -u BOARD_TOKEN XDG_CONFIG_HOME="$member_config" \
  vb --url http://127.0.0.1:4100/api/board whoami
```

## Remove access

`vb --url <url> invite list` shows invite IDs and states without secrets.
Use `vb --url <url> invite revoke <id>` to cancel a pending invite. The
expiry limits when someone can join, not how long they can use the board.
To remove a joined member's access, use
`vb --url <url> grants list --json` to find the grant with an `invitee`
principal whose ID matches the ID from `vb join`, then run
`vb --url <url> grants revoke <grant-id>`.

## Reach the board from another machine

Loopback is for rehearsal. For real teammates, run `local()` in a long-lived
Node process and serve its API through an HTTPS reverse proxy. Set `url` in
`board()` to the public URL, including the mount path. Give teammates that
same URL. The CLI accepts plain HTTP only on loopback.

You operate the network and TLS. The invite does not make the board
reachable. Keep the owner inspector private and expose only the board API.
Do not log request bodies or `Authorization` headers at your proxy, or log
responses that carry credentials.
