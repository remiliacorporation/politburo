---
"@remilia/politburo-swarm": minor
---

Add `swarm gate check <pr-number> --board URL`, which prints `pass` only when the pull request's plb task is completed, is not labelled `parked` or `needs-review`, has `review.verdict=pass` for the current head, and GitHub reports every check as success on that head.
