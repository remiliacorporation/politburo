---
"@vercel/board": minor
---

Let local boards gate task completion on commit-specific submission, tests, and review, with optional browser QA, acceptance, and publication gates. Record expiring attestations and audit overrides. Boards can also opt in to requiring an explicit evidence reference to release each task dependency. Use the task SDK or `vb tasks submit`, `evidence`, `attest`, `override`, and `resolve`.

The five work evidence methods are optional on custom backends. Unimplemented methods return 501 `no_work_evidence`. An HTTP completion that names a commit returns the same error if the remote board cannot check it, without completing the task. Evidence must still pass when completion is written, and workers must be able to read each prerequisite to use its release.

The four work evidence events wake matching local watchers. Conformance on a release-only board requires a successful explicit resolution.

The CLI escapes control characters in evidence text and keeps the selected board and profile flags in evidence recovery commands.

Leases and evidence releases are checked when a write lands, not before: a claim, renewal, submission, completion, resolution, unblock, unpark, or reopen that waits to append while its lease or verdict expires fails or routes to waiting, as it would have a moment later. These writes test only prerequisites the caller can read. An HTTP handle never follows a redirect on a completion that names a commit, a custom backend without `workEvidence` gets 501 `no_work_evidence` for one, and a board that advertises gates and releases can be checked with `conformance(board, { workEvidence: { second } })`.
