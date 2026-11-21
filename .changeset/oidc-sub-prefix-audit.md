---
"@vercel/board": minor
---

**Breaking:** In 0.54.0, an OIDC grant's `sub` is a prefix match when its
only `*` is last, right after a `:` or `/` with a character before the
separator. `project_path:acme/api:*` matches `project_path:acme/api:ref:main`.
Other stored `sub` values, including a bare `*` or a star elsewhere, match
exactly. Grants stay as written. A stored literal in prefix form now matches
every subject that starts with the text before `*`, if the issuer and the
other claims match.

Audit stored subjects **before upgrading** an existing board that stores and
decides its grants locally. Set `BOARD_URL` to its API URL and run
`vb grants list --json` with `manage` at `*`. The audit lists every OIDC
`sub` value ending in `*`, including array entries. Only values in the
prefix form above change meaning. Keep intended prefixes. Leave non-prefix
literals such as `job:archive*` unchanged. Use `vb grants update` with
`--remove-oidc` and `--add-oidc` to replace a literal in prefix form with
an exact subject or tighten the grant before upgrading.

Before and after each change, check each affected caller's access on the
channels that matter with `vb grants explain <channel>`. Keep any restriction
the grant alone enforces, or recreate it before the change. Vercel's API
decides its own grants. Its operators choose whether to audit them with
Vercel's own tooling.
