# Parity cases

Temporary. These 266 cases were recorded from Tigeryard's code and copied here
unchanged from `bonklek/tigeryard` pull requests 64 (branch
`claude/ty-parity-cases`, head `f79acf470b165d128c29614a88560f3a4d50ced3`),
65 (branch `claude/ty-parity-cases-config-digest`, head
`7a6dcbbdb46ec7d14968234dd3eabc1f62b28f1b`), 67 (branch
`claude/ty-parity-cases-liveness-ci`, head
`9920bcc35d31a337912ae9610a7aaba9cb3833c7`) and 66 (branch
`claude/ty-control-plane-seed`, head
`035ce45dda7c69fb3de11418814822cb6ac5ea50`).
They are deleted in WP-803, with the file bridge. Nothing registers or runs
them here; the Tigeryard runner and the case schema are in those pull requests.
The 76 screenshots and the seeded board of pull request 66 are not copied;
see https://github.com/bonklek/tigeryard/blob/claude/ty-control-plane-seed/parity/board-screens/INDEX.md .

| Behaviour | Matrix row | Cases | Directory |
| --- | --- | --- | --- |
| Header schema | M04 | 7 | `header-schema/` |
| Mail delivery | M05 | 7 | `mail-delivery/` |
| Routing digest | M06 | 7 | `routing-digest/` |
| Expiry | M07 | 7 | `expiry/` |
| Owner decision | M09 | 8 | `owner-decision/` |
| Check and push | M10 | 7 | `check-and-push/` |
| Check lock | M11 | 11 | `check-lock/` |
| Retire check | M12 | 10 | `retire-check/` |
| Serial counter | M13 | 9 | `serial-counter/` |
| Liveness | M14 | 24 | `liveness/` |
| Swarm config | M16 | 8 | `swarm-config/` |
| Local CI | M18 | 24 | `local-ci/` |
| Exception digest | M19 | 8 | `exception-digest/` |
| Board CLI issues | M80 | 15 | `board-cli-issues/` |
| Board CLI messages | M81 | 14 | `board-cli-messages/` |
| Board server | M82 | 15 | `board-server/` |
| Controllers pause resume | M83 | 14 | `controllers-pause-resume/` |
| Attempt ledger | M84 | 14 | `attempt-ledger/` |
| Issue refill | M85 | 14 | `issue-refill/` |
| Review marks | M86 | 15 | `review-marks/` |
| Priority | M87 | 14 | `priority/` |
| Identity | M88 | 14 | `identity/` |

Each case file names its own row in `matrix_row`.
