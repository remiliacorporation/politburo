# Sprite layer

The files below are moved unchanged from cloud setup script v10.

The cloud setup script installs these helpers in the directory of the `pi` binary:

- `pi-auth-ensure`: Seeds and refreshes pi's local credentials from the environment.
- `pi-task`: Runs pi on a task file with idle and overall time limits.
- `sprite-start`: Starts a named task in the background.
- `sprite-watch`: Follows a named task's event log and reports its status.
- `sprite-stop`: Stops a named task.

The script installs `codex-cursor-fallback.ts`, the Codex and Cursor fallback
router, in `~/.pi/agent/extensions`. It installs `models-store.json`, the model
catalog, in `~/.pi/agent`.

The script uses `cursor-provider.patched.ts` to replace `provider.ts` in
`@ifi/pi-provider-cursor` 0.5.1 only when the existing file's MD5 is
`018877a6b1e7e93d26dab08c02f786e7`.
