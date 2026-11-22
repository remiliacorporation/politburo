# Swarm configuration distribution

## Summary and ranked recommendation

**Recommendation 1 — use a small, stable, human-installed bootstrap plus signed GitOps-style runtime configuration.** Put a tiny verifier/launcher in the existing Anthropic-hosted environment setup script once. It verifies a signed manifest and bundle, keeps two local generations, and configures **pi and the model router** at each launcher invocation. The coordinator may submit narrowly scoped promotion requests to an office service; that service only publishes an already signed, schema-validated release. Use `canary` first, then atomically move `politburo` to that immutable digest. This is feasible without a paid control plane.

**Recommendation 2 — do not promise that this changes Claude Code itself.** An Anthropic-hosted environment's setup script is cached and runs before Claude Code. A repository hook is too late to change Claude Code's own startup environment. Native Claude model/effort policy and OpenTelemetry must be set in the cloud-environment form or, for Team/Enterprise cloud sessions, in Anthropic server-managed settings. The public documentation describes UI administration, not an API for an agent to edit those records. Therefore retain a small jockey-owned control plane for those fields. [Cloud environments](https://code.claude.com/docs/en/cloud-environments.md), [Monitoring](https://code.claude.com/docs/en/monitoring-usage.md#telemetry-from-cloud-sessions-and-claude-tag), [server-managed settings](https://code.claude.com/docs/en/server-managed-settings.md).

**Recommendation 3 — make `politburo` and `canary` organization-shared environments, rather than relying on personal environments.** An Owner creates, edits, archives, and sets the organization default for shared environments. Members see them read-only. That gives a durable human boundary and one configuration per fleet. [Cloud environments](https://code.claude.com/docs/en/cloud-environments.md#organization-shared-environments).

**Recommendation 4 — use the office Mac only as a control/audit service, not as the signer exposed to agents.** Publish signed, content-addressed public artifacts (best for availability) or read-only artifacts through Cloudflare Tunnel/Access. Company-email Access is for people; a narrowly scoped machine identity is for the verifier. Cloudflare documents that Tunnel uses outbound-only connections and that an Access application should be in place before a published app is exposed. [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [self-hosted Access apps](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/).

## 1. What Claude Code cloud environments actually provide

### Scope, ownership, and selection

A cloud environment is saved configuration for cloud sessions. It holds network access policy, ordinary environment variables, network secrets, and a setup script. It is used from claude.ai/code, mobile, Desktop, `claude --cloud`, scheduled cloud tasks, and Claude Tag. Sessions otherwise run on an Anthropic-managed Ubuntu VM with a fresh repository clone. [Cloud environments](https://code.claude.com/docs/en/cloud-environments.md), [cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web.md).

There can be several environments. A user selects one in the web/mobile/Desktop selector; project threads use the project's environment. In the CLI, `/remote-env` stores `remote.defaultEnvironmentId`; CLI falls back as documented if it is absent. `/remote-env` selects an existing environment only. It does not add or edit one. A self-hosted `ccpool_...` environment may be selected with `--environment`; Anthropic-hosted `env_...` IDs may not. [Default environment and selection](https://code.claude.com/docs/en/cloud-environments.md#the-default-environment), [CLI selection](https://code.claude.com/docs/en/cloud-environments.md#select-an-environment-from-the-cli).

Personal environments are created and edited by their owner in the selector. On Team and Enterprise, an **Owner**, not an Admin, manages organization-shared environments on the Cloud environments admin page. Shared environments are read-only in the member selector. Owners separately set the organization default. [Organization-shared environments](https://code.claude.com/docs/en/cloud-environments.md#organization-shared-environments).

The official documentation describes environment create/edit/archive in the web selector and admin page. It documents no public environment-management API, no `claude` flag, no repository config file, and no `/remote-env` operation that creates or edits an Anthropic-hosted environment. Treat an undocumented web endpoint as unsupported. [Configure your environment](https://code.claude.com/docs/en/cloud-environments.md#configure-your-environment), [CLI selection](https://code.claude.com/docs/en/cloud-environments.md#select-an-environment-from-the-cli).

### Name change and the requested environments

**Rename behavior is unverified.** Current official documentation says each shared environment has a name and that it can be edited, but does not explicitly state that the name field is mutable or what a rename breaks. It does state that sharing a personal environment preserves its ID and does not affect sessions or scheduled tasks already using it. That is useful evidence that references are ID-based in that operation, but it is not documentation of rename safety. [Organization-shared environments](https://code.claude.com/docs/en/cloud-environments.md#organization-shared-environments).

Before renaming `remidarknet`, record its environment ID and all scheduled-task/project/default references. In a low-risk window, rename it to `politburo`, then start one new session and one scheduled task. If the UI does not permit rename, create a shared `politburo`, make it default, repoint each explicit task/project, and only then archive `remidarknet`. Archiving does not stop existing sessions, but removes the environment from new-session selection and prevents new scheduled sessions from starting there. [Archive an environment](https://code.claude.com/docs/en/cloud-environments.md#archive-an-environment).

Create a second shared `canary` environment with the same least-privilege network policy and bootstrap. It must be deliberately selected by canary sessions/projects; merely creating it does not route a percentage of sessions to it. The docs describe selection, not built-in percentage rollout. [Default environment](https://code.claude.com/docs/en/cloud-environments.md#the-default-environment).

### Network and repositories

Network access has three levels: None, Limited, and Full. Limited permits the default allowlist while “Allow package managers” is enabled, plus individually listed domains; one environment's allowlist is independent of every other environment's and cannot be set by server-managed settings. A wildcard subdomain can be allowed. GitHub, MCP connectors, network-secret hosts, and Anthropic's own API have documented special paths. [Network access](https://code.claude.com/docs/en/cloud-environments.md#network-access), [allow specific domains](https://code.claude.com/docs/en/cloud-environments.md#allow-specific-domains).

The environment does **not** hold a repository list in the normal Anthropic-hosted model. A session clones the repository selected at dispatch; GitHub access is through a proxy with session/repository scope and real GitHub credentials remain outside the VM. [Cloud sessions and GitHub authentication](https://code.claude.com/docs/en/claude-code-on-the-web.md#github-authentication-options), [GitHub proxy](https://code.claude.com/docs/en/cloud-environments.md#github-proxy).

### Setup script, cache, and committed setup

The setup script is Bash on Ubuntu 24.04, runs as root **before Claude Code launches**, and can be entered or loaded into the form up to 64 KB. It needs exit status zero. It must finish in roughly five minutes to produce a cache. Its environment variables are not set yet. [Setup scripts](https://code.claude.com/docs/en/cloud-environments.md#setup-scripts), [script requirements](https://code.claude.com/docs/en/cloud-environments.md#script-requirements).

A successful setup creates a filesystem snapshot. Later sessions skip the script and start from it. The script runs again when its text or allowed hosts change, or the cache expires after roughly seven days. It does not rerun merely because a remote file changed, nor when an idle VM is restored. This is why “fetch latest setup in the form script” is not a reliable fleet update mechanism. [Environment caching](https://code.claude.com/docs/en/cloud-environments.md#environment-caching).

Committed repository content is present in the fresh clone. In a one-repository, non-project cloud session, `.claude/settings.json` hooks and permission rules, `.mcp.json`, `CLAUDE.md`, rules, skills, agents, and commands are available. A repository SessionStart hook runs after Claude Code launches, every start/resume, but does not run for multi-repository sessions or project cloud threads. User-local Claude configuration on the developer machine does not reach the cloud. [What carries over](https://code.claude.com/docs/en/cloud-environments.md#what-carries-over-from-your-setup), [setup versus SessionStart](https://code.claude.com/docs/en/cloud-environments.md#setup-scripts-vs-sessionstart-hooks).

Thus a committed hook can carry repeatable **project** setup, but it cannot replace a universal environment bootstrap. It is also not a safe universal control plane because project threads and multi-repo sessions omit it.

## 2. Environment variables, native Claude configuration, limits, and telemetry

### Can setup or hooks configure the Claude Code process?

A setup script cannot: its shell ends before Claude Code starts. Exporting there does not reach Claude Code; Anthropic explicitly calls this out for `OTEL_RESOURCE_ATTRIBUTES`. A SessionStart hook inherits the parent process environment and can configure its own child process, but it runs after Claude Code is already launched. It cannot retroactively configure Claude Code's startup telemetry/model state. [Cloud telemetry attribution](https://code.claude.com/docs/en/monitoring-usage.md#telemetry-from-cloud-sessions-and-claude-tag), [hooks and subprocess environment](https://code.claude.com/docs/en/hooks.md).

The cloud-environment Variables form is the supported way to supply startup variables. Values become ordinary variables available to commands except `OTEL_*`; Claude Code consumes `OTEL_*` for its own export and does not pass them to commands. Everyone who can use the environment can read ordinary variables. Existing sessions pick variable edits up only after a restore/rebuild; a new session is the prompt way to apply them. [Set environment variables](https://code.claude.com/docs/en/cloud-environments.md#set-environment-variables).

A repository `.claude/settings.json` is useful for a per-repository default model/effort in applicable sessions, but Claude Code ignores OpenTelemetry exporter variables in repository and local settings. A cloned repository therefore cannot turn telemetry on or choose its endpoint. [Monitoring administrator configuration](https://code.claude.com/docs/en/monitoring-usage.md#administrator-configuration).

For Team/Enterprise cloud sessions, server-managed settings can deliver settings, hooks, and an `env` block. They apply to web/mobile/cloud sessions (with documented Claude Tag exceptions). They can set/lock a model allowlist and telemetry destination; model and OpenTelemetry exporter updates apply at next Claude Code launch. The documentation describes changing server-managed settings in the admin console, not a programmatic agent API. [Server-managed settings](https://code.claude.com/docs/en/server-managed-settings.md), [model restrictions in cloud sessions](https://code.claude.com/docs/en/model-config.md#restrict-model-selection).

**Practical boundary:** Remote swarm configuration may change pi/router defaults, pi limits, prompts, and non-secret telemetry labels. It may not claim to change Claude Code's own model, thinking/effort, Claude usage limit, native telemetry endpoint, cloud environment variables, domains, or secrets. Those fields remain jockey/Owner actions in the environment/admin UI unless Anthropic releases a supported management API.

### OpenTelemetry to the office

For Anthropic-hosted cloud sessions, configure `CLAUDE_CODE_ENABLE_TELEMETRY` and `OTEL_*` either in server-managed settings (all eligible cloud sessions except Claude Tag) or in that cloud environment's Variables form (including Claude Tag). The exporter travels through the session network, so add the collector's tunnel hostname to the environment's Limited allowlist. Server-managed settings cannot add that domain. [Telemetry from cloud sessions](https://code.claude.com/docs/en/monitoring-usage.md#telemetry-from-cloud-sessions-and-claude-tag).

Do **not** put a collector bearer token in environment variables. Users can read them. A network secret also cannot authenticate Claude Code telemetry: Anthropic documents telemetry as a request to which the agent proxy does not attach network secrets. If a collector needs credentials, use server-managed settings, where Claude Code pins the managed telemetry destination and removes conflicting user-set endpoint/credential variables. A simpler no-secret option is mTLS or a tunnel endpoint that authenticates the transport without a bearer token; its feasibility is implementation-specific and should be tested. [Cloud telemetry constraints](https://code.claude.com/docs/en/monitoring-usage.md#telemetry-from-cloud-sessions-and-claude-tag), [locking an OTLP destination](https://code.claude.com/docs/en/monitoring-usage.md#how-managed-settings-lock-the-otlp-destination).

Start with metrics and logs but leave `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT`, and raw API-body logging off. Those options can export prompts, answers, command arguments, file/tool content, or whole conversation bodies. Cloud telemetry includes `ccr.session.id`; filter on it to identify cloud sessions. [Telemetry variables and privacy](https://code.claude.com/docs/en/monitoring-usage.md#configuration-details), [cloud attribution](https://code.claude.com/docs/en/monitoring-usage.md#attribute-telemetry-to-cloud-sessions).

### Limits

Cloud sessions share account rate limits with the rest of Claude/Claude Code usage. There is no documented separate usage-limit bucket per environment. Each Anthropic VM has approximate 4 vCPU, 16 GB RAM, and 30 GB disk limits. Command and hook timeouts are separate operational limits. [Cloud-session limitations](https://code.claude.com/docs/en/claude-code-on-the-web.md#limitations), [resource and time limits](https://code.claude.com/docs/en/cloud-environments.md#resource-limits).

## 3. Patterns worth borrowing

1. **GitOps desired state.** OpenGitOps defines declarative, versioned/immutable desired state which agents pull and continuously reconcile. Use this for a small, reviewable manifest and a monotonic release generation, not for mutable shell pasted into a UI. [OpenGitOps principles](https://opengitops.dev/).

2. **Verify identity, signature, and digest; never trust a branch tip.** Sigstore's model binds signing identity to an artifact and records signing in a transparency log; Cosign verification can require the expected certificate identity/issuer. TUF similarly uses trusted signing keys, hashes, signatures, expiry, and role metadata to protect update retrieval. For this small fleet, a pinned verification key plus a signed manifest and SHA-256 bundle is the minimum. Adopt TUF-style root/key rotation and expiry only if the team can operate it correctly. [Sigstore signing overview](https://docs.sigstore.dev/cosign/signing/overview/), [Cosign verification](https://docs.sigstore.dev/cosign/verifying/verify/), [TUF overview](https://theupdateframework.io/docs/overview/).

3. **Keep setup in version control and validate it like code.** GitHub Copilot coding agent uses a repository `.github/workflows/copilot-setup-steps.yml`; it runs before work, is tested as a normal workflow when changed, and begins work with partial state if a setup step fails. That is evidence for versioned, testable setup and explicit failure handling, even though its GitHub Actions mechanism is not Claude's. [GitHub Copilot setup steps](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/customize-the-agent-environment).

4. **Canary then atomic promotion.** Publish an immutable release once. Point `canary` at it, require health evidence, then atomically change only the signed channel pointer for `politburo`. Rollback is a new, signed pointer to the prior known-good digest, not a destructive rebuild or `git revert` race. This is a design recommendation based on the preceding immutable/reconciled patterns.

5. **Separate people and machines.** Protect the office dashboard with company-email Access policy. Give cloud verifiers a distinct, read-only machine identity. Cloudflare documents service tokens and token rotation/revocation facilities; an application must still enforce operation-level authorization. [Cloudflare service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), [Access apps](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/).

## 4. Concrete design

### The one-time jockey action

1. Create shared `politburo` and `canary`. Add only the office configuration hostname to each Limited allowlist. Keep Full network access off. Configure telemetry separately as above.
2. Paste the same ≤64 KB bootstrap into both setup-script forms. It must be boring and rarely changed: install/verify the fixed launcher, embed the public verification key and office URL, create `/opt/swarm/last-good` and `/opt/swarm/previous-good`, and replace the pi/router launcher with a wrapper that invokes the verifier before pi/router starts. The bootstrap must not fetch “latest” code by branch name.
3. If the office endpoint is private, the jockey adds a **read-only network secret** for that hostname once. It is attached after a request leaves the VM and is not visible to sessions. Do not use it during the setup script: Anthropic says setup-script requests never receive network secrets. The later launcher request can use it. Confirm the chosen Access machine credential can be represented by the permitted headers. [Network secrets and exclusions](https://code.claude.com/docs/en/cloud-environments.md#add-network-secrets).
4. Create a public Git repository or a restricted office repository for release source and audit records. Put no secret in it. The safer availability choice is a public, signed release mirror: confidentiality is unnecessary for launcher configuration, and integrity is supplied by signature/digest. Use the tunnel only for the human dashboard, promotion API, health intake, and optionally private artifacts.

### Release objects and trust

A release is immutable:

- `bundle-<sha256>.tar.zst`: pi version/launcher files/router configuration/schema.
- `manifest-<generation>.json`: schema version, channel (`canary`/`production`), immutable bundle digest and URL, minimum verifier version, pi/router model defaults, allowed model/effort envelopes, limits, non-secret telemetry labels, creation time, expiry, and rollback metadata.
- `manifest-<generation>.sig`: signature over canonical manifest bytes. The verifier contains the public key and also checks the bundle SHA-256 after download.

Use Minisign, or Cosign with an offline-verifiable bundle and pinned expected identity/issuer. Do not accept an unsigned Git commit, a moving tag, a URL supplied by the manifest without a digest, `curl | sh`, or configuration that asks the bootstrap to change its verification key. Sigstore's identity-bound signing is appropriate when the team can reliably pin the signer identity; a locally controlled Minisign public key is simpler for a single Mac. [Sigstore signing](https://docs.sigstore.dev/cosign/signing/overview/), [verification](https://docs.sigstore.dev/cosign/verifying/verify/).

The signing private key stays in the office signing service/OS key store under the jockey's administration. It is never sent to a cloud VM, repository, manifest, pi config, log, or agent prompt. Key rotation is a jockey-only, dual-sign migration: ship a verifier that trusts old+new public keys, sign a release with both, then remove old trust in a later bootstrap upgrade.

### Who may change what

| Actor | May do | Must not do |
|---|---|---|
| Core | Submit a schema-valid candidate; choose among previously approved/signed bundle digests; change bounded pi/router defaults; promote canary after policy gates; request rollback. | Change trust keys, bundle signing policy, bootstrap URL, network allowlist, Cloudflare policy, environment variables/secrets, native Claude/OTel configuration, collectors, or audit retention. |
| Office release service | Validate schema/ranges; check an allowlist of signed bundle digests; append an audit event; sign/publish a channel pointer when policy allows. | Execute arbitrary config fields or arbitrary shell supplied by core. |
| Jockey/Anthropic Owner | Create/rename/archive environments; set default; paste bootstrap; manage domains/network secrets; set server-managed settings and telemetry; approve trust-root or endpoint changes; emergency stop. | Delegate unrestricted environment-admin credentials to core. |

The service must authenticate core separately from a human. A Cloudflare service token only gates entry; the service must map it to a `core` principal, authorize endpoint/method/channel, rate-limit it, and log request/decision IDs. Company-email Access is for the dashboard and manual approval. [Cloudflare Access apps](https://developers.cloudflare.com/cloudflare-one/applications/configure-apps/self-hosted-apps/), [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

### Canary, promotion, health, and rollback

1. Core submits candidate `N` referencing an already signed digest. The service writes an append-only audit record: request ID, actor, old/new digest, allowed field diff, policy result, timestamp, and signer/key ID. Git commits plus a periodically signed audit-head hash are adequate with no paid service.
2. Service publishes `canary -> N`. Canary sessions fetch, verify, stage to a temporary directory, run a deterministic smoke test (`pi --version`, launcher parse, router health/config schema), then atomically switch `last-good`. They report only release generation/digest, verifier version, result/error class, timestamp, and cloud session ID or one-way pseudonym.
3. Promote only after a fixed sample/time window and a policy such as: at least five healthy canary starts; no signature/digest/schema failure; launch failure no more than 2% and not statistically worse than the prior generation; no critical collector/audit outage. Thresholds are team policy, not Anthropic guarantees.
4. On promotion, service publishes `production -> N`; `politburo` takes it on the next pi/router invocation. Existing Claude Code processes are not restarted or reconfigured.
5. Auto-rollback publishes a new, higher-generation signed pointer to the prior digest when the production failure gate trips. Do not rollback merely because the office is temporarily unreachable. Page the jockey if a release repeatedly flaps or if signature failures occur.

One-step manual rollback is `publish production -> previous-good-digest` with a reason and a new generation. It should be a button available only to the jockey and an authorized emergency policy, not an agent shell command.

### Offline and failure behavior

The wrapper verifies before activating. It downloads to a temporary directory, checks signature, expiry, manifest schema, pinning policy, and digest, smoke-tests, then atomically renames it into `last-good`. It retains the immediate predecessor. On DNS/tunnel/Access/office failure, timeout, malformed manifest, expired manifest, bad signature, digest mismatch, or smoke-test failure, it logs a non-secret error class and launches the local last-good version. If no valid local version exists, fail closed with a concise diagnostic rather than run an unverified bundle.

This works around the environment cache: the one-time setup snapshot holds the small verifier, while the verifier refreshes its own data at **launcher time**. It does not work for native Claude Code settings because those are read before/at Claude startup.

### Reporting and audit

Use two independent signals:

- The launcher posts signed/Access-authenticated health receipts to the office service. It reports config generation and digest, not secrets or prompt/code content.
- Claude Code OpenTelemetry sends metrics/logs to an OTLP receiver under the separately controlled native telemetry configuration. Use `ccr.session.id` to correlate cloud runs. Keep sensitive-content switches off. [Cloud telemetry](https://code.claude.com/docs/en/monitoring-usage.md#telemetry-from-cloud-sessions-and-claude-tag), [privacy controls](https://code.claude.com/docs/en/monitoring-usage.md#security-and-privacy).

Display release state as `desired generation/digest`, `observed generation/digest`, last verification result, and age. Drift is when observed differs from desired after an agreed next-launch window; it is not a reason to destroy a live session.

## 5. Risks and non-negotiable guards

- **Remote configuration is code execution if it can name arbitrary scripts.** Restrict it to a typed schema and an allowlist of pre-signed bundle digests. Core proposes; it does not upload executable shell.
- **The config endpoint is an exfiltration/command channel.** Limited allowlist only, separate endpoint for config and telemetry, short timeouts, response-size caps, certificate validation, no redirects, and no command interpolation.
- **A bearer/token in environment variables is readable by every user of that environment.** Use a network secret only for ordinary agent requests, never assume it protects setup or telemetry. [Environment-variable visibility and network secrets](https://code.claude.com/docs/en/cloud-environments.md#set-environment-variables).
- **Telemetry can contain source, prompts, commands, and secrets when detailed switches are enabled.** Start with metadata-only signals and collector-side redaction/retention controls. [Telemetry privacy](https://code.claude.com/docs/en/monitoring-usage.md#security-and-privacy).
- **A compromised coordinator can promote bad but valid releases.** Bound core's fields, require canary evidence, maintain a rate-limited promotion budget, require jockey approval for high-risk changes, and make rollback independent of core.
- **Office outage must not halt work.** Cache last-good locally. Treat stale-report alerts as operations alerts, not automatic rollback.
- **Anthropic control-plane settings remain a human boundary.** Do not give core the owner's browser session, admin credentials, or an unsupported API automation. The design is deliberately honest about this limit.

## Source note

Primary sources were current official Anthropic Claude Code documentation first, then official Cloudflare, Sigstore, TUF, OpenGitOps, and GitHub documentation. Assertions explicitly marked **unverified** were not stated in the current official documentation and should be tested in a non-production environment.
