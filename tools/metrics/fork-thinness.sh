#!/usr/bin/env bash
set -euo pipefail

# Never relay Git diagnostics: even URL paths and headers can contain secrets.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then exec 3>&2 2>/dev/null; fi
fail() { printf 'error: %s\n' "$1" >&3; exit 1; }
trap 'fail "fork thinness measurement failed"' ERR
# Bound the entire run as well as each Git operation. Most Git timeouts
# stay in the outer process group. Fetch has its own hard group deadline.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  status=0
  timeout --kill-after=5 360 bash -c 'script=$1; shift; source "$script" "$@"' \
    fork-thinness "${BASH_SOURCE[0]}" "$@" || status=$?
  case $status in
    124|137) fail "overall timeout exceeded" ;;
    125|126|127) fail "could not start overall deadline" ;;
    *) exit "$status" ;;
  esac
fi
trap 'exit 124' TERM
trap 'fail "interrupted"' HUP INT

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
head_ref=HEAD
upstream_url=https://github.com/vercel/board.git
upstream_branch=main
while (($#)); do
  case "$1" in
    --repo|--head|--upstream-url|--upstream-branch)
      [[ $# -ge 2 && -n $2 && $2 != --* ]] || fail "missing option value"
      case "$1" in
        --repo) repo=$2 ;;
        --head) head_ref=$2 ;;
        --upstream-url) upstream_url=$2 ;;
        --upstream-branch) upstream_branch=$2 ;;
      esac
      shift 2 ;;
    *) fail "unknown argument" ;;
  esac
done

# Anchor relative paths before using git -C in the disposable clone.
[[ $repo = /* ]] || repo=$PWD/$repo
case "$upstream_url" in
  /*|*:* ) ;;
  *) upstream_url=$PWD/$upstream_url ;;
esac

umask 077
tmp=$(mktemp -d) || fail "could not create temporary directory"
cleanup() { rm -rf -- "$tmp"; }
trap cleanup EXIT
unset GIT_DIR GIT_COMMON_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_NAMESPACE \
  GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_QUARANTINE_PATH \
  GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_TEMPLATE_DIR \
  GIT_ASKPASS SSH_ASKPASS GIT_SSH GIT_SSH_COMMAND
for key in "${!GIT_TRACE@}"; do unset "$key"; done
export HOME="$tmp" XDG_CONFIG_HOME="$tmp" GIT_CONFIG_GLOBAL=/dev/null \
  GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 \
  GIT_NO_REPLACE_OBJECTS=1 GIT_SSH_COMMAND='ssh -o BatchMode=yes' LC_ALL=C

git_with_deadline() {
  local seconds=$1
  shift
  timeout --foreground --kill-after=5 "$seconds" git -c core.fsmonitor=false "$@"
}
g() { git_with_deadline 60 -C "$tmp/repo" "$@"; }

# Resolve in the source so refs local to this worktree work as well as HEAD.
# This is read-only; all writes and comparisons are in the clone.
head=$(git_with_deadline 60 -C "$repo" rev-parse --verify --end-of-options "$head_ref^{commit}") || fail "could not resolve source head"
shopt -u nocasematch
sha='^([0-9a-f]{40}|[0-9a-f]{64})$'
[[ $head =~ $sha ]] || fail "invalid head SHA"
git_with_deadline 120 clone --no-hardlinks --no-checkout --quiet -- "$repo" "$tmp/repo" >/dev/null || fail "could not clone source repository"
g check-ref-format "refs/heads/$upstream_branch" || fail "invalid upstream branch"
g remote add -- upstream "$upstream_url" || fail "could not add upstream remote"
upstream_ref=refs/remotes/upstream/metric
# Let GNU timeout kill its own group at the deadline. With TERM first, it
# could reap Git and exit while the HTTP helper is still alive.
# Wait asynchronously so the outer TERM trap can still remove the temp clone.
timeout --signal=KILL 120 git -c core.fsmonitor=false -C "$tmp/repo" fetch \
  --quiet --no-tags --no-recurse-submodules upstream \
  "refs/heads/$upstream_branch:$upstream_ref" >/dev/null 3>&- &
wait "$!" || fail "could not fetch upstream branch"
upstream=$(g rev-parse --verify "$upstream_ref^{commit}") || fail "could not resolve upstream tip"
[[ $upstream =~ $sha ]] || fail "invalid upstream SHA"
base=$(g merge-base "$head" "$upstream") || fail "no merge base with upstream"
[[ $base =~ $sha ]] || fail "invalid merge base SHA"
behind=$(g rev-list --count "$head..$upstream") || fail "could not count upstream commits"

hot=(packages/board/src/{conformance/index.ts,cli/main.ts,server/tasks.ts,cli/commands.ts,api/routes.ts,server/serve.ts})
counts=(0 0 0 0 0 0)
added_src=0
added_hot=0
number='^(0|[1-9][0-9]*)$'
# Override configured copy detection with rename-only mode. Git has no
# --find-copies=no option; -M enables renames without enabling copies.
g -c diff.renames=true -c diff.renameLimit=0 diff -M -l0 --numstat -z "$base" "$head" -- packages/board/src \
  >"$tmp/numstat" 2>"$tmp/diff.stderr" || fail "could not diff board sources"
if grep -qiE 'rename detection was skipped|skipping .*rename detection' "$tmp/diff.stderr"; then
  fail "git skipped exhaustive rename detection"
fi
# In -z output a rename has an empty path field, then two NUL-terminated
# paths. Attribute its added lines to the destination, not the old name.
while IFS= read -r -d '' row; do
  [[ $row = *$'\t'*$'\t'* ]] || fail "invalid diff row"
  added=${row%%$'\t'*}
  rest=${row#*$'\t'}
  deleted=${rest%%$'\t'*}
  path=${rest#*$'\t'}
  [[ $added != - && $deleted != - ]] || fail "binary row in board source diff"
  [[ $added =~ $number && $deleted =~ $number ]] || fail "non-numeric diff count"
  if [[ -z $path ]]; then
    IFS= read -r -d '' old && IFS= read -r -d '' path || fail "invalid rename row"
  fi
  max=9223372036854775807
  if ((${#added} > ${#max})) || [[ ${#added} = ${#max} && $added > $max ]] || ((added > max - added_src)); then
    fail "line count overflow"
  fi
  added_src=$((added_src + added))
  for i in "${!hot[@]}"; do
    if [[ $path = "${hot[i]}" ]]; then
      counts[i]=$((counts[i] + added))
      added_hot=$((added_hot + added))
    fi
  done
done <"$tmp/numstat"

for n in "$added_src" "$added_hot" "${counts[@]}" "$behind"; do
  [[ $n =~ $number ]] || fail "invalid metric count"
done
rm -rf -- "$tmp" || fail "could not remove temporary directory"
trap - EXIT
printf '{"metric":"fork_thinness","value":%s,"unit":"lines added in packages/board/src vs merge base with the selected upstream branch","lines_added_src":%s,"lines_added_hot":%s,"hot_files":{"packages/board/src/conformance/index.ts":%s,"packages/board/src/cli/main.ts":%s,"packages/board/src/server/tasks.ts":%s,"packages/board/src/cli/commands.ts":%s,"packages/board/src/api/routes.ts":%s,"packages/board/src/server/serve.ts":%s},"commits_behind_upstream":%s,"head":"%s","merge_base":"%s","upstream":"%s"}\n' \
  "$added_src" "$added_src" "$added_hot" "${counts[@]}" "$behind" "$head" "$base" "$upstream"
