# Sync agent skills

Run `swarm skills sync --dir ./agent-skills --party party.yaml` to install skills.
Use `--repo` for repo overrides, `--dry-run` to preview, `--force` to replace unmarked files, or `--json` for file actions.

Run `swarm skills plan-mob --skills ./agent-skills --tag plb --job build --serial 1` to preview a mob and its brief without launching it or writing files.
