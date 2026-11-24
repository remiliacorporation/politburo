# Sprite routes

`swarm sprite routes` prints `tiers.models.sprite.routes` as JSON. Pass `--party FILE` and `--repo FILE` for those layers. With neither, it prints the built-in defaults.

The router reads `PI_FALLBACK_TIERS` when it loads. Set that from the command before launching sprites where the extension is installed:

```sh
PI_FALLBACK_TIERS="$(node packages/swarm/src/cli.ts sprite routes --party FILE)" &&
  export PI_FALLBACK_TIERS
```

The router tries those routes in order and skips providers that lack credentials or are cooling down.

`pi-task` defaults to `cursor/cursor-grok-4.6-high`. Set `PI_MODEL` to `fallback/codex-cursor` to select the router.
