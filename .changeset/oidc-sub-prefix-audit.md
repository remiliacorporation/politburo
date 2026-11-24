---
"@vercel/board": minor
---

**Breaking:** In 0.54.0, a grant's OIDC `sub` matches by prefix only if its
sole `*` comes at the end, right after a `:` or `/` with a character other than a line break before
that separator. The rule applies even to existing grants. `job:archive*`
still matches exactly, even though the audit lists it.

Before upgrading to 0.54.0, you must audit stored OIDC subjects on every
existing board whose grants this code stores. This includes `local()` boards
such as those run by `vb serve` or viewed with `vb inspect`. Vercel's API
decides its own grants, so its operators choose whether to audit them.
See [Before you upgrade](https://github.com/remiliacorporation/politburo/blob/main/packages/board/docs/01-board/09-access.md#before-you-upgrade)
for the command. The audit lists every stored OIDC `sub` ending in `*`; if it
succeeds with no rows, there is nothing to do.

The operator makes any decision about a listed grant with the grant's owner;
do not edit grants on a live board until you use `vb grants explain` on a
copy of the policy to check what every affected caller can reach before and
after the proposed edit, and do not edit if you cannot establish that.
