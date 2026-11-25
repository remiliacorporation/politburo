---
"@vercel/board": minor
---

`vb inspect --sign-in` and `vb serve --team-tokens` serve the inspector so each viewer signs in with their own token. The token stays in an HttpOnly cookie. A request with no token, or one the board refuses, gets the sign-in page or 401.
