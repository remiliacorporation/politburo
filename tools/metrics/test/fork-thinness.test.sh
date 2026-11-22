#!/usr/bin/env bash
set -euo pipefail

judge=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/fork-thinness.sh
tmp=$(mktemp -d /tmp/fork-thinness-test.XXXXXXXX)
trap 'rm -rf -- "$tmp"' EXIT
unset "${!GIT_@}"
export HOME="$tmp" XDG_CONFIG_HOME="$tmp" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=Fixture GIT_COMMITTER_NAME=Fixture
export GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_EMAIL=fixture@example.invalid

up=$tmp/upstream
fork=$tmp/fork
src=packages/board/src
git init -q --template= --object-format=sha1 -b main "$up"
mkdir -p "$up/$src/cli" "$tmp/not-git"
printf 'keep\nremove\n' > "$up/$src/cli/main.ts"
printf 'renamed without edits\n' > "$up/$src/legacy.ts"
git -C "$up" add .
git -C "$up" commit -qm base
base=$(git -C "$up" rev-parse HEAD)
git clone -q --no-local "$up" "$fork"

git -C "$up" commit -q --allow-empty -m upstream-only
git -C "$up" commit -q --allow-empty -m upstream-followup
upstream=$(git -C "$up" rev-parse HEAD)
printf 'keep\nnew1\nnew2\n' > "$fork/$src/cli/main.ts"
mkdir -p "$fork/$src/server"
mv -- "$fork/$src/legacy.ts" "$fork/$src/server/tasks.ts"
printf 'one\ntwo\nthree\n' > "$fork/$src/"$'odd\tname\n.ts'
printf '\000binary\n' > "$fork/$src/binary"
printf 'outside board source\n' > "$fork/outside"
git -C "$fork" add .
git -C "$fork" commit -qm fork-only
head=$(git -C "$fork" rev-parse HEAD)
printf 'dirty worktree only\n' >> "$fork/$src/cli/main.ts"

fail() { printf 'fork-thinness test: %s\n' "$1" >&2; exit 1; }
expect_success() {
  FORK_THINNESS_UPSTREAM=$1 "$judge" "$fork" > "$tmp/out" 2> "$tmp/err" || fail 'judge failed on fixture'
  if ! cmp -s "$tmp/expected" "$tmp/out" || [[ -s $tmp/err ]]; then
    fail 'unexpected JSON or stderr'
  fi
}
expect_failure() {
  if FORK_THINNESS_UPSTREAM=$1 "$judge" "$2" > "$tmp/out" 2> "$tmp/err"; then
    fail "judge accepted: $3"
  fi
  if [[ -s $tmp/out ]] || ! grep -Fq -- "$3" "$tmp/err"; then
    fail "wrong output for: $3"
  fi
}

printf '%s\n' '{"metric":"fork-thinness","added_lines_board_src":5,"added_lines_hot_files":2,"hot_files":{"packages/board/src/conformance/index.ts":0,"packages/board/src/cli/main.ts":2,"packages/board/src/server/tasks.ts":0,"packages/board/src/cli/commands.ts":0,"packages/board/src/api/routes.ts":0,"packages/board/src/server/serve.ts":0},"commits_behind_upstream":2,"commits_ahead_upstream":1,"merge_base":"'"$base"'","head":"'"$head"'","upstream":"'"$upstream"'"}' > "$tmp/expected"
expect_success "$up"
expect_failure "$up" "$tmp/not-git" 'not a git repository'
expect_failure "$tmp/missing" "$fork" 'cannot fetch upstream main'
git clone -q --depth=1 --no-local "$up" "$tmp/shallow"
expect_failure "$tmp/shallow" "$fork" 'fetched upstream repository is shallow'
expect_failure "$up" "$tmp/shallow" 'input repository is shallow'
git -C "$fork" fetch -q "$up" refs/heads/main:refs/remotes/upstream/main
expect_success "$tmp/missing"

expect_no_score() {
  local reason=$1
  shift
  local status=0
  "$@" > "$tmp/out" 2> "$tmp/err" || status=$?
  [[ $status == 1 && ! -s $tmp/out ]] || fail "expected exit 1 and no score for: $reason"
  printf 'fork-thinness: %s\n' "$reason" > "$tmp/expected-err"
  cmp -s "$tmp/expected-err" "$tmp/err" || fail "expected one diagnostic for: $reason"
}

# SWORD1's repro: an unchanged blob is absent in the partial clone, and a
# synthetic gitlink under src is not a third source line.
case_up="$tmp/up space"
case_fork="$tmp/fork space"
git init -q --template= --object-format=sha1 -b main "$case_up"
mkdir -p "$case_up/$src"
printf 'unchanged\n' > "$case_up/$src/unchanged"
git -C "$case_up" add .
git -C "$case_up" commit -qm base
case_base=$(git -C "$case_up" rev-parse HEAD)
blob=$(git -C "$case_up" rev-parse "HEAD:$src/unchanged")
git clone -q --no-local "$case_up" "$case_fork"
printf 'first\nsecond\n' > "$case_fork/$src/new"
printf '\000binary\n' > "$case_fork/$src/binary"
git -C "$case_fork" add .
git -C "$case_fork" commit -qm source

expect_two_lines() {
  FORK_THINNESS_UPSTREAM=$case_up "$judge" "$case_fork" > "$tmp/out" 2> "$tmp/err" || fail 'source fixture failed'
  if [[ -s $tmp/err ]] || ! grep -Fq '"added_lines_board_src":2,' "$tmp/out"; then
    fail "$1: expected two source lines"
  fi
}
expect_two_lines 'with binary'
git -C "$case_fork" update-index --add --cacheinfo "160000,$case_base,$src/link"
git -C "$case_fork" commit -qm gitlink
expect_two_lines 'with gitlink'

# Git's ignore-submodules option alone does not cover type changes.
git -C "$case_fork" update-index --cacheinfo "160000,$case_base,$src/unchanged"
git -C "$case_fork" commit -qm gitlink-type-change
FORK_THINNESS_UPSTREAM=$case_up expect_no_score 'gitlink type change in board source' "$judge" "$case_fork"

git -C "$case_up" config uploadpack.allowFilter true
partial=$tmp/partial
git clone -q --no-checkout --filter=blob:none "file://$case_up" "$partial"
git -C "$partial" update-ref refs/remotes/upstream/main "$case_base"
if GIT_NO_LAZY_FETCH=1 GIT_ALLOW_PROTOCOL= git -C "$partial" cat-file -e "$blob" 2>/dev/null; then
  fail 'partial clone fixture unexpectedly has the blob'
fi
FORK_THINNESS_UPSTREAM=$case_up expect_no_score 'input repository is partial or promisor' "$judge" "$partial"

# No partial-clone config here. A missing unchanged blob at the merge base
# must still be caught even when the scored diff is empty.
git -C "$case_up" update-ref refs/remotes/upstream/main "$case_base"
rm -- "$case_up/.git/objects/${blob:0:2}/${blob:2}"
expect_no_score 'incomplete object history' "$judge" "$case_up"

# An absolute include outside the input repo can block even the first Git
# probe. The outer watchdog is only a backstop, not an accepted exit.
mkfifo "$tmp/outer-config"
git -C "$case_fork" config include.path "$tmp/outer-config"
FORK_THINNESS_UPSTREAM=$case_up FORK_THINNESS_TIMEOUT_SECONDS=1 \
  expect_no_score 'git command timed out' timeout -k 2s 6s "$judge" "$case_fork"

printf 'fork-thinness offline tests passed\n'
