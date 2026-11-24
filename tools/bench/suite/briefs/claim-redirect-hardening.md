# Keep claim proof on the configured board

A request carrying a task claim's proof must go only to the configured board
URL. Refuse redirects with the handle's `redirect_refused` error rather than
retrying the request at another URL. This applies even if the destination is
on the same origin, the redirect has no usable Location, or the browser gives
back an opaque redirect. A 304 is not a redirect to follow.

Add an explicit `claim: true` option to the handle's `request()` for callers
that carry proof. Have task helpers mark their claim-bearing requests and
preserve that policy through the HTTP backend and the Node and browser
transports. Treat inspector proxy writes and forwarded uploads as nonredirecting
without inspecting request bodies. Leave normal reads and nonclaim redirect
behavior alone.

Start in `packages/board/src/client/client.ts` and `client/node.ts`. Also check
`packages/board/src/server/backend-http.ts` and both proxy entry points in
`packages/board/src/inspect/`. Use `pnpm check` to check your work.

Do not commit, do not read any git history beyond the working tree.
