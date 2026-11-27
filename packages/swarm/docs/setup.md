# Setup script

`swarm setup build` prints the v11 cloud setup script. Use `--out setup.sh`
to write it to a file. V11 behaves exactly like v10; only the version line
and the gzip encoding of the same payload bytes differ.

To check the pin, compare `tail -n +3 setup.sh | sha256sum` with the hash on
line 2. The cloud environment caches its setup result, so core pastes the
new script text. The version line changes the text and forces a rebuild.

## Codex

`swarm setup build --target codex` prints three parts from that same script.
`--out-dir DIR` writes them as `setup.sh`, `maintenance.sh`, and `settings.md`.
Omitting `--target` still prints the Claude script above, byte for byte.

The setup script is the v11 script plus a final `pi-auth-ensure`. Codex strips
secrets before the agent phase. The v11 script's last auth step writes only
`PI_CODEX_AUTH` and `PI_CURSOR`, so the personal login would be lost.
`pi-auth-ensure` also reads `PI_CODEX_PERSONAL_AUTH`.

The maintenance script is `pi-auth-ensure`. Codex runs it when a cached
container resumes. A cached container can be up to 12 hours old.

The settings checklist says:

- Set `PI_CODEX_AUTH`, `PI_CURSOR`, and `PI_CODEX_PERSONAL_AUTH` as Codex
  secrets, not as environment variables.
- Set `PI_FALLBACK_TIERS` in the environment. An export in the setup script
  does not persist to the agent phase.
- Agent internet: On.
- Domain allowlist: All (unrestricted, bonklek's decision).
- HTTP methods: All.
