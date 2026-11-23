# Parity cases

Temporary. These 65 cases were recorded from Tigeryard's code and copied here
unchanged from `bonklek/tigeryard` pull request 64 (branch
`claude/ty-parity-cases`, head `f79acf470b165d128c29614a88560f3a4d50ced3`).
They are deleted in WP-803, with the file bridge. Nothing registers or runs
them here; the Tigeryard runner and the case schema are in that pull request.

| Behaviour | Matrix row | Cases | Directory |
| --- | --- | --- | --- |
| Header schema | M04 | 7 | `header-schema/` |
| Mail delivery | M05 | 7 | `mail-delivery/` |
| Routing digest | M06 | 7 | `routing-digest/` |
| Expiry | M07 | 7 | `expiry/` |
| Check and push | M10 | 7 | `check-and-push/` |
| Check lock | M11 | 11 | `check-lock/` |
| Retire check | M12 | 10 | `retire-check/` |
| Serial counter | M13 | 9 | `serial-counter/` |

Each case file names its own row in `matrix_row`.
