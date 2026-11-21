---
"@vercel/board": minor
---

**BREAKING for local boards with stored OIDC subjects ending in `*`:** upstream 0.54.0 matches `:*` and `/*` at the end of `sub` as prefixes instead of literals. A local board refuses grant-dependent requests with 403 `oidc_star_review_required` until each stored subject ending in `*` is reviewed. As a person with manage, run `vb grants list`, then `vb grants acknowledge <id>` to keep the prefix or `vb grants update <id>` to replace the starred principal with an exact subject. `vb grants revoke <id>` also clears its review. New grants keep upstream prefix matching.
