# Sprite layer

The cloud setup script installs these helpers in the directory of the `pi` binary:

- `pi-auth-ensure`: Seeds and refreshes pi's local credentials from the environment.
- `pi-task`: Runs pi on a task file with idle and overall time limits.
- `sprite-start`: Starts a named task in the background.
- `sprite-watch`: Follows a named task's event log and reports its status.
- `sprite-stop`: Stops a named task.

The script installs `codex-cursor-fallback.ts`, the sprite fallback router, in
`~/.pi/agent/extensions`. It installs `models-store.json`, the model catalog, in
`~/.pi/agent`.

The script uses `cursor-provider.patched.ts` to replace `provider.ts` in
`@ifi/pi-provider-cursor` 0.5.1 only when the existing file's MD5 is
`018877a6b1e7e93d26dab08c02f786e7`.

## Configure sprite routes

The router requires `PI_FALLBACK_TIERS` when it loads. Set it before launching
sprites in an environment with the extension installed:

```sh
PI_FALLBACK_TIERS="$(node packages/swarm/src/cli.ts sprite routes --party FILE)" &&
  export PI_FALLBACK_TIERS
```

Replace `FILE` with your party config path or omit `--party FILE` to use the
built-in defaults. The command also accepts `--repo FILE` for a repo layer.
The router tries the routes in the order listed in `tiers.models.sprite.routes`,
skipping providers that lack credentials or are cooling down.

`pi-task` defaults to `cursor/cursor-grok-4.6-high`. Set `PI_MODEL` to
`fallback/codex-cursor` to select the router instead of a direct model.
`PI_CODEX_AUTH` and `PI_CURSOR` still seed their respective providers.
