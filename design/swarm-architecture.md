status: proposed
bonklek decides on this PR

# Swarm architecture

The swarm has four tiers: core, spawner, mob and sprite, in that order.
Each spawner has one secretary session by convention. The secretary is
neither a tier nor a registry role.

The board records tasks, claims, mail, registry entries and command intents.
It does not launch workers, integrate code, push, merge or grant approvals.

**Contents**

1. [Tiers and authority](#1-tiers-and-authority)
2. [Naming](#2-naming)
3. [Messaging](#3-messaging)
4. [Lifecycles](#4-lifecycles)
5. [The model router](#5-the-model-router)
6. [Human gates](#6-human-gates)
7. [Open questions](#7-open-questions)

## 1. Tiers and authority

### Tier hierarchy

```text
Human owner (sets scope and grants approvals)
  Core (starts and steers spawners)
    Spawner (one per repo)
      Secretary (one local session, paired with the spawner)
      Mob (cloud task session dispatched by the spawner)
        Sprite (pi agent started by the mob)
```

The secretary line shows a pairing, not a launch step.

| Tier | Work | Target share of work |
| --- | --- | --- |
| Core | Coordinates spawners, decides cross-repo questions and escalates to the user. | 0.5% |
| Spawner | Turns requests into tasks. Reads mob reports and forwards review links to core and the user. | 4.5% |
| Mob | Plans the task, starts sprites, checks their work, runs verification and reports. Keeps its own processing to a minimum. Does not write code. | 15% |
| Sprite | Implements or does first-pass review for one task in the mob's VM. Starts no workers. | 75% |

The targets add to 95%, and no separate share is specified for secretaries.
How to account for the remaining 5% and secretary work:
[To be confirmed](#7-open-questions).

### Commit, push and merge authority

Here, merge means merging a pull request (PR), not bringing the base branch
into a work branch. A mob class limits remote actions. It does not authorize
local commits. Assignments, repository rules and harness limits still apply.

| Actor | Commit | Push | Merge a PR | Other limits |
| --- | --- | --- | --- | --- |
| Core | To be confirmed | To be confirmed | To be confirmed | Does not write code. |
| Spawner | On work branches: To be confirmed | On work branches: To be confirmed | Only when authorized and the [merge guardrail](#merge-guardrail) and repository gates pass | Creates tasks and sends mail on the board. Does not write code or deep-review. |
| Secretary | Applies authorized mob patches. Whether it can create a commit: To be confirmed | Plain push on request after the repo's quick check | No | Does not write code or grant approvals. |
| Passive mob | To be confirmed | Never | No | Reads, runs checks and reports. |
| Neutral mob | Commits sprite changes in its working tree | Its own work branch, when authorized | No | May open PRs where the harness allows. May not close PRs or delete branches. |
| Hostile mob | To be confirmed | To be confirmed | No | May close PRs or delete branches only with a clean gate and repository authorization, where the harness allows. |
| Boss mob | To be confirmed | To be confirmed | No | Swarm-wide operations only, each with the user's explicit OK. |
| Sprite | No | No | No | Writes code in the mob's working tree or does first-pass review. The mob checks the work. |

Use the approved pseudonymous commit identity. Check for private material
before every commit and push. The runtime's [`preflight`](../packages/runtime/README.md#ops)
uses `scanDiff` to refuse added lines with tokens, keys or emails. Also
check changed text by hand for local paths, session IDs, account details
and private repo names.
Remove any such material. Never print or commit credentials.

Never use `--no-verify` or `--admin`. Do not rebase or force-push. Merge the
base branch into the work branch instead. Do not add Claude-authored trailers.

### Merge guardrail

An authorized spawner may merge only when CI is green on the exact PR head
and the latest review covers that same head with no findings above minor.
A mob-checked sprite review must cover that head and does not replace any
required independent review. All repository gates, including human gates,
still apply.

If any condition is unmet, leave the PR open, list the findings in the PR
body and move on. Never merge to end a review loop. A PR may stay in review
indefinitely.

The [runtime's `reviewGate`](../packages/runtime/README.md) marks a PR ready
only with passing checks on the exact head (the GitHub adapter reads the
check names the caller configures) and a clean verdict signed with a shared
secret for that same head. GitHub cannot atomically compare
the head and mark a PR ready. `withHeadLock` must fence all head updates
through the transition. Readiness does not authorize a merge. The runtime
never merges. An authorized spawner merges outside the board.

### Tiers and registry roles

Tiers describe supervision. The opt-in [agent registry](../packages/board/docs/01-board/13-agent-registry.md)
records it as a `parent` on the entry. Set it with `--parent` at registration.
It is optional, must name an entry in the same exact channel and cannot
form a cycle. Enable the registry with `local({ agentOps: true })` or
`vb serve --agent-ops`.

An entry has one of eight roles. Roles describe duties and grant no access
or task authority. There is no defined mapping from tiers to roles. The
board records command intents and their receipts. It does not execute them.

## 2. Naming

[Swarm naming](swarm-naming.md) defines session titles, mob IDs and sprite
names. A name is a display label, not an identity or grant. The board uses
the [verified principal and profile](../packages/board/docs/01-board/03-identity.md#principals-profiles-and-actors).
Spawners and secretaries use separate name pools and keep their names for
the life of the session. Do not reuse a live session's name.

| Where | Format |
| --- | --- |
| Spawner sidebar title | `<TAG> <NAME>` |
| Secretary title | `<TAG> <Name>` |
| Mob session title | `<tag> <serial>-<SPECIES><n>`. Add `<n>` only when every species for the job has a live mob, as in `120-COW2`. |
| Sprite name | `<mob-id>.<ITEM><n>`. Add `<n>` only if the same mob runs more than one sprite with that item. |

The tag is the repo tag. A sprite name uses the mob ID without the tag. The
mob's species and the sprite's item describe their jobs. A mob's class sets
its remote ceiling. That is a limit, not a grant. The board does not enforce
class limits.

| Class | Remote ceiling |
| --- | --- |
| Passive | Reads, runs checks and reports. Never pushes. |
| Neutral | Pushes its own branch and may open PRs. Does not merge or close PRs or delete branches. |
| Hostile | May close PRs or delete branches with a clean gate and repository authorization, where the harness allows. Mobs never merge PRs. |
| Boss | Swarm-wide operations only, each with the user's explicit OK. |

## 3. Messaging

The secretary relays mail through the [operational inbox](../SPEC.md#operational-inbox).
Address a verified principal ID or a configured inbox role, not a profile.
Send through `team.operationalInbox` or HTTP. Mail stays out of threads,
public feeds, watchers and sync. See [swarm secretaries](swarm-secretaries.md)
for routing by header and urgency.

Escalate one step at a time: secretary to spawner, spawner to core as needed,
then core to the user for a human decision. The runtime's
[`runController`](../packages/runtime/README.md#controller-loop) records `seen`
before waking the handler and `acted` after the handler reports the work done.
At the controller's deadline, if the mail is still visible and unacted, it
uses the caller-supplied `parentOf` to find the immediate registry parent. It sends that parent
one reference without the message text.

## 4. Lifecycles

### Dispatch

The spawner turns a request into a [board task](../SPEC.md#tasks) with
[`vb tasks create`](../packages/board/docs/01-board/11-tasks.md). A task is a
thread. Its state is the reserved `board.task` label: `waiting`, `ready`,
`claimed`, `blocked`, `completed`, `failed` or `canceled`. The board owns
labels under `board.`. `vb tasks reopen <id>` makes a failed task ready again.

- Set `--priority` to `lowest`, `low`, `normal`, `high` or `urgent`. The
  default is `normal`. With `vb tasks priority <id> <level>`, the task owner
  or someone with `manage` can raise or lower it. A live claim can only
  lower it.
- Set `--needs <id>` for each prerequisite. The dependent waits for all of
  them to complete. The board can create a plan of tasks in one atomic write.
- Use `--for <profile>` to keep a task for one of its owner's profiles.

Use the next swarm-wide mob serial without reusing one and choose the species
as described in [swarm naming](swarm-naming.md). The spawner starts the mob on
Sonnet at High effort, never Opus, with only the repository selected. This
is a session convention, not a board operation.

Check [usage and capacity](#usage-guard-and-capacity) before claiming. The
mob uses `vb tasks claim <id>` with `--binding '<JSON>'` for a bound claim.
Claim-next (`vb tasks claim --ready <channel>`) takes the highest priority
eligible ready task. At equal priority it prefers tasks assigned to the
caller, then takes the oldest.

The binding contains `controller` and `owner` (each `{principal, actor}`),
`provider`, `model`, `session`, `branch`, `worktree` and `baseCommit`. Use the
full lowercase Git SHA for `baseCommit`. The board verifies that `owner`
matches the claimant. It records the controller without granting new access.
Keep secrets out of the binding. Bound claims need `task_authority: true` in
discovery. Vercel's board and `http()` without it return 501 `no_task_authority`.

A claim is a lease. Each claimed write carries the claim's `epoch` (fence
generation) and `token`. A write with a lost claim fails with `claim_lost`.
The separate [`@remilia/politburo-runtime`](../packages/runtime/README.md)
package provides `runTask` to claim a task, renew the lease, run a harness
and release the claim. It never completes or fails the task. If it loses
the lease or sees a pause, it requests cancellation and returns `lease_lost`
or `paused`, respectively.

### Sprite runs

Give each sprite one self-contained task. Independent tasks can run in parallel.
Sprites write code and do first-pass review in the mob's working tree. They
never commit or push. The mob checks their work and runs the required checks.
It commits and pushes only where authorized.

Write each task to a file with a quoted heredoc. Never pass the task as a
quoted shell argument. Use a distinct sprite name for each attempt.

The runtime's `pi()` adapter runs `pi-task <task-file> [max-seconds]` with the
selected model in `PI_MODEL`. On an eligible failure, it tries the next
configured model within the same wall deadline. The adapter takes an
`idleMs` option for its own idle limit. See
[The model router](#5-the-model-router).

**Two-failure rule.** Stop a stalled sprite. After a failure or stall, collect
the attempt and retry once with a smaller task under a new name. If the retry
fails or stalls, report `blocked` with the relevant redacted log tail. The mob
never falls back to writing the code.

### Push paths

The mob commits what sprites write, within its authority. Mobs never merge PRs.

| Path | What happens |
| --- | --- |
| Cloud push | An authorized mob pushes its own work branch. It may open a PR within its class and harness limits. |
| Local push | On request, the secretary applies an authorized mob patch in its own worktree, runs the repo's quick check and does a plain push. |

Only one secretary runs a local quick check at a time.

### PR modes

The definitions of `PR-max` and `merge-shepherding` are
[To be confirmed](#7-open-questions). Both use the same
[merge guardrail](#merge-guardrail) and repository gates.

### Mob retirement

The spawner or its secretary handling `sec.retire` archives a mob only when
all mob and sprite work is complete and on `origin`, no sprite is running and
the worktrees pass the [retirement checks](mob-retirement.md). Do not archive
if evidence is missing or a check fails. Do not leave a mob running once it
passes the checks. `vb agents retire` disables a registry entry. It does
not archive the session.

### Heartbeats and stall watching

Each spawner has its own staggered 30-minute beat, for example `:28` and
`:58`. Each beat checks mobs, dispatches subject to the usage guard, retires
finished mobs that pass the checks and re-arms the next beat.

A [scheduled message](../packages/board/docs/01-board/07-schedules.md) can
carry the beat: `vb schedule <thread> "<text>" --every 30m`. Set the first
send with `--at` to stagger the beats. The message posts as its creator and
wakes nothing by itself. A watcher or the spawner acts on it. On `local()`,
timers live in the process. A restart loses pending sends. Sends skipped
during a network pause do not catch up.

A registry heartbeat records a time only. It is not the spawner's beat or
proof of work. [`vb agents health <task>`](../packages/board/docs/01-board/13-agent-registry.md#check-task-run-health)
prints `working until <deadline>` only if the newest reported probe for the
live claim says `running` and is still fresh. The report freshness window
defaults to 30 seconds. Otherwise it prints `stale`. A lease, heartbeat or
ordinary status report is not enough. After a pause, health stays `stale`
until a new claim and probe.

Core has no tick. By convention, a token-free stall watcher flags a stall
for the owning tier after 30 minutes with no change.
[Watchers](../packages/board/docs/01-board/06-watchers.md) and `vb tail` can
filter board events without model tokens. Which changes count and how the
flag reaches the owning tier: [To be confirmed](#7-open-questions).

Mobs and sprites have no heartbeat schedule or cron. A mob keeps its claim
live with `vb tasks renew <id>`.

### Usage guard and capacity

The runtime offers two optional [dispatch policies](../packages/runtime/README.md#dispatch-policies).
Run both before a claim. At 95% usage or more in the five-hour window,
`usageGuard` stops dispatch until `resetAt`. Nothing wakes at reset, and
there is no weekly logic. `capacity` reserves slots per kind and machine-wide
slots for heavy runs.

### Reports

Open every mob report with **Links for review**. Put the PR URL there if
there is a PR. Link to every other output the user should review, such as a
doc, artifact or preview. A report without review links is not done. Follow
with these items in order:

1. What changed.
2. The sprite log.
3. The commands run.
4. What was not done or not verified.

Post the report as a reply in the task thread. When handing over code, use
`vb tasks handoff <id> <commit> <packet-path> <sha256> [--supersedes <id>]`
while the claim is live. The latest record appears in `TaskView.handoff`.
The board records metadata only and leaves the task and claim open. It does
not read the checkout or packet. The recipient verifies the packet bytes
at the named commit. When completing the task, record the report as its result.

## 5. The model router

**Pi extension.** The `pi-task` launcher's `fallback/codex-cursor` extension, not the runtime package, routes sprite requests through these tiers in order:

| Tier | Errors that trigger cooldown |
| --- | --- |
| First | Quota, rate or login error |
| Second | Any error |
| Third | Quota, rate or login error |

1. Try the tiers in order, skipping any on cooldown. Use the first successful
   result.
2. On an error listed for that tier, cool it down for 30 minutes by default
   and go to the next eligible tier. Other errors on the first or third tier
   are [To be confirmed](#7-open-questions).
3. If all tiers are on cooldown, use the tier that recovers first.

Never read, write or print the login variables or auth files.

| Variable | Purpose |
| --- | --- |
| `PI_CODEX_AUTH` | First-tier login material |
| `PI_CURSOR` | Second-tier login material |
| `PI_CODEX_PERSONAL_AUTH` | Third-tier login material |
| `PI_FALLBACK_PRIMARY_MODEL` | Override for the first-tier model |
| `PI_FALLBACK_CURSOR_MODEL` | Override for the second-tier model |
| `PI_FALLBACK_COOLDOWN_MINUTES` | Tier cooldown in minutes |
| `PI_MODEL` | Model selection for `pi-task` |
| `PI_THINKING` | Thinking effort |
| `PI_IDLE_SECONDS` | Idle limit in seconds |
| `PI_TASK_LOG` | Run log path |
| `PI_SESSION_DIR` | Sprite session directory |

**Runtime router.** The separate [`createRouter`](../packages/runtime/README.md#routed-attempts)
handles attempts outside the board:

- It ranks provider and model pairs by a board-kept scoreboard in `quality`,
  `cost` or `latency` mode.
- It freezes the task contract across retries: `repo`, `baseSha`,
  `allowedPaths`, `requiredCheckIds` and `limits`. It reserves each attempt's
  cost cap.
- It retries eligible failures by class, with in-memory cooldowns for quota,
  auth and timeout. An auth incident gets one probe after cooldown if
  configured.
- It returns a verified candidate or a stopped reason. It never changes task
  state or marks work done.

## 6. Human gates

Keep approved scope, implementation completion, agent review, visual QA,
user acceptance and publication permission distinct. Do not infer one from
another. When a person must decide, put the full question, labeled choices
and enough context to decide in the task thread.

- **Plain task hold.** Use `vb tasks block <id> "<reason>" --kind awaiting_approval`
  or `--kind needs_input`. Blocking a claimed task ends its lease. The person
  can reply in the thread and the owner lifts the hold with `vb tasks unblock`.
- **[Structured attention](../SPEC.md#structured-task-attention).** Use
  `vb tasks ask` with options and a full commit ID. Read the request with
  `vb tasks attention`. Only configured responder principals can use
  `vb tasks answer`. They must be verified people acting as themselves, with
  `read` and `post`. The answer applies once. The board refuses it if the
  snapshot changes or the request expires. The requester supplies the commit.
  The board does not check Git. An unconfigured board returns 501
  `no_task_attention`.
- **Operator hold.** `vb tasks park` and `vb tasks unpark` require a verified
  person acting as themselves, with `manage` in the task's channel. Parking
  ends the lease. `unblock` cannot lift it.
- **[Network pause](../packages/board/docs/01-board/12-network-pause.md).**
  Use `vb status` to check the setting. `vb pause` and `vb resume` require a
  verified person acting as themselves, with `manage` in every channel.
  A pause advances `pauseEpoch` and invalidates existing leases. New claims
  fail with 409 `board_paused`. Resume revives no leases. Reads and posts
  still work.

The board does not model these decisions as [task phases or evidence gates](../SPEC.md#not-in-this-version).
It does not require scope before a claim. `vb tasks complete` settles the
task and releases dependents whose prerequisites are all complete. It does
not require review or commit evidence.

## 7. Open questions

Do not treat an unknown as permission.

| Question | Where it appears | Status |
| --- | --- | --- |
| Who starts the core and secretary sessions? | [Tier hierarchy](#tier-hierarchy) | To be confirmed |
| How is the remaining 5% accounted for, and is there a separate secretary share? | [Tier hierarchy](#tier-hierarchy) | To be confirmed |
| May core commit, push or merge PRs? | [Commit, push and merge authority](#commit-push-and-merge-authority) | To be confirmed |
| May a secretary create a commit when applying an authorized patch? | [Commit, push and merge authority](#commit-push-and-merge-authority) | To be confirmed |
| May Passive, Hostile or Boss mobs commit locally? May Hostile mobs push work branches? What may Boss mobs push with the user's explicit OK? | [Commit, push and merge authority](#commit-push-and-merge-authority) | To be confirmed |
| What commit or push authority does the spawner have on work branches? | [Commit, push and merge authority](#commit-push-and-merge-authority) | To be confirmed |
| What satisfies the clean gate for Hostile close or delete actions? | [Commit, push and merge authority](#commit-push-and-merge-authority) | To be confirmed |
| How does a new spawner select a name? | [Naming](#2-naming) | To be confirmed |
| What do `PR-max` and `merge-shepherding` mean? | [PR modes](#pr-modes) | To be confirmed |
| Which changes reset the stall interval, and how does the flag reach the owning tier? | [Heartbeats and stall watching](#heartbeats-and-stall-watching) | To be confirmed |
| How do tiers map to registry roles? | [Tiers and registry roles](#tiers-and-registry-roles) | To be confirmed |
| How does the pi extension handle first- or third-tier errors other than quota, rate or login? | [The model router](#5-the-model-router) | To be confirmed |
| What routing state can a frontend observe? The board-kept scoreboard is readable. Cooldowns are in memory. | [The model router](#5-the-model-router) | To be confirmed |
